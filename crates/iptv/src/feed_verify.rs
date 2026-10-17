//! Feed checks (iptvFeedVerify.ts): learn which channel a live stream really
//! carries by comparing its picture with other streams' (see `fingerprint`),
//! then correct the guide and the viewer's tune.
//!
//! On tune ([`check_live_session`]): once a viewer's remux session is 10 s old,
//! capture ~15 s of one candidate stream through a spare upstream slot and
//! compare it with the session's own segments, so a comparison costs ONE extra
//! provider connection. Candidates (`feed_checks::feed_check_candidates`):
//! another stream of the listed channel, then related channels, then a second
//! listed-channel stream. The first clear match decides which guide id the
//! stream carries. A stream carrying another channel is recorded 'mislabeled'
//! (the guide then lists that channel's programmes on it) and, when the viewer
//! picked it for its listing, the caller redirects them to a stream of it.
//!
//! Standalone ([`check_feed_standalone`], the idle sweep): no viewer session,
//! so subject and candidate are captured side by side (two slots).
//!
//! A stream with no other stream of its listing can never be confirmed or
//! caught (a related-channel match alone is symmetric), so it is recorded
//! inconclusive without opening any connection.
//!
//! Captures never outrank a viewer: they take only a free slot
//! (`Remux::capture_aux`), and any viewer or recording that needs it kills
//! them (`Remux::preempt_aux`). A preempted check records nothing, so a later
//! tune or sweep tries again.

use std::collections::VecDeque;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sqlx::SqlitePool;

use crate::catalog::LISTED_EPG;
use crate::feed_checks::{
    Candidate, CandidateOpts, FeedCheck, NO_SIBLING_REASON, Role, effective_epg_id,
    feed_check_candidates, feed_check_is_fresh, get_feed_check, known_carried_epg_id,
    listed_epg_id, listings_differ, record_feed_check, same_schedule_epg_ids,
};
use crate::fingerprint::{
    MIN_OVERLAP_FRAMES, Match, compare, live_capture_args, segment_capture_args,
};
use crate::remux::{Capture, CaptureTask, Remux};
use crate::streams::{DeadFeeds, UPSTREAM_USER_AGENT, encode_uri_component};
use crate::xtream::Creds;

/// Fingerprint correlation at or above this: the same picture.
pub const MATCH_SCORE: f64 = 0.85;
/// Below this: a different picture. Between the two: can't tell, stop.
pub const NO_MATCH_SCORE: f64 = 0.6;

/// On tune the session's own footage spans the whole capture, so 15 s aligns
/// fully. Side-by-side captures of two sources start at different provider
/// burst depths (measured up to ~20 s apart), so they run 40 s.
const SESSION_CAPTURE_SECS: u32 = 15;
const STANDALONE_CAPTURE_SECS: u32 = 40;
/// Session footage older than the capture start that may line up with it.
/// Stays inside the remux's ~80 s segment window.
const SESSION_LEAD_MS: i64 = 30_000;
/// Session age before a check dials its candidate: flicking past a channel
/// never opens a second provider connection (churn the abuse block counts).
const SESSION_WARMUP_MS: i64 = 10_000;
/// Wait after a capture for the session to finish the segment covering it.
const FLUSH_MS: u64 = 2_500;
const SESSION_GAP_MS: u64 = 1_000;
const STANDALONE_GAP_MS: u64 = 3_000;
/// The on-tune scheduler remembers this many checked sessions.
const STARTED_MEMORY: usize = 500;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// "Is this check still wanted?" (the sweep's idle test reads the DB).
pub type Wanted<'a> = dyn Fn() -> BoxFuture<'a, bool> + Send + Sync + 'a;

/// A synchronous "still wanted?" as a [`Wanted`].
fn sync_wanted<'a>(
    f: &'a (dyn Fn() -> bool + Send + Sync),
) -> impl Fn() -> BoxFuture<'a, bool> + Send + Sync + 'a {
    move || Box::pin(std::future::ready(f()))
}

/// What a check needs from the world; tests fake it.
pub trait FeedIo: Send + Sync {
    /// Capture `seconds` of a stream through a free upstream slot; None when
    /// no slot is free.
    fn capture_upstream(&self, stream_id: i64, seconds: u32) -> Option<CaptureTask>;
    /// Capture a session's segment files (no provider connection).
    fn capture_segments(&self, files: &[String]) -> CaptureTask;
    fn is_dead(&self, stream_id: i64) -> bool;
    fn now_ms(&self) -> i64;
    fn sleep(&self, ms: u64) -> impl Future<Output = ()> + Send;
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Carries {
        epg_id: String,
        matched_stream_id: Option<i64>,
        score: Option<f64>,
        cached: bool,
    },
    Unknown {
        reason: String,
        score: Option<f64>,
    },
    Aborted {
        reason: String,
    },
}

fn unknown(reason: &str, score: Option<f64>) -> Outcome {
    Outcome::Unknown {
        reason: reason.into(),
        score,
    }
}

fn aborted(reason: &str) -> Outcome {
    Outcome::Aborted {
        reason: reason.into(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CompareVerdict {
    Same,
    Different,
    Unsure,
}

/// A fingerprint comparison as a verdict. No alignment at all is unsure.
pub fn classify(m: Option<&Match>) -> CompareVerdict {
    match m {
        Some(m) if m.score >= MATCH_SCORE => CompareVerdict::Same,
        Some(m) if m.score < NO_MATCH_SCORE => CompareVerdict::Different,
        _ => CompareVerdict::Unsure,
    }
}

/// The session's segments written since `from_ms`, in playback order.
fn session_segments(dir: &std::path::Path, from_ms: i64) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| crate::remux_map::is_seg_file(n))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|n| dir.join(n))
        .filter(|f| {
            // A segment can roll off the window between readdir and stat.
            std::fs::metadata(f)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .is_some_and(|d| d.as_millis() as i64 >= from_ms)
        })
        .map(|f| f.to_string_lossy().into_owned())
        .collect()
}

/// Record what a check learned about `stream_id`. Aborted checks record
/// nothing. Carrying an id whose schedule is the listing's own (travel.us and
/// travelchannel.us, 2026-10-14) is a match: calling it mislabeled changes
/// nothing on the guide but sends the stream's corrections down a wrong path.
async fn record_outcome(
    pool: &SqlitePool,
    stream_id: i64,
    listed: Option<&str>,
    outcome: &Outcome,
    at: i64,
) -> Result<(), sqlx::Error> {
    match outcome {
        Outcome::Carries { cached: true, .. } | Outcome::Aborted { .. } => Ok(()),
        Outcome::Carries {
            epg_id,
            matched_stream_id,
            score,
            ..
        } => {
            let matches = Some(epg_id.as_str()) == listed
                || match listed {
                    Some(l) => same_schedule_epg_ids(pool, l, epg_id, at).await?,
                    None => false,
                };
            let c = if matches {
                FeedCheck::new(stream_id, "match", listed, None, *matched_stream_id, *score)
            } else {
                FeedCheck::new(
                    stream_id,
                    "mislabeled",
                    listed,
                    Some(epg_id),
                    *matched_stream_id,
                    *score,
                )
            };
            record_feed_check(pool, &c, at).await
        }
        Outcome::Unknown { reason, score } => {
            // Nothing to compare is no evidence against a mislabel: the carried
            // channel's streams may be name-resolved or gone. Keep the verdict
            // and restamp it, so the sweep moves on instead of clearing the
            // correction or picking this stream again.
            if let Some(mut prior) = get_feed_check(pool, stream_id).await?
                && reason == NO_SIBLING_REASON
                && prior.verdict == "mislabeled"
                && prior.listed_epg_id.as_deref() == listed
            {
                prior.reason = Some(reason.clone());
                return record_feed_check(pool, &prior, at).await;
            }
            let mut c = FeedCheck::new(stream_id, "inconclusive", listed, None, None, *score);
            c.reason = Some(reason.clone());
            record_feed_check(pool, &c, at).await
        }
    }
}

/// The matched candidate carries the subject's picture and its own listing
/// says so: confirm it too (a sweep check of it would repeat this comparison).
/// Only the provider's own tag vouches for that listing: a name-resolved id
/// can be wrong for both streams (2026-10-11). Leaves a fresh verdict alone.
async fn record_corroboration(
    pool: &SqlitePool,
    outcome: &Outcome,
    subject: i64,
    now: i64,
) -> Result<(), sqlx::Error> {
    let Outcome::Carries {
        epg_id,
        matched_stream_id: Some(candidate),
        score,
        cached: false,
    } = outcome
    else {
        return Ok(());
    };
    let sql = format!("SELECT epg_channel_id, {LISTED_EPG} FROM channels WHERE stream_id = ?");
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(candidate)
        .fetch_optional(pool)
        .await?;
    let Some((tvg, listed)) = row else {
        return Ok(());
    };
    if listed.as_ref() != Some(epg_id) || tvg.as_ref() != Some(epg_id) {
        return Ok(());
    }
    if let Some(prior) = get_feed_check(pool, *candidate).await?
        && feed_check_is_fresh(&prior, Some(epg_id), now)
    {
        return Ok(());
    }
    let c = FeedCheck::new(
        *candidate,
        "match",
        Some(epg_id),
        None,
        Some(subject),
        *score,
    );
    record_feed_check(pool, &c, now).await
}

/// One comparison's footage, or why there is none.
enum Footage {
    Frames {
        subject: Vec<u8>,
        candidate: Vec<u8>,
    },
    /// End the check without a verdict (preempted, no slot, session gone).
    Abort(&'static str),
    /// Drop just this candidate (its own capture failed).
    Skip(&'static str),
    /// The subject itself could not be captured.
    SubjectFailed(&'static str),
}

/// Where a check's subject footage comes from.
enum Mode<'a> {
    /// A viewer's remux session: its own segments.
    Session(&'a LiveSessionRef, &'a (dyn Fn() -> bool + Send + Sync)),
    /// No viewer: the subject is captured beside each candidate.
    Standalone,
}

async fn footage<I: FeedIo>(
    io: &I,
    subject: i64,
    mode: &Mode<'_>,
    candidate: &Candidate,
) -> Footage {
    match mode {
        Mode::Session(r, is_active) => {
            let started = io.now_ms();
            let Some(task) = io.capture_upstream(candidate.stream_id, SESSION_CAPTURE_SECS) else {
                return Footage::Abort("no free upstream slot");
            };
            let cand = task.frames().await;
            if cand.killed {
                return Footage::Abort("candidate capture preempted");
            }
            if !cand.ok {
                return Footage::Skip("candidate capture failed");
            }
            io.sleep(FLUSH_MS).await;
            if !is_active() {
                return Footage::Abort("session ended");
            }
            let files = session_segments(&r.dir, started - SESSION_LEAD_MS);
            if files.is_empty() {
                return Footage::Abort("no session footage");
            }
            let subj = io.capture_segments(&files).frames().await;
            if !subj.ok {
                return Footage::Abort("session footage unreadable");
            }
            Footage::Frames {
                subject: subj.frames,
                candidate: cand.frames,
            }
        }
        Mode::Standalone => {
            let Some(subj) = io.capture_upstream(subject, STANDALONE_CAPTURE_SECS) else {
                return Footage::Abort("no free upstream slot");
            };
            let Some(cand) = io.capture_upstream(candidate.stream_id, STANDALONE_CAPTURE_SECS)
            else {
                subj.kill();
                return Footage::Abort("no second free upstream slot");
            };
            let (subj, cand): (Capture, Capture) = tokio::join!(subj.frames(), cand.frames());
            if subj.killed || cand.killed {
                return Footage::Abort("capture preempted");
            }
            if !subj.ok {
                return Footage::SubjectFailed("subject capture failed");
            }
            if !cand.ok {
                return Footage::Skip("candidate capture failed");
            }
            Footage::Frames {
                subject: subj.frames,
                candidate: cand.frames,
            }
        }
    }
}

/// Walk the candidates until one clearly matches the subject's picture.
#[allow(clippy::too_many_arguments)]
async fn compare_against<I: FeedIo>(
    io: &I,
    pool: &SqlitePool,
    subject: i64,
    intended: &str,
    candidates: &[Candidate],
    mode: &Mode<'_>,
    still_wanted: &Wanted<'_>,
    gap_ms: u64,
) -> Result<Outcome, sqlx::Error> {
    let mut best: Option<f64> = None;
    // A related channel's match alone is symmetric: the subject may carry that
    // channel, or that stream may carry the subject's. Only a stream of the
    // subject's own listing that clearly differs breaks the tie.
    let mut sibling_differed = false;
    let mut queue: VecDeque<Candidate> = candidates.iter().cloned().collect();
    let mut first = true;
    while let Some(candidate) = queue.pop_front() {
        if !first {
            io.sleep(gap_ms).await;
        }
        first = false;
        if !still_wanted().await {
            return Ok(aborted("no longer wanted"));
        }
        let captured_at = io.now_ms();
        let (subj, cand) = match footage(io, subject, mode, &candidate).await {
            Footage::Frames { subject, candidate } => (subject, candidate),
            Footage::Abort(r) => return Ok(aborted(r)),
            Footage::SubjectFailed(r) => return Ok(unknown(r, best)),
            Footage::Skip(r) => {
                tracing::info!(
                    subject,
                    candidate = candidate.stream_id,
                    reason = r,
                    "feed compare skipped"
                );
                // A listed-channel stream is what makes any match decisive:
                // try the next one before the related channels.
                if candidate.role == Role::Sibling
                    && let Some(next) = queue
                        .iter()
                        .position(|c| c.role == Role::Sibling)
                        .filter(|&i| i > 0)
                {
                    let c = queue.remove(next).expect("index in range");
                    queue.push_front(c);
                }
                continue;
            }
        };
        // ~50 M multiply-adds for two 40 s captures: off the async workers.
        let m = tokio::task::spawn_blocking(move || compare(&subj, &cand, MIN_OVERLAP_FRAMES))
            .await
            .unwrap_or(None);
        let verdict = classify(m.as_ref());
        tracing::info!(
            subject,
            candidate = candidate.stream_id,
            candidate_epg = candidate.epg_id,
            role = ?candidate.role,
            verdict = ?verdict,
            score = m.map(|m| (m.score * 1000.0).round() / 1000.0),
            offset_frames = m.map(|m| m.offset),
            overlap_frames = m.map_or(0, |m| m.overlap),
            "feed compare"
        );
        if let Some(m) = m {
            best = Some(best.unwrap_or(-1.0).max(m.score));
        }
        match verdict {
            CompareVerdict::Same => {
                if candidate.role == Role::Family && !sibling_differed {
                    return Ok(unknown(
                        "matches a related channel with no listed stream to compare",
                        best,
                    ));
                }
                if candidate.role == Role::Family
                    && !listings_differ(pool, intended, &candidate.epg_id, captured_at).await?
                {
                    return Ok(unknown(
                        "matches a related channel listing the same programme (simulcast)",
                        best,
                    ));
                }
                return Ok(Outcome::Carries {
                    epg_id: candidate.epg_id,
                    matched_stream_id: Some(candidate.stream_id),
                    score: m.map(|m| m.score),
                    cached: false,
                });
            }
            CompareVerdict::Unsure => return Ok(unknown("picture inconclusive", best)),
            CompareVerdict::Different if candidate.role == Role::Sibling => sibling_differed = true,
            CompareVerdict::Different => {}
        }
    }
    let reason = if candidates.is_empty() {
        "no candidate streams"
    } else {
        "no candidate matched"
    };
    Ok(unknown(reason, best))
}

#[derive(Clone, Debug)]
pub struct LiveSessionRef {
    /// The channel the viewer tuned.
    pub tuned: i64,
    /// The stream actually dialed (differs after a failover or redirect).
    pub dialed: i64,
    pub session_id: String,
    pub dir: PathBuf,
    pub started_at_ms: i64,
}

#[derive(Debug, PartialEq)]
pub struct LiveCheck {
    pub outcome: Outcome,
    /// The guide id the viewer picked when they tuned.
    pub intended_epg: Option<String>,
    /// A stream of the intended channel to switch the viewer to, when the
    /// dialed stream proved to carry something else.
    pub switch_to: Option<i64>,
}

/// Check the stream behind a live viewer's session (see the module doc).
pub async fn check_live_session<I: FeedIo>(
    io: &I,
    pool: &SqlitePool,
    r: &LiveSessionRef,
    is_active: &(dyn Fn() -> bool + Send + Sync),
) -> Result<LiveCheck, sqlx::Error> {
    let Some(intended) = effective_epg_id(pool, r.tuned).await? else {
        return Ok(LiveCheck {
            outcome: unknown("no guide id", None),
            intended_epg: None,
            switch_to: None,
        });
    };
    let subject = r.dialed;
    let listed = listed_epg_id(pool, subject).await?;
    // After a dead-feed failover the dialed stream can be a name sibling filed
    // under another guide id (2026-10-14: tuned travelchannel.us, dialed
    // travel.us). Comparing it with streams of the TUNED listing tells whether
    // the viewer got what they picked, but nothing about the dialed stream's
    // own listing, so such a check records no verdict.
    let own_listing = effective_epg_id(pool, subject).await?.as_deref() == Some(intended.as_str());
    let record = async |outcome: &Outcome| -> Result<(), sqlx::Error> {
        if own_listing {
            record_outcome(pool, subject, listed.as_deref(), outcome, io.now_ms()).await?;
            record_corroboration(pool, outcome, subject, io.now_ms()).await?;
        }
        Ok(())
    };
    let is_dead = |id| io.is_dead(id);
    let opts = CandidateOpts {
        is_dead: &is_dead,
        exclude: &[r.tuned],
        max_family: 4,
        now_ms: io.now_ms(),
    };
    let list = feed_check_candidates(pool, subject, &intended, &opts).await?;
    let switch_target = |o: &Outcome| match o {
        Outcome::Carries { epg_id, .. } if *epg_id != intended => list
            .iter()
            .find(|c| c.role == Role::Sibling)
            .map(|c| c.stream_id),
        _ => None,
    };

    if let Some(prior) = get_feed_check(pool, subject).await?
        && feed_check_is_fresh(&prior, listed.as_deref(), io.now_ms())
    {
        let outcome = match known_carried_epg_id(Some(&prior), listed.as_deref()) {
            Some(epg_id) => Outcome::Carries {
                epg_id,
                matched_stream_id: prior.matched_stream_id,
                score: prior.score,
                cached: true,
            },
            None => unknown("recently inconclusive", prior.score),
        };
        let switch_to = switch_target(&outcome);
        return Ok(LiveCheck {
            outcome,
            intended_epg: Some(intended.clone()),
            switch_to,
        });
    }
    if !list.iter().any(|c| c.role == Role::Sibling) {
        let outcome = unknown(NO_SIBLING_REASON, None);
        record(&outcome).await?;
        return Ok(LiveCheck {
            outcome,
            intended_epg: Some(intended.clone()),
            switch_to: None,
        });
    }

    while io.now_ms() - r.started_at_ms < SESSION_WARMUP_MS {
        if !is_active() {
            return Ok(LiveCheck {
                outcome: aborted("session ended"),
                intended_epg: Some(intended.clone()),
                switch_to: None,
            });
        }
        io.sleep(1_000).await;
    }

    let wanted = sync_wanted(is_active);
    let mode = Mode::Session(r, is_active);
    let outcome = compare_against(
        io,
        pool,
        subject,
        &intended,
        &list,
        &mode,
        &wanted,
        SESSION_GAP_MS,
    )
    .await?;
    record(&outcome).await?;
    let switch_to = switch_target(&outcome);
    tracing::info!(subject, tuned = r.tuned, listed, intended_epg = intended, outcome = ?outcome, switch_to, "feed check");
    Ok(LiveCheck {
        outcome,
        intended_epg: Some(intended.clone()),
        switch_to,
    })
}

/// Check a stream with no viewer: subject and candidate captured side by side.
pub async fn check_feed_standalone<I: FeedIo>(
    io: &I,
    pool: &SqlitePool,
    stream_id: i64,
    still_wanted: &Wanted<'_>,
) -> Result<Outcome, sqlx::Error> {
    let Some(intended) = effective_epg_id(pool, stream_id).await? else {
        return Ok(unknown("no guide id", None));
    };
    let listed = listed_epg_id(pool, stream_id).await?;
    let is_dead = |id| io.is_dead(id);
    let opts = CandidateOpts {
        is_dead: &is_dead,
        exclude: &[],
        max_family: 4,
        now_ms: io.now_ms(),
    };
    let list = feed_check_candidates(pool, stream_id, &intended, &opts).await?;
    if !list.iter().any(|c| c.role == Role::Sibling) {
        let outcome = unknown(NO_SIBLING_REASON, None);
        record_outcome(pool, stream_id, listed.as_deref(), &outcome, io.now_ms()).await?;
        return Ok(outcome);
    }
    let outcome = compare_against(
        io,
        pool,
        stream_id,
        &intended,
        &list,
        &Mode::Standalone,
        still_wanted,
        STANDALONE_GAP_MS,
    )
    .await?;
    record_outcome(pool, stream_id, listed.as_deref(), &outcome, io.now_ms()).await?;
    record_corroboration(pool, &outcome, stream_id, io.now_ms()).await?;
    tracing::info!(subject = stream_id, listed, intended_epg = intended, outcome = ?outcome, "feed check (standalone)");
    Ok(outcome)
}

// ── Scheduling: one check at a time ─────────────────────────────────────────

/// One feed check runs at a time, on tune or in the sweep.
#[derive(Default)]
pub struct Scheduler {
    running: AtomicBool,
    /// Sessions already checked, oldest first.
    started: Mutex<VecDeque<String>>,
}

/// Clears `running` when the check ends, panics included.
struct Running<'a>(&'a AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Scheduler {
    /// Start a check for this live session unless one already ran for it.
    /// While another check runs this returns without marking the session, so
    /// the next manifest poll tries again. `on_wrong_feed` gets the stream to
    /// switch the viewer to.
    pub fn schedule_live<I: FeedIo + 'static>(
        self: &Arc<Self>,
        io: Arc<I>,
        pool: SqlitePool,
        r: LiveSessionRef,
        is_active: Arc<dyn Fn() -> bool + Send + Sync>,
        on_wrong_feed: impl FnOnce(i64) + Send + 'static,
    ) {
        {
            let mut started = self.started.lock().unwrap();
            if started.contains(&r.session_id) || self.running.swap(true, Ordering::SeqCst) {
                return;
            }
            started.push_back(r.session_id.clone());
            if started.len() > STARTED_MEMORY {
                started.pop_front();
            }
        }
        let me = self.clone();
        tokio::spawn(async move {
            let _running = Running(&me.running);
            match check_live_session(&*io, &pool, &r, &*is_active).await {
                Ok(c) => {
                    if let Some(to) = c.switch_to
                        && is_active()
                    {
                        let carries = match &c.outcome {
                            Outcome::Carries { epg_id, .. } => Some(epg_id.as_str()),
                            _ => None,
                        };
                        tracing::warn!(
                            tuned = r.tuned,
                            dialed = r.dialed,
                            intended_epg = c.intended_epg,
                            carries,
                            switch_to = to,
                            "stream carries a different channel than the one tuned; switching the viewer"
                        );
                        on_wrong_feed(to);
                    }
                }
                Err(e) => {
                    tracing::warn!(session_id = r.session_id, error = %e, "feed check failed")
                }
            }
        });
    }

    /// Run `task` as the one check in flight, or None when one already runs.
    pub async fn run_exclusive<T>(&self, task: impl Future<Output = T>) -> Option<T> {
        if self.running.swap(true, Ordering::SeqCst) {
            return None;
        }
        let _running = Running(&self.running);
        Some(task.await)
    }
}

/// Production io: real ffmpeg, the remux's aux slots, the clock.
pub struct LiveIo {
    remux: Remux,
    dead: Arc<DeadFeeds>,
    /// `<host>/live/<user>/<pass>`, percent-encoded.
    live_base: String,
}

impl LiveIo {
    pub fn new(remux: Remux, dead: Arc<DeadFeeds>, creds: &Creds) -> LiveIo {
        let live_base = format!(
            "{}/live/{}/{}",
            creds.host,
            encode_uri_component(&creds.username),
            encode_uri_component(&creds.password)
        );
        LiveIo {
            remux,
            dead,
            live_base,
        }
    }
}

impl FeedIo for LiveIo {
    fn capture_upstream(&self, stream_id: i64, seconds: u32) -> Option<CaptureTask> {
        // No egress proxy reads like a busy upstream.
        let proxy = self.remux.proxy_args()?;
        let url = format!("{}/{stream_id}.ts", self.live_base);
        self.remux.capture_aux(live_capture_args(
            &url,
            seconds,
            UPSTREAM_USER_AGENT,
            &proxy,
        ))
    }

    fn capture_segments(&self, files: &[String]) -> CaptureTask {
        self.remux.capture_local(segment_capture_args(files))
    }

    fn is_dead(&self, stream_id: i64) -> bool {
        self.dead.is_dead(&stream_id.to_string())
    }

    fn now_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    async fn sleep(&self, ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await
    }
}

#[cfg(test)]
pub(crate) mod tests;
