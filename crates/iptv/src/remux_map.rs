//! The live remux index (iptvLiveRemuxMap.ts): (tuned channel, viewer) -> the
//! remux session serving it, so manifest polls share one ffmpeg. Owns the
//! reconnect throttle, dead-feed sibling failover, feed-check redirects, the
//! client-facing media-sequence continuity across session swaps, and the
//! per-session stable segment URLs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use emerald_contracts::stream_token::StreamKind;
use tokio::time::Instant;

use crate::config::Config;
use crate::playlist;
use crate::remux::Remux;
use crate::streams::encode_uri_component;

/// A redirected viewer keeps the redirect this long (by then the guide lists
/// the stream's real programmes).
const REDIRECT_TTL: Duration = Duration::from_secs(4 * 3600);
const RECONNECT_BASE: Duration = Duration::from_secs(5);
const RECONNECT_MAX: Duration = Duration::from_secs(30);
/// A session that dies younger than this widens the reconnect backoff.
const FAST_FAIL: Duration = Duration::from_secs(20);

/// A live entry. `stream_id` is the channel the viewer tuned (constant across
/// a failover); `dialed_stream_id` is the feed actually dialed.
#[derive(Clone, Debug)]
pub struct Entry {
    pub session_id: String,
    pub dir: PathBuf,
    pub manifest_path: PathBuf,
    pub stream_id: String,
    pub dialed_stream_id: String,
    pub sub: String,
    pub started_at: Instant,
}

struct Indexed {
    entry: Entry,
    /// segFile -> the URL minted on its first appearance. A segment's URI must
    /// not change across reloads (RFC 8216 6.3.4) or AVPlayer fails -12312.
    seg_urls: HashMap<String, String>,
}

struct Redirect {
    stream_id: String,
    sub: String,
    feed: String,
    expires_at: Instant,
}

/// Client-facing media sequence for one (tuned channel, viewer).
#[derive(Debug)]
pub(crate) struct Continuity {
    /// The session `offset` was computed for; a change is a swap.
    session_id: String,
    offset: i64,
    discontinuity_seq: i64,
    /// Highest client-facing sequence served (-1 = none).
    last_served_max: i64,
}

#[derive(Default)]
struct State {
    index: HashMap<String, Indexed>,
    redirects: HashMap<String, Redirect>,
    last_connect: HashMap<String, Instant>,
    spawn_at: HashMap<String, Instant>,
    streak: HashMap<String, u32>,
    cont: HashMap<String, Continuity>,
}

/// What one ensure needs: the tuned channel, the ordered candidate feeds
/// (itself first; empty means only itself), and the URL of a feed.
pub struct EnsureOpts<'a> {
    pub stream_id: &'a str,
    pub sub: &'a str,
    pub feeds: &'a [String],
    pub url_for: &'a (dyn Fn(&str) -> String + Sync),
}

pub struct LiveMap {
    pub remux: Remux,
    secret: String,
    seg_ttl: i64,
    st: Mutex<State>,
}

fn key(stream_id: &str, sub: &str) -> String {
    format!("{stream_id}:{sub}")
}

/// Backoff before re-dialing a channel after `streak` consecutive fast
/// failures: 0, then 5, 10, 20 s, capped at 30 s.
pub fn reconnect_delay(streak: u32) -> Duration {
    if streak == 0 {
        return Duration::ZERO;
    }
    RECONNECT_BASE
        .saturating_mul(2u32.saturating_pow(streak - 1))
        .min(RECONNECT_MAX)
}

/// `^seg_\d{5}\.ts$`
pub(crate) fn is_seg_file(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 12
        && s.starts_with("seg_")
        && s.ends_with(".ts")
        && b[4..9].iter().all(u8::is_ascii_digit)
}

impl LiveMap {
    pub fn new(remux: Remux, config: &Config) -> Self {
        LiveMap {
            remux,
            secret: config.stream_token_secret.clone(),
            seg_ttl: config.iptv_stream_token_ttl_secs as i64,
            st: Mutex::default(),
        }
    }

    /// The live entry for (tuned channel, viewer), starting a remux when none
    /// exists or its ffmpeg exited. `Ok(None)` when the channel is in its
    /// reconnect cooldown, the cap deferred the dial, or every candidate feed
    /// is a known dead placeholder (see [`LiveMap::is_offline`]). The caller
    /// must not dial again on None.
    pub fn ensure(&self, o: &EnsureOpts, now: Instant) -> Result<Option<Entry>, String> {
        let k = key(o.stream_id, o.sub);
        let mut st = self.st.lock().unwrap();
        if let Some(ix) = st.index.get(&k)
            && !self.remux.is_active(&ix.entry.session_id)
        {
            if self.remux.is_dead(&ix.entry.dialed_stream_id) {
                // A dead placeholder, not a corrupt feed: the sibling is a
                // different connection, so no backoff and no dial gate.
                st.streak.remove(&k);
                st.last_connect.remove(&k);
            } else {
                let lived = st
                    .spawn_at
                    .get(&k)
                    .map_or(Duration::ZERO, |t| now.saturating_duration_since(*t));
                if lived < FAST_FAIL {
                    *st.streak.entry(k.clone()).or_default() += 1;
                } else {
                    st.streak.remove(&k);
                }
            }
            st.index.remove(&k);
            st.spawn_at.remove(&k);
        }
        if let Some(ix) = st.index.get(&k) {
            return Ok(Some(ix.entry.clone()));
        }
        let delay = reconnect_delay(st.streak.get(&k).copied().unwrap_or(0));
        if !delay.is_zero()
            && st
                .last_connect
                .get(&k)
                .is_some_and(|t| now.saturating_duration_since(*t) < delay)
        {
            return Ok(None);
        }
        let Some(dial) = self.pick_feed(&mut st, o, now) else {
            return Ok(None);
        };
        let Some(started) = self.remux.start(
            &dial,
            o.sub,
            &(o.url_for)(&dial),
            self.remux.needs_reencode(&dial),
        )?
        else {
            // The cap deferred the dial: nothing was dialed, nothing recorded.
            return Ok(None);
        };
        st.last_connect.insert(k.clone(), now);
        st.spawn_at.insert(k.clone(), now);
        let entry = Entry {
            session_id: started.session_id,
            dir: started.dir,
            manifest_path: started.manifest_path,
            stream_id: o.stream_id.into(),
            dialed_stream_id: dial,
            sub: o.sub.into(),
            started_at: now,
        };
        st.index.insert(
            k,
            Indexed {
                entry: entry.clone(),
                seg_urls: HashMap::new(),
            },
        );
        Ok(Some(entry))
    }

    /// The first candidate not remembered dead, a live redirect first.
    fn pick_feed(&self, st: &mut State, o: &EnsureOpts, now: Instant) -> Option<String> {
        let k = key(o.stream_id, o.sub);
        if st.redirects.get(&k).is_some_and(|r| now >= r.expires_at) {
            st.redirects.remove(&k);
        }
        let own = [o.stream_id.to_string()];
        let feeds = if o.feeds.is_empty() {
            &own[..]
        } else {
            o.feeds
        };
        let redirect = st.redirects.get(&k).map(|r| r.feed.as_str());
        redirect
            .into_iter()
            .chain(
                feeds
                    .iter()
                    .map(String::as_str)
                    .filter(|f| Some(*f) != redirect),
            )
            .find(|f| !self.remux.is_dead(f))
            .map(String::from)
    }

    /// True when every candidate is a known dead placeholder: the channel is
    /// off the air (terminal), not merely warming.
    pub fn is_offline(&self, candidates: &[String]) -> bool {
        !candidates.is_empty() && candidates.iter().all(|c| self.remux.is_dead(c))
    }

    /// The active entry; a stale (ffmpeg-exited) one is dropped.
    pub fn get_active(&self, stream_id: &str, sub: &str) -> Option<Entry> {
        let k = key(stream_id, sub);
        let mut st = self.st.lock().unwrap();
        let e = st.index.get(&k)?.entry.clone();
        if !self.remux.is_active(&e.session_id) {
            st.index.remove(&k);
            return None;
        }
        Some(e)
    }

    /// Drop the entry and stop its session.
    pub fn forget(&self, stream_id: &str, sub: &str, session_id: &str) {
        self.st.lock().unwrap().index.remove(&key(stream_id, sub));
        self.remux.stop(session_id, "forget");
    }

    /// A viewer has one live tuner: stop every other channel of `sub` now so
    /// its provider connection frees, and end redirects for other channels.
    /// Returns the tuned channels it stopped.
    pub fn drop_others(&self, sub: &str, keep: &str) -> Vec<String> {
        let mut st = self.st.lock().unwrap();
        st.redirects
            .retain(|_, r| !(r.sub == sub && r.stream_id != keep));
        let gone: Vec<String> = st
            .index
            .iter()
            .filter(|(_, ix)| ix.entry.sub == sub && ix.entry.stream_id != keep)
            .map(|(k, _)| k.clone())
            .collect();
        let mut stopped = Vec::new();
        for k in gone {
            if let Some(ix) = st.index.remove(&k) {
                self.remux.stop(&ix.entry.session_id, "drop-other");
                stopped.push(ix.entry.stream_id);
            }
        }
        stopped
    }

    /// A feed check proved the tuned stream carries another channel: send this
    /// viewer's tune to `feed` and stop `session_id` if it is still current,
    /// so the next poll dials `feed`.
    pub fn redirect(&self, stream_id: &str, sub: &str, feed: &str, session_id: &str, now: Instant) {
        let k = key(stream_id, sub);
        let mut st = self.st.lock().unwrap();
        st.redirects.insert(
            k.clone(),
            Redirect {
                stream_id: stream_id.into(),
                sub: sub.into(),
                feed: feed.into(),
                expires_at: now + REDIRECT_TTL,
            },
        );
        if st
            .index
            .get(&k)
            .is_some_and(|ix| ix.entry.session_id == session_id)
        {
            st.index.remove(&k);
            self.remux.stop(session_id, "feed-check-switch");
        }
    }

    /// The on-disk manifest rewritten for the client, with this entry's
    /// stable segment URLs.
    pub fn rewrite(&self, text: &str, stream_id: &str, session_id: &str, sub: &str) -> String {
        let mut guard = self.st.lock().unwrap();
        let st = &mut *guard;
        let cache = st
            .index
            .get_mut(&key(stream_id, sub))
            .filter(|ix| ix.entry.session_id == session_id)
            .map(|ix| &mut ix.seg_urls);
        let mut sign = |rid: &str| {
            playlist::sign(
                &self.secret,
                StreamKind::Remux,
                rid,
                sub,
                self.seg_ttl,
                None,
            )
        };
        rewrite_remux_manifest(
            text,
            stream_id,
            session_id,
            sub,
            &mut st.cont,
            cache,
            &mut sign,
        )
    }
}

/// Rewrite ffmpeg's playlist: segment lines become tokenised `/remux/seg`
/// URLs, the meaningless pre-first-segment discontinuity (AVPlayer freezes on
/// it) is dropped, and MEDIA-SEQUENCE stays monotonic across session swaps
/// with a DISCONTINUITY-SEQUENCE bump per swap. Steady state is unchanged.
pub(crate) fn rewrite_remux_manifest(
    text: &str,
    stream_id: &str,
    session_id: &str,
    sub: &str,
    conts: &mut HashMap<String, Continuity>,
    mut cache: Option<&mut HashMap<String, String>>,
    sign: &mut dyn FnMut(&str) -> String,
) -> String {
    let local_seq: i64 = text
        .lines()
        .find_map(|l| {
            let d = l.strip_prefix("#EXT-X-MEDIA-SEQUENCE:")?;
            let end = d.find(|c: char| !c.is_ascii_digit()).unwrap_or(d.len());
            d[..end].parse().ok()
        })
        .unwrap_or(0);
    let cont = conts
        .entry(key(stream_id, sub))
        .or_insert_with(|| Continuity {
            session_id: session_id.into(),
            offset: 0,
            discontinuity_seq: 0,
            last_served_max: -1,
        });
    if cont.session_id != session_id {
        // A swap: continue just past the highest sequence already served.
        cont.offset = (cont.last_served_max + 1 - local_seq).max(0);
        cont.discontinuity_seq += 1;
        cont.session_id = session_id.into();
    }
    let first = local_seq + cont.offset;
    let disc = cont.discontinuity_seq;

    let mut seen_segment = false;
    let mut seq_emitted = false;
    let mut seg_count = 0i64;
    let mut out: Vec<String> = Vec::new();
    let mut present = Vec::new();
    let mut emit_seq = |out: &mut Vec<String>| {
        if !seq_emitted {
            out.push(format!("#EXT-X-MEDIA-SEQUENCE:{first}"));
            if disc > 0 {
                out.push(format!("#EXT-X-DISCONTINUITY-SEQUENCE:{disc}"));
            }
            seq_emitted = true;
        }
    };
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if !seen_segment && line.trim() == "#EXT-X-DISCONTINUITY" {
            continue;
        }
        if line.starts_with("#EXT-X-MEDIA-SEQUENCE:") {
            emit_seq(&mut out);
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            out.push(line.into());
            continue;
        }
        let seg = line
            .trim()
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        if !is_seg_file(seg) {
            out.push(line.into());
            continue;
        }
        if !seen_segment && (first > 0 || disc > 0) {
            emit_seq(&mut out);
        }
        seen_segment = true;
        seg_count += 1;
        present.push(seg.to_string());
        let cached = cache.as_ref().and_then(|c| c.get(seg).cloned());
        let url = cached.unwrap_or_else(|| {
            let token = sign(&format!("{session_id}/{seg}"));
            let url = format!(
                "/api/iptv/stream/live/{stream_id}/remux/seg?t={}",
                encode_uri_component(&token)
            );
            if let Some(c) = cache.as_mut() {
                c.insert(seg.to_string(), url.clone());
            }
            url
        });
        out.push(url);
    }
    // Keep the cache to the live window.
    if let Some(c) = cache {
        c.retain(|k, _| present.contains(k));
    }
    if seg_count > 0 {
        cont.last_served_max = cont.last_served_max.max(first + seg_count - 1);
    }
    out.join("\n")
}

/// True once the manifest lists at least `min` segments: a one-segment
/// playlist makes a live player error on its first load.
pub fn manifest_ready(path: &std::path::Path, min: usize) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    text.lines()
        .filter(|l| is_seg_file(l.trim()))
        .nth(min.saturating_sub(1))
        .is_some()
}

/// `<sessionId>/<segFile>` from a remux segment token; None on any other
/// shape, so nothing reaches past the session dir.
pub fn segment_resource(rid: &str) -> Option<(&str, &str)> {
    let slash = rid.rfind('/')?;
    let (session, seg) = (&rid[..slash], &rid[slash + 1..]);
    (slash > 0 && is_seg_file(seg)).then_some((session, seg))
}

#[cfg(test)]
mod tests;
