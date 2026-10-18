//! The per-user JSON stores (userFeedback, rejections, userWatchlist,
//! userPolicies) and the BYO Anthropic key rows in server.db.
//!
//! [`JsonStore`] is the one store: the file is read once into an in-memory
//! cache; every mutation runs under a single async mutex, builds the next
//! snapshot, persists it (temp file + rename, pretty-printed, trailing
//! newline) and only then swaps the cache, so a failed write leaves no
//! ghost entry for a later write to adopt. A missing file is an empty store;
//! a file that does not parse fails closed (every call errors) instead of
//! being overwritten with empty state. Reads go through the same mutex, so a
//! cold load can never race a write's rename.
//!
//! Loading normalizes defensively (hand-edited or legacy files): titles are
//! sanitized on read too, since they later reach an LLM prompt.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::config::Config;

/// Every store call fails with this; a route answers the generic 500.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct StoreError(String);

impl IntoResponse for StoreError {
    fn into_response(self) -> Response {
        tracing::error!(event = "store", error = %self.0, "store error");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal" })),
        )
            .into_response()
    }
}

type Raw = IndexMap<String, Value>;

pub struct JsonStore<T> {
    path: PathBuf,
    label: &'static str,
    parse: fn(Raw) -> T,
    cell: Mutex<Option<Arc<T>>>,
    /// Test hook: consulted before each persist; true fails that write.
    #[cfg(test)]
    #[allow(clippy::type_complexity)]
    pub(crate) fail: std::sync::Mutex<Option<Box<dyn FnMut() -> bool + Send>>>,
}

impl<T: Serialize> JsonStore<T> {
    pub fn new(path: impl Into<PathBuf>, label: &'static str, parse: fn(Raw) -> T) -> Self {
        JsonStore {
            path: path.into(),
            label,
            parse,
            cell: Mutex::new(None),
            #[cfg(test)]
            fail: std::sync::Mutex::new(None),
        }
    }

    /// The current snapshot (loaded on first use).
    pub async fn get(&self) -> Result<Arc<T>, StoreError> {
        let mut cell = self.cell.lock().await;
        self.loaded(&mut cell).await
    }

    /// Build the next snapshot from the current one and persist it; `None`
    /// from `f` is a no-op (no write, no swap).
    pub async fn update(&self, f: impl FnOnce(&T) -> Option<T>) -> Result<(), StoreError> {
        let mut cell = self.cell.lock().await;
        let current = self.loaded(&mut cell).await?;
        let Some(next) = f(&current) else {
            return Ok(());
        };
        self.persist(&next).await.inspect_err(|e| {
            tracing::error!(event = self.label, error = %e, "write failed");
        })?;
        *cell = Some(Arc::new(next));
        Ok(())
    }

    async fn loaded(&self, cell: &mut Option<Arc<T>>) -> Result<Arc<T>, StoreError> {
        if let Some(v) = cell {
            return Ok(v.clone());
        }
        let v = Arc::new(self.read().await?);
        *cell = Some(v.clone());
        Ok(v)
    }

    async fn read(&self) -> Result<T, StoreError> {
        let path = self.path.display();
        let bytes = match tokio::fs::read(&self.path).await {
            Ok(b) => b,
            // Legit first run.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok((self.parse)(Raw::new()));
            }
            // Permission, EIO: surface, never overwrite with empty state.
            Err(e) => return Err(StoreError(format!("[{}] {path}: {e}", self.label))),
        };
        match serde_json::from_str::<Raw>(&String::from_utf8_lossy(&bytes)) {
            Ok(raw) => Ok((self.parse)(raw)),
            Err(e) => Err(StoreError(format!(
                "[{}] cannot parse {path} (corrupted?): {e}",
                self.label
            ))),
        }
    }

    async fn persist(&self, next: &T) -> Result<(), StoreError> {
        let fail = |e: &dyn std::fmt::Display| {
            StoreError(format!("[{}] {}: {e}", self.label, self.path.display()))
        };
        #[cfg(test)]
        if let Some(f) = self.fail.lock().unwrap().as_mut()
            && f()
        {
            return Err(fail(&"injected write failure"));
        }
        let text = serde_json::to_string_pretty(next).map_err(|e| fail(&e))? + "\n";
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            tokio::fs::create_dir_all(dir).await.map_err(|e| fail(&e))?;
        }
        let millis = chrono::Utc::now().timestamp_millis();
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(format!(".tmp-{}-{millis}", std::process::id()));
        let tmp = PathBuf::from(tmp);
        let written = async {
            tokio::fs::write(&tmp, text).await?;
            tokio::fs::rename(&tmp, &self.path).await
        }
        .await;
        if let Err(e) = written {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(fail(&e));
        }
        Ok(())
    }
}

/// The four JSON stores, at their configured paths.
pub struct Stores {
    pub feedback: JsonStore<FeedbackFile>,
    pub rejections: JsonStore<Rejections>,
    pub watchlist: JsonStore<WatchlistFile>,
    pub policies: JsonStore<PoliciesFile>,
}

impl Stores {
    pub fn new(c: &Config) -> Stores {
        Stores {
            feedback: JsonStore::new(&c.user_feedback_path, "userFeedback", parse_feedback),
            rejections: JsonStore::new(&c.rejections_path, "rejections", parse_rejections),
            watchlist: JsonStore::new(&c.user_watchlist_path, "userWatchlist", parse_watchlist),
            policies: JsonStore::new(&c.user_policies_path, "userPolicies", parse_policies),
        }
    }
}

// --- sanitize -----------------------------------------------------------------

/// Real titles are well under 200 UTF-16 units.
pub const MAX_TITLE_LEN: usize = 200;
/// Watchlist titles and poster paths (the route's bound too).
pub const MAX_WATCHLIST_STR_LEN: usize = 512;

/// sanitizeTitle: user strings that later land in an LLM prompt lose C0
/// controls and DEL (newlines are the injection vector), whitespace runs
/// collapse to one space, the ends are trimmed, and the length is capped.
pub fn sanitize_title(raw: &str) -> String {
    clean(raw, MAX_TITLE_LEN)
}

fn clean(raw: &str, max: usize) -> String {
    let spaced: String = raw
        .chars()
        .map(|c| if c <= '\x1f' || c == '\x7f' { ' ' } else { c })
        .collect();
    let collapsed = spaced
        .split(auth::js_space)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    auth::js_slice(&collapsed, max).to_string()
}

fn str_of(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or_default()
}

/// A JSON number that is a positive integer (`Number.isInteger(n) && n > 0`),
/// within the safe range.
pub fn positive_int(v: &Value) -> Option<u64> {
    let n = v.as_f64()?;
    (n.fract() == 0.0 && n > 0.0 && n <= MAX_SAFE).then_some(n as u64)
}

pub const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IdTitle {
    pub id: u64,
    pub title: String,
}

/// A persisted feedback/rejection row: a bare positive id (legacy) or
/// `{id, title}`, sanitized; anything else is dropped.
pub fn normalize_id_title(v: &Value) -> Option<IdTitle> {
    if let Some(id) = positive_int(v) {
        return Some(IdTitle {
            id,
            title: String::new(),
        });
    }
    let id = positive_int(v.get("id")?)?;
    Some(IdTitle {
        id,
        title: sanitize_title(str_of(v.get("title"))),
    })
}

/// Drop invalid rows and duplicate ids (first wins).
pub fn normalize_id_title_list(v: Option<&Value>) -> Vec<IdTitle> {
    let mut seen = HashSet::new();
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(normalize_id_title)
        .filter(|e| seen.insert(e.id))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Movie,
    Tv,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "movie" => Some(Kind::Movie),
            "tv" => Some(Kind::Tv),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Movie => "movie",
            Kind::Tv => "tv",
        }
    }
}

/// Top-level entries with a non-empty key.
fn by_sub<T>(raw: Raw, f: impl Fn(&Value) -> T) -> IndexMap<String, T> {
    raw.into_iter()
        .filter(|(sub, _)| !sub.is_empty())
        .map(|(sub, v)| {
            let t = f(&v);
            (sub, t)
        })
        .collect()
}

// --- userFeedback ---------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Like,
    Dislike,
}

impl Signal {
    pub fn parse(s: &str) -> Option<Signal> {
        match s {
            "like" => Some(Signal::Like),
            "dislike" => Some(Signal::Dislike),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Signal::Like => "like",
            Signal::Dislike => "dislike",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct KindLists {
    pub liked: Vec<IdTitle>,
    pub disliked: Vec<IdTitle>,
}

/// One member's likes (private signal) and dislikes (rolled into the
/// household rejection list by the route).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct UserFeedback {
    pub movie: KindLists,
    pub tv: KindLists,
}

impl UserFeedback {
    pub fn kind(&self, k: Kind) -> &KindLists {
        match k {
            Kind::Movie => &self.movie,
            Kind::Tv => &self.tv,
        }
    }

    fn kind_mut(&mut self, k: Kind) -> &mut KindLists {
        match k {
            Kind::Movie => &mut self.movie,
            Kind::Tv => &mut self.tv,
        }
    }
}

pub type FeedbackFile = IndexMap<String, UserFeedback>;

fn parse_feedback(raw: Raw) -> FeedbackFile {
    let lists = |v: Option<&Value>| KindLists {
        liked: normalize_id_title_list(v.and_then(|v| v.get("liked"))),
        disliked: normalize_id_title_list(v.and_then(|v| v.get("disliked"))),
    };
    by_sub(raw, |v| UserFeedback {
        movie: lists(v.get("movie")),
        tv: lists(v.get("tv")),
    })
}

impl JsonStore<FeedbackFile> {
    pub async fn user(&self, sub: &str) -> Result<UserFeedback, StoreError> {
        Ok(self.get().await?.get(sub).cloned().unwrap_or_default())
    }

    /// Set (or with `None` clear) one item's signal; like and dislike are
    /// mutually exclusive, and the item moves to the tail. An empty title
    /// never overwrites a known one. No cap: a dislike is a permanent
    /// "never suggest again", so nothing is ever evicted.
    pub async fn set(
        &self,
        sub: &str,
        kind: Kind,
        id: u64,
        title: &str,
        next: Option<Signal>,
    ) -> Result<(), StoreError> {
        let title = sanitize_title(title);
        self.update(|file| {
            let mut user = file.get(sub).cloned().unwrap_or_default();
            let lists = user.kind_mut(kind);
            let known = lists
                .liked
                .iter()
                .chain(&lists.disliked)
                .find(|e| e.id == id)
                .map(|e| e.title.clone());
            let title = if title.is_empty() {
                known.unwrap_or_default()
            } else {
                title
            };
            lists.liked.retain(|e| e.id != id);
            lists.disliked.retain(|e| e.id != id);
            let entry = IdTitle { id, title };
            match next {
                Some(Signal::Like) => lists.liked.push(entry),
                Some(Signal::Dislike) => lists.disliked.push(entry),
                None => {}
            }
            let mut file = file.clone();
            file.insert(sub.to_string(), user);
            Some(file)
        })
        .await
    }

    /// Drop every signal one member recorded (account deletion).
    pub async fn clear_user(&self, sub: &str) -> Result<(), StoreError> {
        self.update(|file| {
            let mut file = file.clone();
            file.shift_remove(sub)?;
            Some(file)
        })
        .await
    }

    /// Title backfill: only an existing like changes; never adds a row and
    /// never touches a dislike (the user may have cleared or flipped it
    /// while the title was resolving).
    pub async fn update_liked_title_if_present(
        &self,
        sub: &str,
        kind: Kind,
        id: u64,
        title: &str,
    ) -> Result<(), StoreError> {
        let title = sanitize_title(title);
        if title.is_empty() {
            return Ok(());
        }
        self.update(|file| {
            let mut user = file.get(sub)?.clone();
            let row = user.kind_mut(kind).liked.iter_mut().find(|e| e.id == id)?;
            if row.title == title {
                return None;
            }
            row.title = title;
            let mut file = file.clone();
            file.insert(sub.to_string(), user);
            Some(file)
        })
        .await
    }

    /// True when a member other than `caller` dislikes this title: removing
    /// the caller's dislike must then keep the household veto.
    pub async fn another_user_dislikes(
        &self,
        caller: &str,
        kind: Kind,
        id: u64,
    ) -> Result<bool, StoreError> {
        Ok(self.get().await?.iter().any(|(sub, user)| {
            sub != caller && user.kind(kind).disliked.iter().any(|e| e.id == id)
        }))
    }
}

// --- rejections (the household veto) ------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Rejections {
    pub movie: Vec<IdTitle>,
    pub tv: Vec<IdTitle>,
}

impl Rejections {
    pub fn kind(&self, k: Kind) -> &Vec<IdTitle> {
        match k {
            Kind::Movie => &self.movie,
            Kind::Tv => &self.tv,
        }
    }

    fn kind_mut(&mut self, k: Kind) -> &mut Vec<IdTitle> {
        match k {
            Kind::Movie => &mut self.movie,
            Kind::Tv => &mut self.tv,
        }
    }
}

fn parse_rejections(raw: Raw) -> Rejections {
    Rejections {
        movie: normalize_id_title_list(raw.get("movie")),
        tv: normalize_id_title_list(raw.get("tv")),
    }
}

impl JsonStore<Rejections> {
    pub async fn ids(&self, kind: Kind) -> Result<HashSet<u64>, StoreError> {
        Ok(self.get().await?.kind(kind).iter().map(|e| e.id).collect())
    }

    /// Idempotent; a fresh title upgrades a known row in place, an empty
    /// one never blanks it.
    pub async fn add(&self, kind: Kind, id: u64, title: &str) -> Result<(), StoreError> {
        let title = sanitize_title(title);
        self.update(|file| {
            let existing = file.kind(kind).iter().find(|e| e.id == id);
            if existing.is_some_and(|e| title.is_empty() || e.title == title) {
                return None;
            }
            let mut next = file.clone();
            let list = next.kind_mut(kind);
            match list.iter_mut().find(|e| e.id == id) {
                Some(row) => row.title = title,
                None => list.push(IdTitle { id, title }),
            }
            Some(next)
        })
        .await
    }

    /// Title backfill on an existing row only; never recreates a cleared one.
    pub async fn update_title_if_present(
        &self,
        kind: Kind,
        id: u64,
        title: &str,
    ) -> Result<(), StoreError> {
        let title = sanitize_title(title);
        if title.is_empty() {
            return Ok(());
        }
        self.update(|file| {
            let mut next = file.clone();
            let row = next.kind_mut(kind).iter_mut().find(|e| e.id == id)?;
            if row.title == title {
                return None;
            }
            row.title = title;
            Some(next)
        })
        .await
    }

    pub async fn remove(&self, kind: Kind, id: u64) -> Result<(), StoreError> {
        self.update(|file| {
            if !file.kind(kind).iter().any(|e| e.id == id) {
                return None;
            }
            let mut next = file.clone();
            next.kind_mut(kind).retain(|e| e.id != id);
            Some(next)
        })
        .await
    }
}

// --- userWatchlist ------------------------------------------------------------

/// `id` is the tmdbId for movies and the tvdbId for series; `added_at` is
/// ISO-8601, so newest-first is a string sort.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WatchEntry {
    pub id: u64,
    pub title: String,
    pub added_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poster_path: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct UserWatchlist {
    pub movie: Vec<WatchEntry>,
    pub tv: Vec<WatchEntry>,
}

impl UserWatchlist {
    fn kind_mut(&mut self, k: Kind) -> &mut Vec<WatchEntry> {
        match k {
            Kind::Movie => &mut self.movie,
            Kind::Tv => &mut self.tv,
        }
    }
}

pub type WatchlistFile = IndexMap<String, UserWatchlist>;

/// Titles and posters never reach a prompt, but a torn line must not corrupt
/// the file and a hostile client must not bloat it.
pub fn sanitize_watchlist_str(raw: &str) -> String {
    clean(raw, MAX_WATCHLIST_STR_LEN)
}

fn normalize_watch_entry(v: &Value) -> Option<WatchEntry> {
    let id = positive_int(v.get("id")?)?;
    let poster = sanitize_watchlist_str(str_of(v.get("poster_path")));
    Some(WatchEntry {
        id,
        title: sanitize_watchlist_str(str_of(v.get("title"))),
        added_at: v
            .get("added_at")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("1970-01-01T00:00:00.000Z")
            .to_string(),
        poster_path: (!poster.is_empty()).then_some(poster),
    })
}

fn normalize_watch_list(v: Option<&Value>) -> Vec<WatchEntry> {
    let mut seen = HashSet::new();
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(normalize_watch_entry)
        .filter(|e| seen.insert(e.id))
        .collect()
}

fn parse_watchlist(raw: Raw) -> WatchlistFile {
    by_sub(raw, |v| UserWatchlist {
        movie: normalize_watch_list(v.get("movie")),
        tv: normalize_watch_list(v.get("tv")),
    })
}

impl JsonStore<WatchlistFile> {
    pub async fn user(&self, sub: &str) -> Result<UserWatchlist, StoreError> {
        Ok(self.get().await?.get(sub).cloned().unwrap_or_default())
    }

    /// Re-adding an id updates its title and poster but keeps `added_at`,
    /// so a repeated PUT is a true no-op on the order.
    pub async fn upsert(
        &self,
        sub: &str,
        kind: Kind,
        id: u64,
        title: &str,
        poster_path: Option<&str>,
    ) -> Result<(), StoreError> {
        let title = sanitize_watchlist_str(title);
        let poster = poster_path
            .map(sanitize_watchlist_str)
            .filter(|p| !p.is_empty());
        self.update(|file| {
            let mut user = file.get(sub).cloned().unwrap_or_default();
            let list = user.kind_mut(kind);
            match list.iter_mut().find(|e| e.id == id) {
                Some(row) => {
                    row.title = title;
                    row.poster_path = poster;
                }
                None => list.push(WatchEntry {
                    id,
                    title,
                    added_at: auth::now_iso(),
                    poster_path: poster,
                }),
            }
            let mut file = file.clone();
            file.insert(sub.to_string(), user);
            Some(file)
        })
        .await
    }

    /// Drop one member's whole watchlist (account deletion).
    pub async fn clear_user(&self, sub: &str) -> Result<(), StoreError> {
        self.update(|file| {
            let mut file = file.clone();
            file.shift_remove(sub)?;
            Some(file)
        })
        .await
    }

    pub async fn remove(&self, sub: &str, kind: Kind, id: u64) -> Result<(), StoreError> {
        self.update(|file| {
            let mut user = file.get(sub)?.clone();
            let list = user.kind_mut(kind);
            let before = list.len();
            list.retain(|e| e.id != id);
            if list.len() == before {
                return None;
            }
            let mut file = file.clone();
            file.insert(sub.to_string(), user);
            Some(file)
        })
        .await
    }
}

// --- userPolicies -------------------------------------------------------------

/// The ratings the app understands (US MPAA + US TV).
pub const CONTENT_RATINGS: &[&str] = &[
    "G", "PG", "PG-13", "R", "NC-17", "TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Live,
    Downloads,
    Arr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Sections {
    pub live: bool,
    pub downloads: bool,
    pub arr: bool,
}

impl Sections {
    pub fn allows(&self, s: Section) -> bool {
        match s {
            Section::Live => self.live,
            Section::Downloads => self.downloads,
            Section::Arr => self.arr,
        }
    }
}

/// Parental controls and section scoping. `None` fields restrict nothing:
/// an absent sub is default-open, so adding a member never locks them out.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub max_content_rating: Option<String>,
    pub allowed_sections: Option<Sections>,
    pub kid: bool,
}

pub type PoliciesFile = IndexMap<String, Policy>;

/// Coerce a persisted value into a Policy (hand-edited files): an unknown
/// rating is no cap, a partial section map fills the gaps as allowed, a
/// non-boolean kid is false. The route validates strictly before writing.
pub fn normalize_policy(v: &Value) -> Policy {
    let sections = v
        .get("allowedSections")
        .filter(|s| s.is_object() || s.is_array())
        .map(|s| {
            let allowed = |k: &str| s.get(k) != Some(&Value::Bool(false));
            Sections {
                live: allowed("live"),
                downloads: allowed("downloads"),
                arr: allowed("arr"),
            }
        });
    Policy {
        max_content_rating: v
            .get("maxContentRating")
            .and_then(Value::as_str)
            .filter(|r| CONTENT_RATINGS.contains(r))
            .map(String::from),
        allowed_sections: sections,
        kid: v.get("kid") == Some(&Value::Bool(true)),
    }
}

fn parse_policies(raw: Raw) -> PoliciesFile {
    by_sub(raw, normalize_policy)
}

/// The cap a policy enforces: an explicit cap wins, and a kid profile
/// without one is held to PG (what both clients browse under).
pub fn effective_cap(p: &Policy) -> Option<&str> {
    p.max_content_rating.as_deref().or(p.kid.then_some("PG"))
}

impl JsonStore<PoliciesFile> {
    /// The member's own policy, default-open when unset.
    pub async fn policy(&self, sub: &str) -> Result<Policy, StoreError> {
        Ok(self.get().await?.get(sub).cloned().unwrap_or_default())
    }

    pub async fn set(&self, sub: &str, policy: Policy) -> Result<(), StoreError> {
        self.update(|file| {
            let mut file = file.clone();
            file.insert(sub.to_string(), policy);
            Some(file)
        })
        .await
    }

    /// Drop one member's policy (account deletion).
    pub async fn remove(&self, sub: &str) -> Result<(), StoreError> {
        self.update(|file| {
            let mut file = file.clone();
            file.shift_remove(sub)?;
            Some(file)
        })
        .await
    }

    /// requireSection: 403 `section_blocked` when the caller's policy
    /// explicitly denies `section`. Admins are never blocked. Callers that
    /// gate only mutations skip GET/HEAD/OPTIONS before calling.
    pub async fn require_section(
        &self,
        session: &auth::session::Session,
        section: Section,
    ) -> Result<(), Response> {
        if session.role == auth::Role::Admin {
            return Ok(());
        }
        let policy = self
            .policy(&session.sub)
            .await
            .map_err(IntoResponse::into_response)?;
        match policy.allowed_sections {
            Some(s) if !s.allows(section) => Err((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "section_blocked" })),
            )
                .into_response()),
            _ => Ok(()),
        }
    }

    /// True when the caller's cap forbids unrated catalogs (IPTV VOD,
    /// series, catchup, YouTube): any cap does, except for admins.
    pub async fn cap_blocks_unrated(
        &self,
        session: &auth::session::Session,
    ) -> Result<bool, StoreError> {
        if session.role == auth::Role::Admin {
            return Ok(false);
        }
        Ok(effective_cap(&self.policy(&session.sub).await?).is_some())
    }
}

// --- the BYO Anthropic key (server.db user_api_keys) ----------------------------
//
// AES-256-GCM per row with the sub as AAD (auth::rekey holds the layout the
// re-key re-encrypts with). The plaintext is never logged or returned by any
// surface except [`api_key`], which only the suggestions path consumes.

pub const API_KEY_PREFIX: &str = "sk-ant-";
pub const API_KEY_MAX_LEN: usize = 512;

/// `sk-ant-` plus something, at most 512 UTF-16 units, no whitespace.
pub fn plausible_anthropic_key(key: &str) -> bool {
    let len = auth::js_len(key);
    key.starts_with(API_KEY_PREFIX)
        && len > API_KEY_PREFIX.len()
        && len <= API_KEY_MAX_LEN
        && !key.chars().any(auth::js_space)
}

pub async fn set_api_key(
    pool: &SqlitePool,
    session_secret: &str,
    sub: &str,
    key: &str,
) -> Result<(), sqlx::Error> {
    let cipher = auth::rekey::api_key_cipher(session_secret.as_bytes());
    sqlx::query(
        "INSERT INTO user_api_keys (sub, ciphertext, updated_at) VALUES (?, ?, datetime('now')) \
         ON CONFLICT(sub) DO UPDATE SET ciphertext = excluded.ciphertext, \
         updated_at = excluded.updated_at",
    )
    .bind(sub)
    .bind(auth::rekey::encrypt_api_key(&cipher, sub, key))
    .execute(pool)
    .await?;
    Ok(())
}

/// The stored key, or None when absent or undecryptable (secret rotated,
/// tampered, copied from another sub).
pub async fn api_key(
    pool: &SqlitePool,
    session_secret: &str,
    sub: &str,
) -> Result<Option<String>, sqlx::Error> {
    let row: Option<String> =
        sqlx::query_scalar("SELECT ciphertext FROM user_api_keys WHERE sub = ?")
            .bind(sub)
            .fetch_optional(pool)
            .await?;
    let cipher = auth::rekey::api_key_cipher(session_secret.as_bytes());
    Ok(row.and_then(|ct| auth::rekey::decrypt_api_key(&cipher, sub, &ct)))
}

/// The UI-safe view: whether a key is stored plus its last 4 characters.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ApiKeyInfo {
    pub set: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last4: Option<String>,
}

pub async fn api_key_info(
    pool: &SqlitePool,
    session_secret: &str,
    sub: &str,
) -> Result<ApiKeyInfo, sqlx::Error> {
    Ok(match api_key(pool, session_secret, sub).await? {
        Some(key) => {
            let units: Vec<u16> = key.encode_utf16().collect();
            let tail = &units[units.len().saturating_sub(4)..];
            ApiKeyInfo {
                set: true,
                last4: Some(String::from_utf16_lossy(tail)),
            }
        }
        None => ApiKeyInfo {
            set: false,
            last4: None,
        },
    })
}

/// True when a row existed.
pub async fn delete_api_key(pool: &SqlitePool, sub: &str) -> Result<bool, sqlx::Error> {
    let r = sqlx::query("DELETE FROM user_api_keys WHERE sub = ?")
        .bind(sub)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

#[cfg(test)]
mod tests;
