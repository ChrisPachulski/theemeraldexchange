//! `eex-rekey`: move one person's data from one sub to another. Built for the
//! step-3 cutover, where Plex is dropped and the owner's household data (keyed
//! on her `plex:` sub) moves to the identity she signs in with from then on.
//! Run by hand, with the stack stopped; DEPLOY.md has the runbook.
//!
//! A dry run (the default) runs every store's transaction and rolls it back,
//! so the counts it prints are exact and no file is written. `--apply` takes a
//! `VACUUM INTO` backup of each SQLite file that has something to change, then
//! commits one transaction per file. Every statement matches only rows that
//! still name the source, so a second `--apply` finds nothing and writes
//! nothing (not even a backup). An apply that stops halfway is finished by
//! running it again.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, Generate, KeyInit, Nonce, Payload};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use emerald_contracts::{Provider, parse_sub};
use serde_json::{Map, Value, json};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{AssertSqlSafe, ConnectOptions, Connection, SqliteConnection};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Store {
    Server,
    Iptv,
    Media,
    Recommender,
}

impl Store {
    pub fn name(self) -> &'static str {
        match self {
            Store::Server => "server.db",
            Store::Iptv => "iptv.db",
            Store::Media => "media.db",
            Store::Recommender => "recommender db",
        }
    }
}

/// What happens to the rows of one sub-bearing column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rule {
    /// `UPDATE OR IGNORE` onto the target. A row the target already has under
    /// the same key is dropped: the target's entry is kept.
    Move,
    /// As `Move`, but a `(sub, name)` clash keeps both rows: the moved one is
    /// renamed `<name> #<id>` (playlists and collections hold items).
    MoveRenaming,
    /// Plain UPDATE: the column is in no unique key.
    Update,
    /// members: the target row gets the source's access (role merged up to
    /// admin, un-revoked when the source is live); the source row is revoked
    /// and kept for audit.
    MergeMember,
    /// The sub sits inside the device-token JWE claims, so the source's tokens
    /// are revoked, not moved. The owner re-pairs her devices.
    RevokeDeviceTokens,
    /// The sub is part of the playlist-token HMAC: revoke. The owner re-mints
    /// her M3U URLs.
    RevokePlaylistTokens,
    /// Short-lived rows (a device-link code the source claimed): delete.
    Delete,
    /// The sub is the AES-GCM AAD of the stored API key: re-encrypt under the
    /// target with `--session-secret-file`, else delete (the owner re-enters it).
    ReencryptApiKey,
    /// Left alone, with the reason.
    Skip(&'static str),
}

pub struct Entry {
    pub store: Store,
    pub table: &'static str,
    pub column: &'static str,
    pub rule: Rule,
}

const fn e(store: Store, table: &'static str, column: &'static str, rule: Rule) -> Entry {
    Entry {
        store,
        table,
        column,
        rule,
    }
}

/// Every column that holds a sub, in the order the rules run. The drift-guard
/// test fails when a migration adds a `sub` / `*_sub` column missing here.
pub const MAP: &[Entry] = &[
    // server.db. members first: the merge reads the source row before
    // anything else touches it.
    e(Store::Server, "members", "sub", Rule::MergeMember),
    e(Store::Server, "members", "invited_by", Rule::Update),
    e(Store::Server, "invites", "issued_by", Rule::Update),
    e(
        Store::Server,
        "device_tokens",
        "sub",
        Rule::RevokeDeviceTokens,
    ),
    e(
        Store::Server,
        "device_link_codes",
        "claimed_sub",
        Rule::Delete,
    ),
    e(Store::Server, "user_api_keys", "sub", Rule::ReencryptApiKey),
    e(
        Store::Server,
        "members_pre_google",
        "sub",
        Rule::Skip(PRE_COPY),
    ),
    e(
        Store::Server,
        "members_pre_workos",
        "sub",
        Rule::Skip(PRE_COPY),
    ),
    e(
        Store::Server,
        "webauthn_credentials",
        "sub",
        Rule::Skip(PASSKEYS),
    ),
    e(
        Store::Server,
        "webauthn_challenges",
        "pending_sub",
        Rule::Skip(PASSKEYS),
    ),
    // iptv.db
    e(Store::Iptv, "iptv_favorites", "sub", Rule::Move),
    e(Store::Iptv, "iptv_watch_history", "sub", Rule::Move),
    e(
        Store::Iptv,
        "iptv_playlist_tokens",
        "sub",
        Rule::RevokePlaylistTokens,
    ),
    // media.db
    e(Store::Media, "media_watch_state", "sub", Rule::Move),
    e(Store::Media, "playlists", "sub", Rule::MoveRenaming),
    e(Store::Media, "collections", "sub", Rule::MoveRenaming),
    e(Store::Media, "podcasts", "owner_sub", Rule::Update),
    // recommender
    e(Store::Recommender, "user_feedback", "sub", Rule::Move),
    e(Store::Recommender, "recently_shown", "sub", Rule::Move),
    e(Store::Recommender, "rec_log", "sub", Rule::Update),
];

const PRE_COPY: &str = "frozen pre-migration copy of members (0007/0008), never read";
const PASSKEYS: &str = "passkeys were removed (0182a18); no route reads these rows";

/// One line of the report: what changed, and how many rows or entries.
pub type Count = (String, u64);

pub struct Opts {
    pub from: String,
    pub to: String,
    pub apply: bool,
    pub server_db: Option<PathBuf>,
    pub iptv_db: Option<PathBuf>,
    pub media_db: Option<PathBuf>,
    pub recommender_db: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub session_secret_file: Option<PathBuf>,
}

pub const USAGE: &str = "usage: eex-rekey --from <sub> --to <sub> [--apply] \
[--server-db <path>] [--iptv-db <path>] [--media-db <path>] [--recommender-db <path>] \
[--data-dir <dir>] [--session-secret-file <path>]";

/// Parse and validate the command line. `Ok` carries any warnings to print.
pub fn parse_args(args: &[String]) -> Result<(Opts, Vec<String>), String> {
    let mut o = Opts {
        from: String::new(),
        to: String::new(),
        apply: false,
        server_db: None,
        iptv_db: None,
        media_db: None,
        recommender_db: None,
        data_dir: None,
        session_secret_file: None,
    };
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        if flag == "--apply" {
            o.apply = true;
            continue;
        }
        let value = it
            .next()
            .ok_or_else(|| format!("{flag} needs a value\n{USAGE}"))?;
        let path = || Some(PathBuf::from(value));
        match flag.as_str() {
            "--from" => o.from = value.clone(),
            "--to" => o.to = value.clone(),
            "--server-db" => o.server_db = path(),
            "--iptv-db" => o.iptv_db = path(),
            "--media-db" => o.media_db = path(),
            "--recommender-db" => o.recommender_db = path(),
            "--data-dir" => o.data_dir = path(),
            "--session-secret-file" => o.session_secret_file = path(),
            _ => return Err(format!("unknown flag {flag}\n{USAGE}")),
        }
    }
    let from =
        parse_sub(&o.from).map_err(|e| format!("--from {:?} is not a sub: {e:?}", o.from))?;
    let to = parse_sub(&o.to).map_err(|e| format!("--to {:?} is not a sub: {e:?}", o.to))?;
    if from.raw == to.raw {
        return Err("--to equals --from: nothing to re-key".into());
    }
    if o.server_db.is_none()
        && o.iptv_db.is_none()
        && o.media_db.is_none()
        && o.recommender_db.is_none()
        && o.data_dir.is_none()
    {
        return Err(format!("no store given\n{USAGE}"));
    }
    let mut warnings = Vec::new();
    if to.provider == Provider::Local {
        warnings.push(format!(
            "WARNING: {} is a local: sub, and nothing can sign in as local: (passkeys were removed). \
             The data will be unreachable until a local sign-in path exists.",
            to.raw
        ));
    }
    Ok((o, warnings))
}

/// Run every store the options name; returns the report lines.
pub async fn run(o: &Opts) -> Result<Vec<String>, String> {
    let api_key = match &o.session_secret_file {
        Some(p) => {
            let s = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
            Some(api_key_cipher(s.trim_end_matches(['\n', '\r']).as_bytes()))
        }
        None => None,
    };
    let dbs = [
        (Store::Server, &o.server_db),
        (Store::Iptv, &o.iptv_db),
        (Store::Media, &o.media_db),
        (Store::Recommender, &o.recommender_db),
    ];
    let mut out = vec![if o.apply {
        format!("APPLY: re-keying {} -> {}", o.from, o.to)
    } else {
        format!(
            "DRY RUN (nothing written; add --apply): {} -> {}",
            o.from, o.to
        )
    }];
    // Every store is dry-run first, so a store that cannot be read stops the
    // run before anything is written.
    let mut plans = Vec::new();
    for (store, path) in dbs {
        if let Some(path) = path {
            let counts = rekey_db(path, store, &o.from, &o.to, api_key.as_ref(), false).await?;
            plans.push((store, path, counts));
        }
    }
    let files = match &o.data_dir {
        Some(dir) => plan_data_dir(dir, &o.from, &o.to)?,
        None => Vec::new(),
    };
    for (store, path, counts) in plans {
        let counts = if o.apply && changes(&counts) {
            rekey_db(path, store, &o.from, &o.to, api_key.as_ref(), true).await?
        } else {
            counts
        };
        report(
            &mut out,
            &format!("{} {}", store.name(), path.display()),
            &counts,
        );
    }
    for f in &files {
        if o.apply
            && let Some(text) = &f.new_text
        {
            write_file(&f.path, text)?;
        }
        report(&mut out, &f.path.display().to_string(), &f.counts);
    }
    Ok(out)
}

fn changes(counts: &[Count]) -> bool {
    counts.iter().any(|(_, n)| *n > 0)
}

fn report(out: &mut Vec<String>, title: &str, counts: &[Count]) {
    out.push(title.to_string());
    if counts.is_empty() {
        out.push("  (absent)".into());
    }
    for (label, n) in counts {
        out.push(format!("  {label}: {n}"));
    }
}

// --- SQLite -----------------------------------------------------------------

/// One store: the rules in a transaction, rolled back unless `write`. With
/// `write`, a `VACUUM INTO` backup is taken first.
pub async fn rekey_db(
    path: &Path,
    store: Store,
    from: &str,
    to: &str,
    api_key: Option<&Aes256Gcm>,
    write: bool,
) -> Result<Vec<Count>, String> {
    let err = |e: sqlx::Error| format!("{}: {e}", path.display());
    let mut conn = SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(std::time::Duration::from_secs(5))
        .connect()
        .await
        .map_err(err)?;
    if write {
        backup(&mut conn, path).await?;
    }
    let mut tx = conn.begin().await.map_err(err)?;
    let counts = apply_rules(&mut tx, store, from, to, api_key)
        .await
        .map_err(err)?;
    if write {
        tx.commit().await.map_err(err)?;
    } else {
        tx.rollback().await.map_err(err)?;
    }
    conn.close().await.map_err(err)?;
    Ok(counts)
}

async fn backup(conn: &mut SqliteConnection, path: &Path) -> Result<(), String> {
    let dest = sibling(path, &format!("pre-rekey-{}", stamp()));
    sqlx::query("VACUUM INTO ?")
        .bind(dest.to_string_lossy().into_owned())
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("backup of {}: {e}", path.display()))?;
    let mut snap = SqliteConnectOptions::new()
        .filename(&dest)
        .read_only(true)
        .connect()
        .await
        .map_err(|e| format!("open {}: {e}", dest.display()))?;
    let rows: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut snap)
        .await
        .map_err(|e| format!("integrity_check {}: {e}", dest.display()))?;
    if rows != ["ok"] {
        return Err(format!("backup {} failed integrity_check", dest.display()));
    }
    Ok(())
}

/// `<file>.<suffix>` next to `path`.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{suffix}"));
    path.with_file_name(name)
}

/// `toISOString()` made filesystem-safe (as iptv's backup names).
fn stamp() -> String {
    crate::now_iso().replace([':', '.'], "-")
}

async fn apply_rules(
    c: &mut SqliteConnection,
    store: Store,
    from: &str,
    to: &str,
    api_key: Option<&Aes256Gcm>,
) -> Result<Vec<Count>, sqlx::Error> {
    let mut counts = Vec::new();
    for en in MAP.iter().filter(|en| en.store == store) {
        let (t, col) = (en.table, en.column);
        let label = |what: &str| format!("{t}.{col} {what}");
        // Identifiers come from MAP, never from input.
        let exec = |sql: String| sqlx::query(AssertSqlSafe(sql));
        match en.rule {
            Rule::Move | Rule::MoveRenaming => {
                let moved = exec(format!(
                    "UPDATE OR IGNORE {t} SET {col} = ? WHERE {col} = ?"
                ))
                .bind(to)
                .bind(from)
                .execute(&mut *c)
                .await?
                .rows_affected();
                counts.push((label("moved"), moved));
                if en.rule == Rule::Move {
                    let dropped = exec(format!("DELETE FROM {t} WHERE {col} = ?"))
                        .bind(from)
                        .execute(&mut *c)
                        .await?
                        .rows_affected();
                    counts.push((label("dropped (target already had it)"), dropped));
                } else {
                    let renamed = exec(format!(
                        "UPDATE {t} SET {col} = ?, name = name || ' #' || id WHERE {col} = ?"
                    ))
                    .bind(to)
                    .bind(from)
                    .execute(&mut *c)
                    .await?
                    .rows_affected();
                    counts.push((label("moved with a renamed name clash"), renamed));
                }
            }
            Rule::Update => {
                let n = exec(format!("UPDATE {t} SET {col} = ? WHERE {col} = ?"))
                    .bind(to)
                    .bind(from)
                    .execute(&mut *c)
                    .await?
                    .rows_affected();
                counts.push((label("moved"), n));
            }
            Rule::MergeMember => counts.extend(merge_member(c, from, to).await?),
            Rule::RevokeDeviceTokens => {
                let n = exec(format!(
                    "INSERT OR IGNORE INTO device_token_revocations (jti, revoked_at, reason) \
                     SELECT jti, datetime('now'), 'rekey' FROM {t} WHERE {col} = ?"
                ))
                .bind(from)
                .execute(&mut *c)
                .await?
                .rows_affected();
                counts.push((label("tokens revoked"), n));
            }
            Rule::RevokePlaylistTokens => {
                let n = exec(format!(
                    "UPDATE {t} SET revoked_at = ? WHERE {col} = ? AND revoked_at IS NULL"
                ))
                .bind(crate::now_iso())
                .bind(from)
                .execute(&mut *c)
                .await?
                .rows_affected();
                counts.push((label("tokens revoked"), n));
            }
            Rule::Delete => {
                let n = exec(format!("DELETE FROM {t} WHERE {col} = ?"))
                    .bind(from)
                    .execute(&mut *c)
                    .await?
                    .rows_affected();
                counts.push((label("deleted"), n));
            }
            Rule::ReencryptApiKey => counts.extend(move_api_key(c, from, to, api_key).await?),
            Rule::Skip(_) => {}
        }
    }
    Ok(counts)
}

type MemberRow = (
    Option<String>,
    String,
    Option<String>,
    String,
    Option<String>,
);

async fn merge_member(
    c: &mut SqliteConnection,
    from: &str,
    to: &str,
) -> Result<Vec<Count>, sqlx::Error> {
    let get = |sub: &str| {
        sqlx::query_as::<_, MemberRow>(
            "SELECT display_name, role, invited_by, joined_at, revoked_at FROM members WHERE sub = ?",
        )
        .bind(sub.to_string())
    };
    let Some((name, role, invited_by, joined_at, revoked_at)) =
        get(from).fetch_optional(&mut *c).await?
    else {
        return Ok(vec![
            ("members.sub moved to target".into(), 0),
            ("members.sub source revoked".into(), 0),
        ]);
    };
    let source_live = revoked_at.is_none();
    let merged = match get(to).fetch_optional(&mut *c).await? {
        None => sqlx::query(
            "INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(to)
        .bind(name)
        .bind(&role)
        .bind(crate::sub_namespace(to))
        .bind(invited_by)
        .bind(joined_at)
        .bind(&revoked_at)
        .execute(&mut *c)
        .await?
        .rows_affected(),
        // A revoked source passes nothing on.
        Some(_) if !source_live => 0,
        Some((_, target_role, ..)) => {
            let role = if role == "admin" || target_role == "admin" {
                "admin"
            } else {
                "user"
            };
            sqlx::query(
                "UPDATE members SET role = ?, revoked_at = NULL \
                 WHERE sub = ? AND (role != ? OR revoked_at IS NOT NULL)",
            )
            .bind(role)
            .bind(to)
            .bind(role)
            .execute(&mut *c)
            .await?
            .rows_affected()
        }
    };
    let revoked =
        sqlx::query("UPDATE members SET revoked_at = ? WHERE sub = ? AND revoked_at IS NULL")
            .bind(crate::now_iso())
            .bind(from)
            .execute(&mut *c)
            .await?
            .rows_affected();
    Ok(vec![
        ("members.sub moved to target".into(), merged),
        ("members.sub source revoked".into(), revoked),
    ])
}

async fn move_api_key(
    c: &mut SqliteConnection,
    from: &str,
    to: &str,
    api_key: Option<&Aes256Gcm>,
) -> Result<Vec<Count>, sqlx::Error> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT ciphertext FROM user_api_keys WHERE sub = ?")
            .bind(from)
            .fetch_optional(&mut *c)
            .await?;
    let target_has: Option<i64> = sqlx::query_scalar("SELECT 1 FROM user_api_keys WHERE sub = ?")
        .bind(to)
        .fetch_optional(&mut *c)
        .await?;
    let plaintext = match (&stored, target_has, api_key) {
        (Some(s), None, Some(k)) => decrypt_api_key(k, from, s),
        _ => None,
    };
    let (mut reencrypted, mut deleted) = (0, 0);
    if let (Some(pt), Some(k)) = (plaintext, api_key) {
        reencrypted = sqlx::query("UPDATE user_api_keys SET sub = ?, ciphertext = ? WHERE sub = ?")
            .bind(to)
            .bind(encrypt_api_key(k, to, &pt))
            .bind(from)
            .execute(&mut *c)
            .await?
            .rows_affected();
    } else if stored.is_some() {
        // No secret, an undecryptable row (TS reads that as "no key"), or the
        // target already has a key of its own.
        deleted = sqlx::query("DELETE FROM user_api_keys WHERE sub = ?")
            .bind(from)
            .execute(&mut *c)
            .await?
            .rows_affected();
    }
    Ok(vec![
        (
            "user_api_keys.sub re-encrypted for target".into(),
            reencrypted,
        ),
        ("user_api_keys.sub deleted".into(), deleted),
    ])
}

/// userApiKeys.ts: AES-256-GCM under HKDF(SESSION_SECRET, 'eex/user-api-key/v1'),
/// stored as base64(iv || ciphertext || tag), AAD `eex/user-api-key/v1:<sub>`.
pub fn api_key_cipher(session_secret: &[u8]) -> Aes256Gcm {
    let key = emerald_contracts::hkdf::derive_key(session_secret, b"eex/user-api-key/v1");
    Aes256Gcm::new(&key.into())
}

fn api_key_aad(sub: &str) -> String {
    format!("eex/user-api-key/v1:{sub}")
}

pub fn decrypt_api_key(cipher: &Aes256Gcm, sub: &str, stored: &str) -> Option<String> {
    let raw = STANDARD.decode(stored).ok()?;
    if raw.len() < 12 + 16 + 1 {
        return None;
    }
    let nonce = Nonce::<Aes256Gcm>::try_from(&raw[..12]).ok()?;
    let aad = api_key_aad(sub);
    let pt = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &raw[12..],
                aad: aad.as_bytes(),
            },
        )
        .ok()?;
    String::from_utf8(pt).ok()
}

pub fn encrypt_api_key(cipher: &Aes256Gcm, sub: &str, plaintext: &str) -> String {
    let nonce = Nonce::<Aes256Gcm>::generate();
    let aad = api_key_aad(sub);
    let ct = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .expect("aes-gcm encrypt with a random nonce does not fail");
    let mut raw = nonce.to_vec();
    raw.extend_from_slice(&ct);
    STANDARD.encode(raw)
}

// --- JSON and JSONL files in the backend data dir ---------------------------

#[derive(Clone, Copy)]
enum JsonKind {
    /// `{ sub: { movie: {liked: [{id,..}], disliked: [..]}, tv: .. } }`
    Feedback,
    /// `{ sub: { movie: [{id,..}], tv: [..] } }`
    Watchlist,
    /// `{ sub: Policy }`
    Policies,
}

const JSON_FILES: &[(&str, JsonKind)] = &[
    ("user-feedback.json", JsonKind::Feedback),
    ("user-watchlist.json", JsonKind::Watchlist),
    ("user-policies.json", JsonKind::Policies),
];

/// The logs plus the one rotated generation each keeps (`<name>.1`).
const JSONL_FILES: &[&str] = &[
    "usage.jsonl",
    "usage.jsonl.1",
    "grabs.jsonl",
    "grabs.jsonl.1",
];

pub struct FilePlan {
    pub path: PathBuf,
    /// The rewritten file, when anything changes.
    pub new_text: Option<String>,
    pub counts: Vec<Count>,
}

/// Work out every data-dir rewrite without writing. A missing file is
/// reported with no counts.
pub fn plan_data_dir(dir: &Path, from: &str, to: &str) -> Result<Vec<FilePlan>, String> {
    let read = |name: &str| -> Result<(PathBuf, Option<String>), String> {
        let path = dir.join(name);
        match std::fs::read_to_string(&path) {
            Ok(t) => Ok((path, Some(t))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((path, None)),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    };
    let mut plans = Vec::new();
    for (name, kind) in JSON_FILES {
        let (path, text) = read(name)?;
        let (new_text, counts) = match text {
            Some(t) => {
                let (new, moved, kept) = rekey_json_map(&t, from, to, *kind)
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                (
                    new,
                    vec![
                        ("entries moved".into(), moved),
                        ("entries dropped (target already had them)".into(), kept),
                    ],
                )
            }
            None => (None, Vec::new()),
        };
        plans.push(FilePlan {
            path,
            new_text,
            counts,
        });
    }
    for name in JSONL_FILES {
        let (path, text) = read(name)?;
        let (new_text, counts) = match text {
            Some(t) => {
                let (new, n) =
                    rekey_jsonl(&t, from, to).map_err(|e| format!("{}: {e}", path.display()))?;
                (new, vec![("lines rewritten".into(), n)])
            }
            None => (None, Vec::new()),
        };
        plans.push(FilePlan {
            path,
            new_text,
            counts,
        });
    }
    Ok(plans)
}

/// Merge the source's bucket into the target's, the target's entries kept.
/// Returns the new text (None when the source has no bucket), the entries
/// moved and the entries dropped. Written as the TS stores write
/// (`JSON.stringify(file, null, 2) + '\n'`), keys in sorted order.
fn rekey_json_map(
    text: &str,
    from: &str,
    to: &str,
    kind: JsonKind,
) -> Result<(Option<String>, u64, u64), String> {
    let mut root: Map<String, Value> =
        serde_json::from_str(text).map_err(|e| format!("not a JSON object: {e}"))?;
    let Some(source) = root.remove(from) else {
        return Ok((None, 0, 0));
    };
    let (moved, dropped) = match kind {
        JsonKind::Policies if root.contains_key(to) => (0, 1),
        JsonKind::Policies => {
            root.insert(to.to_string(), source);
            (1, 0)
        }
        JsonKind::Feedback | JsonKind::Watchlist => {
            let target = root.entry(to.to_string()).or_insert_with(|| json!({}));
            merge_buckets(target, source, matches!(kind, JsonKind::Feedback))
        }
    };
    let mut out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok((Some(out), moved, dropped))
}

/// Per kind (movie / tv), append the source's entries whose id the target
/// lacks. Feedback ids are unique across a kind's liked and disliked lists (a
/// title is one or the other), so the target's verdict wins there too.
/// Shapes the TS loaders would discard anyway are dropped.
fn merge_buckets(target: &mut Value, source: Value, feedback: bool) -> (u64, u64) {
    let (Some(target), Value::Object(source)) = (target.as_object_mut(), source) else {
        return (0, 0);
    };
    let (mut moved, mut dropped) = (0, 0);
    let mut push_new = |list: &mut Value, items: Value, taken: &mut HashSet<String>| {
        let (Some(list), Value::Array(items)) = (list.as_array_mut(), items) else {
            return;
        };
        for item in items {
            let id = item.get("id").map(Value::to_string);
            if id.as_ref().is_some_and(|id| !taken.insert(id.clone())) {
                dropped += 1;
            } else {
                list.push(item);
                moved += 1;
            }
        }
    };
    let ids = |lists: &mut dyn Iterator<Item = &Value>| -> HashSet<String> {
        lists
            .filter_map(Value::as_array)
            .flatten()
            .filter_map(|i| i.get("id").map(Value::to_string))
            .collect()
    };
    for (kind, items) in source {
        if feedback {
            let bucket = target.entry(kind).or_insert_with(|| json!({}));
            let (Some(bucket), Value::Object(lists)) = (bucket.as_object_mut(), items) else {
                continue;
            };
            let mut taken = ids(&mut bucket.values());
            for (name, list_items) in lists {
                let list = bucket.entry(name).or_insert_with(|| json!([]));
                push_new(list, list_items, &mut taken);
            }
        } else {
            let list = target.entry(kind).or_insert_with(|| json!([]));
            let mut taken = ids(&mut std::iter::once(&*list));
            push_new(list, items, &mut taken);
        }
    }
    (moved, dropped)
}

/// Rewrite the top-level `sub` of each line that names the source, in place:
/// the rest of the line keeps its bytes and key order. Lines that do not parse
/// (a torn append) are kept as they are.
fn rekey_jsonl(text: &str, from: &str, to: &str) -> Result<(Option<String>, u64), String> {
    let needle = format!("\"sub\":{}", Value::from(from));
    let replacement = format!("\"sub\":{}", Value::from(to));
    let mut out = String::with_capacity(text.len());
    let mut n = 0;
    for (i, line) in text.split_inclusive('\n').enumerate() {
        let body = line.trim_end_matches(['\n', '\r']);
        let mut parsed: Value = match serde_json::from_str(body) {
            Ok(v) => v,
            Err(_) => {
                out.push_str(line);
                continue;
            }
        };
        if parsed.get("sub").and_then(Value::as_str) != Some(from) {
            out.push_str(line);
            continue;
        }
        parsed["sub"] = Value::from(to);
        let rewritten = line.replacen(&needle, &replacement, 1);
        let check: Option<Value> =
            serde_json::from_str(rewritten.trim_end_matches(['\n', '\r'])).ok();
        if body.matches(&needle).count() != 1 || check.as_ref() != Some(&parsed) {
            return Err(format!("line {}: cannot rewrite its sub in place", i + 1));
        }
        out.push_str(&rewritten);
        n += 1;
    }
    Ok(((n > 0).then_some(out), n))
}

/// Copy the original to `<file>.pre-rekey-<stamp>`, then write through a temp
/// sibling and rename (as the TS stores write).
fn write_file(path: &Path, text: &str) -> Result<(), String> {
    let err = |e: std::io::Error| format!("{}: {e}", path.display());
    std::fs::copy(path, sibling(path, &format!("pre-rekey-{}", stamp()))).map_err(err)?;
    let tmp = sibling(path, "rekey-tmp");
    std::fs::write(&tmp, text).map_err(err)?;
    std::fs::set_permissions(&tmp, std::fs::metadata(path).map_err(err)?.permissions())
        .map_err(err)?;
    std::fs::rename(&tmp, path).map_err(err)
}

#[cfg(test)]
mod tests;
