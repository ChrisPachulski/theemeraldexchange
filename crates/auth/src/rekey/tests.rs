use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{AssertSqlSafe, SqlitePool};

use super::*;

const FROM: &str = "plex:1001";
const TO: &str = "workos:user_01HZY3Q6D0AXTW5V6XWXQ2B3C4";
const OTHER: &str = "google:12345";
const SECRET: &str = "rekey-test-session-secret-0123456789abcdef-XYZ";
/// userApiKeys.ts's layout made by plain node:crypto (hkdfSync with the
/// 'eex/user-api-key/v1' info, fixed IV 000102..0b, AAD
/// 'eex/user-api-key/v1:plex:1001') for "sk-ant-test-key-1234" under SECRET.
const NODE_CIPHERTEXT: &str = "AAECAwQFBgcICQoLpADpulrRs8UmgZ9EI5DkFsaN3Eg030ib1M0QTND7MmAluhgQ";

/// Where each store's migrations live.
const MIGRATION_DIRS: &[(&str, Store)] = &[
    ("crates/auth/migrations", Store::Server),
    ("crates/iptv/migrations", Store::Iptv),
    ("crates/media-core/migrations", Store::Media),
    ("crates/recommender/migrations", Store::Recommender),
];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn is_sub_column(c: &str) -> bool {
    c == "sub" || c.ends_with("_sub")
}

// --- drift guard ------------------------------------------------------------

type Tables = BTreeMap<String, BTreeSet<String>>;

fn clean(name: &str) -> String {
    name.split('(')
        .next()
        .unwrap_or_default()
        .trim_matches(|c| matches!(c, '"' | '`' | '[' | ']' | '\''))
        .to_lowercase()
}

/// The tables and columns a run of migration files leaves behind, read from
/// the SQL text: CREATE [VIRTUAL] TABLE, ALTER TABLE (ADD / RENAME / DROP),
/// DROP TABLE. An ALTER it does not understand fails the test, so a new form
/// cannot slip a sub column past it.
fn schema_from_sql(files: &[(String, String)]) -> Tables {
    let mut tables = Tables::new();
    for (file, text) in files {
        let text: String = text
            .lines()
            .map(|l| l.split("--").next().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        for stmt in text.split(';') {
            let words: Vec<&str> = stmt.split_whitespace().collect();
            let up: Vec<String> = words.iter().map(|w| w.to_uppercase()).collect();
            let at = |i: usize| up.get(i).map(String::as_str).unwrap_or_default();
            let create =
                at(0) == "CREATE" && (at(1) == "TABLE" || (at(1) == "VIRTUAL" && at(2) == "TABLE"));
            if create {
                let mut i = if at(1) == "TABLE" { 2 } else { 3 };
                if at(i) == "IF" {
                    i += 3;
                }
                let name = clean(words[i]);
                let (open, close) = (stmt.find('(').unwrap(), stmt.rfind(')').unwrap());
                let mut cols = BTreeSet::new();
                let (mut depth, mut start) = (0, open + 1);
                let body = &stmt[..close];
                for (j, ch) in body.char_indices().skip(open + 1) {
                    match ch {
                        '(' => depth += 1,
                        ')' => depth -= 1,
                        ',' if depth == 0 => {
                            cols.extend(column_of(&body[start..j]));
                            start = j + 1;
                        }
                        _ => {}
                    }
                }
                cols.extend(column_of(&body[start..]));
                tables.insert(name, cols);
            } else if at(0) == "ALTER" && at(1) == "TABLE" {
                let name = clean(words[2]);
                match (at(3), at(4)) {
                    ("ADD", "COLUMN") => {
                        tables.entry(name).or_default().insert(clean(words[5]));
                    }
                    ("RENAME", "TO") => {
                        let cols = tables.remove(&name).unwrap_or_default();
                        tables.insert(clean(words[5]), cols);
                    }
                    ("RENAME", "COLUMN") if at(6) == "TO" => {
                        let cols = tables.entry(name).or_default();
                        cols.remove(&clean(words[5]));
                        cols.insert(clean(words[7]));
                    }
                    ("DROP", "COLUMN") => {
                        tables.entry(name).or_default().remove(&clean(words[5]));
                    }
                    _ => panic!("{file}: ALTER TABLE form the drift guard does not read: {stmt}"),
                }
            } else if at(0) == "DROP" && at(1) == "TABLE" {
                let i = if at(2) == "IF" { 4 } else { 2 };
                tables.remove(&clean(words[i]));
            }
        }
    }
    tables
}

fn column_of(def: &str) -> Option<String> {
    let first = def.split_whitespace().next()?;
    let kw = first.to_uppercase();
    (!matches!(
        kw.as_str(),
        "PRIMARY" | "UNIQUE" | "FOREIGN" | "CHECK" | "CONSTRAINT"
    ))
    .then(|| clean(first))
}

/// Both directions: every sub column has a MAP entry, and every MAP entry
/// names a column that exists.
fn drift(schemas: &[(Store, Tables)]) -> Vec<String> {
    let mut problems = Vec::new();
    for (store, tables) in schemas {
        for (table, cols) in tables {
            for col in cols.iter().filter(|c| is_sub_column(c)) {
                if !MAP
                    .iter()
                    .any(|e| e.store == *store && e.table == table && e.column == col)
                {
                    problems.push(format!(
                        "{}: {table}.{col} holds a sub but is not in rekey::MAP",
                        store.name()
                    ));
                }
            }
        }
    }
    for en in MAP {
        let Some((_, tables)) = schemas.iter().find(|(s, _)| *s == en.store) else {
            problems.push(format!("{}: no migrations found", en.store.name()));
            continue;
        };
        if !tables.get(en.table).is_some_and(|c| c.contains(en.column)) {
            problems.push(format!(
                "{}: rekey::MAP names {}.{}, which no migration creates",
                en.store.name(),
                en.table,
                en.column
            ));
        }
    }
    problems
}

/// Every `*.sql` in the repo (tracked or not ignored), grouped by store.
fn repo_schemas() -> Vec<(Store, Tables)> {
    let out = std::process::Command::new("git")
        .args(["ls-files", "-co", "--exclude-standard", "--", "*.sql"])
        .current_dir(repo_root())
        .output()
        .expect("git ls-files");
    assert!(out.status.success(), "git ls-files failed");
    let mut by_store: Vec<(Store, Vec<String>)> = Vec::new();
    for rel in String::from_utf8(out.stdout).unwrap().lines() {
        let dir = Path::new(rel).parent().unwrap().to_str().unwrap();
        let store = MIGRATION_DIRS
            .iter()
            .find(|(d, _)| *d == dir)
            .map(|(_, s)| *s)
            .unwrap_or_else(|| {
                panic!("{rel}: SQL outside a known migration dir; add its store to the re-key")
            });
        match by_store.iter_mut().find(|(s, _)| *s == store) {
            Some((_, files)) => files.push(rel.to_string()),
            None => by_store.push((store, vec![rel.to_string()])),
        }
    }
    by_store
        .into_iter()
        .map(|(store, mut files)| {
            // Migrations apply in file-name order within their directory.
            files.sort_by_key(|f| Path::new(f).file_name().unwrap().to_owned());
            let texts: Vec<(String, String)> = files
                .iter()
                .map(|f| {
                    (
                        f.clone(),
                        std::fs::read_to_string(repo_root().join(f)).unwrap(),
                    )
                })
                .collect();
            (store, schema_from_sql(&texts))
        })
        .collect()
}

#[test]
fn drift_guard_every_sub_column_in_the_repo_is_in_the_rekey_map() {
    let schemas = repo_schemas();
    assert_eq!(
        schemas.len(),
        4,
        "server, iptv, media-core and recommender migrations"
    );
    let problems = drift(&schemas);
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    // The renames are followed: the live tables, not their _new staging names.
    let media = &schemas.iter().find(|(s, _)| *s == Store::Media).unwrap().1;
    assert!(media["media_watch_state"].contains("sub"));
    assert!(!media.contains_key("media_watch_state_new"));
    assert!(media["podcasts"].contains("owner_sub"));
}

#[test]
fn drift_guard_catches_a_new_sub_column_and_a_dropped_table() {
    let mut schemas = repo_schemas();
    let iptv = &mut schemas
        .iter_mut()
        .find(|(s, _)| *s == Store::Iptv)
        .unwrap()
        .1;
    let extra = schema_from_sql(&[(
        "0099.sql".into(),
        "CREATE TABLE IF NOT EXISTS dvr_owner (\n  id TEXT PRIMARY KEY,\n  owner_sub TEXT -- who\n);\n\
         ALTER TABLE dvr_owner ADD COLUMN sub TEXT;"
            .into(),
    )]);
    iptv.extend(extra);
    iptv.remove("iptv_favorites");
    let problems = drift(&schemas);
    assert_eq!(problems.len(), 3, "{problems:?}");
    assert!(problems.iter().any(|p| p.contains("dvr_owner.owner_sub")));
    assert!(problems.iter().any(|p| p.contains("dvr_owner.sub")));
    assert!(
        problems
            .iter()
            .any(|p| p.contains("iptv_favorites.sub, which no migration"))
    );
}

#[test]
fn the_sql_reader_follows_renames_drops_and_column_renames() {
    let t = schema_from_sql(&[(
        "x.sql".into(),
        "CREATE TABLE a (sub TEXT, n INT, PRIMARY KEY (sub, n));\n\
         CREATE TABLE b_new(x TEXT, UNIQUE (x)); ALTER TABLE b_new RENAME TO b;\n\
         ALTER TABLE b RENAME COLUMN x TO x_sub;\n\
         CREATE TABLE gone (sub TEXT); DROP TABLE IF EXISTS gone;"
            .into(),
    )]);
    assert_eq!(t.keys().collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(t["a"].iter().collect::<Vec<_>>(), ["n", "sub"]);
    assert_eq!(t["b"].iter().collect::<Vec<_>>(), ["x_sub"]);
}

// --- argument checks --------------------------------------------------------

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn it_refuses_the_same_sub_a_malformed_sub_and_no_store() {
    let err = |a: &[&str]| parse_args(&args(a)).err().unwrap();
    assert!(err(&["--from", FROM, "--to", FROM, "--data-dir", "d"]).contains("equals"));
    assert!(err(&["--from", FROM, "--to", "plex:01", "--data-dir", "d"]).contains("--to"));
    assert!(err(&["--from", "1001", "--to", TO, "--data-dir", "d"]).contains("--from"));
    assert!(err(&["--from", FROM, "--to", TO]).contains("no store"));
    assert!(err(&["--from", FROM, "--to", TO, "--bogus", "x"]).contains("unknown flag"));
    assert!(err(&["--from", FROM, "--to"]).contains("needs a value"));
}

#[test]
fn it_warns_for_a_local_target_and_defaults_to_a_dry_run() {
    let (o, warnings) = parse_args(&args(&[
        "--from",
        FROM,
        "--to",
        "local:01HZY3Q6D0AXTW5V6XWXQ2B3C4",
        "--server-db",
        "s.db",
    ]))
    .unwrap();
    assert!(!o.apply);
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("nothing can sign in as local:"));
    let (o, warnings) = parse_args(&args(&[
        "--from",
        FROM,
        "--to",
        TO,
        "--data-dir",
        "d",
        "--apply",
    ]))
    .unwrap();
    assert!(o.apply && warnings.is_empty());
}

// --- fixture databases from the real migrations -----------------------------

async fn pool(path: &Path) -> SqlitePool {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap()
}

/// server.db through auth's own opener; the others through the media-core
/// migrator over the store's migration files, as their services run them.
async fn build(store: Store, path: &Path) -> SqlitePool {
    if store == Store::Server {
        return crate::db::open(path.to_str().unwrap()).await.unwrap();
    }
    let (dir, _) = MIGRATION_DIRS
        .iter()
        .find(|(d, s)| *s == store && repo_root().join(d).is_dir())
        .unwrap();
    let mut files: Vec<PathBuf> = std::fs::read_dir(repo_root().join(dir))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "sql"))
        .collect();
    files.sort();
    let owned: Vec<(i64, String, String)> = files
        .iter()
        .map(|p| {
            let stem = p.file_stem().unwrap().to_str().unwrap().to_string();
            let version = stem.split('_').next().unwrap().parse().unwrap();
            (version, stem, std::fs::read_to_string(p).unwrap())
        })
        .collect();
    let migrations: Vec<(i64, &str, &str)> = owned
        .iter()
        .map(|(v, n, s)| (*v, n.as_str(), s.as_str()))
        .collect();
    let db = pool(path).await;
    if store == Store::Recommender {
        // recommender::db creates the vec0 table before the .sql files
        // (0007 deletes from it); a plain stand-in serves the same purpose.
        sqlx::query("CREATE TABLE title_vec (kind TEXT)")
            .execute(&db)
            .await
            .unwrap();
    }
    media_core::db::migrate(&db, &migrations, false)
        .await
        .unwrap();
    if store == Store::Recommender {
        // Then swap in a real vec0 definition, which this sqlite cannot load:
        // the re-key and its VACUUM INTO must not need the module.
        sqlx::raw_sql(
            "DROP TABLE title_vec; PRAGMA writable_schema = ON; \
             INSERT INTO sqlite_schema (type, name, tbl_name, rootpage, sql) VALUES \
             ('table', 'title_vec', 'title_vec', 0, \
              'CREATE VIRTUAL TABLE title_vec USING vec0(embedding float[384], kind TEXT partition key)'); \
             PRAGMA writable_schema = OFF;",
        )
        .execute(&db)
        .await
        .unwrap();
        let vtab = rows(
            &db,
            "SELECT sql FROM sqlite_schema WHERE name = 'title_vec'",
        )
        .await;
        assert!(vtab[0].starts_with("CREATE VIRTUAL TABLE"), "{vtab:?}");
    }
    db
}

async fn exec(db: &SqlitePool, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .unwrap();
}

async fn rows(db: &SqlitePool, sql: &str) -> Vec<String> {
    sqlx::query_scalar(AssertSqlSafe(sql.to_string()))
        .fetch_all(db)
        .await
        .unwrap()
}

/// Real columns that hold a sub, read back from a built database.
async fn introspect_sub_columns(db: &SqlitePool) -> Vec<(String, String)> {
    let tables = rows(
        db,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'",
    )
    .await;
    let mut out = Vec::new();
    for t in tables {
        let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info(?)")
            .bind(&t)
            .fetch_all(db)
            .await
            .unwrap();
        out.extend(
            cols.into_iter()
                .filter(|c| is_sub_column(c))
                .map(|c| (t.clone(), c)),
        );
    }
    out
}

fn seed_sql(store: Store) -> String {
    let sql = match store {
        Store::Server => {
            "INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at) VALUES
               ('FROM', 'Owner (Plex)', 'admin', 'plex', NULL, '2026-01-01T00:00:00.000Z', NULL),
               ('TO', 'Owner', 'user', 'workos', 'FROM', '2026-09-01T00:00:00.000Z', NULL),
               ('OTHER', 'Kid', 'user', 'google', 'FROM', '2026-02-01T00:00:00.000Z', NULL);
             INSERT INTO invites (code_hash, issued_by, label, expires_at, max_uses, used_count, created_at) VALUES
               ('h1', 'FROM', 'mine', NULL, 1, 0, '2026-01-02'),
               ('h2', 'OTHER', 'theirs', NULL, 1, 0, '2026-01-02');
             INSERT INTO device_tokens (jti, sub, device_id, device_name, platform, server_id, issued_at, expires_at) VALUES
               ('j1', 'FROM', 'd1', 'Apple TV', 'tvos', 's', '2026-01-01', '2027-01-01'),
               ('j2', 'FROM', 'd2', 'iPhone', 'ios', 's', '2026-01-01', '2027-01-01'),
               ('j3', 'OTHER', 'd3', 'iPad', 'ios', 's', '2026-01-01', '2027-01-01');
             INSERT INTO device_token_revocations (jti, revoked_at, reason) VALUES ('j2', '2026-05-05', 'self_revoke');
             INSERT INTO device_link_codes (code, device_id, device_name, device_platform, created_at, expires_at, claimed_sub) VALUES
               ('CODEFROM', 'd9', 'TV', 'tvos', 1, 2, 'FROM'),
               ('CODEOTHR', 'd8', 'TV', 'tvos', 1, 2, 'OTHER'),
               ('CODEOPEN', 'd7', 'TV', 'tvos', 1, 2, NULL);
             INSERT INTO user_api_keys (sub, ciphertext, updated_at) VALUES
               ('FROM', 'NODE_CIPHERTEXT', '2026-03-03'),
               ('OTHER', 'b3RoZXI=', '2026-03-03');"
        }
        Store::Iptv => {
            "INSERT INTO iptv_favorites (sub, kind, item_id, added_ts) VALUES
               ('FROM', 'live', '1', 'f1'), ('FROM', 'live', '2', 'f2'),
               ('TO', 'live', '2', 'target'), ('OTHER', 'live', '1', 'o1');
             INSERT INTO iptv_watch_history (sub, kind, item_id, position_secs, watched_at) VALUES
               ('FROM', 'vod', '9', 120, '2026-04-04');
             INSERT INTO iptv_playlist_tokens (jti, sub, issued_at, expires_at, revoked_at) VALUES
               ('p1', 'FROM', '2026-01-01', '2027-01-01', NULL),
               ('p2', 'FROM', '2026-01-01', '2027-01-01', '2026-02-02T00:00:00.000Z'),
               ('p3', 'OTHER', '2026-01-01', '2027-01-01', NULL);"
        }
        Store::Media => {
            "INSERT INTO media_watch_state (sub, media_kind, media_id, position_secs, watched_at) VALUES
               ('FROM', 'movie', 1, 10, 'w1'), ('FROM', 'movie', 2, 20, 'w2'),
               ('TO', 'movie', 2, 99, 'target'), ('OTHER', 'movie', 1, 5, 'o');
             INSERT INTO playlists (id, sub, name, created_at, updated_at) VALUES
               (1, 'FROM', 'Favs', 'c', 'u'), (2, 'FROM', 'Road', 'c', 'u'), (3, 'TO', 'Favs', 'c', 'u');
             INSERT INTO playlist_items (playlist_id, media_kind, media_id, position, added_at) VALUES (1, 'movie', 1, 0, 'a');
             INSERT INTO collections (id, sub, name, created_at, updated_at) VALUES (1, 'FROM', 'Kids', 'c', 'u');
             INSERT INTO podcasts (id, feed_url, title, added_at, owner_sub) VALUES
               (1, 'https://feed.invalid/a', 'Pod', 'a', 'FROM'), (2, 'https://feed.invalid/b', 'Pod2', 'a', NULL);"
        }
        Store::Recommender => {
            "INSERT INTO user_feedback (sub, kind, tmdb_id, signal, ts) VALUES
               ('FROM', 'movie', 10, 'like', 't'), ('FROM', 'movie', 11, 'dislike', 't'),
               ('TO', 'movie', 11, 'dislike', 'target'), ('OTHER', 'movie', 10, 'like', 'o');
             INSERT INTO recently_shown (sub, kind, tmdb_id, ts) VALUES ('FROM', 'movie', 10, 't');
             INSERT INTO rec_log (id, sub, kind, tmdb_id, rank, score, provenance, model_version, ts) VALUES
               (1, 'FROM', 'movie', 10, 1, 0.9, 'p', 'v1', 't'), (2, 'OTHER', 'movie', 10, 1, 0.9, 'p', 'v1', 't');
             INSERT INTO rec_outcomes (rec_id, outcome, ts) VALUES (1, 'clicked', 't');"
        }
    };
    sql.replace("'FROM'", &format!("'{FROM}'"))
        .replace("'TO'", &format!("'{TO}'"))
        .replace("'OTHER'", &format!("'{OTHER}'"))
        .replace("NODE_CIPHERTEXT", NODE_CIPHERTEXT)
}

fn seed_data_dir(dir: &Path) {
    let w = |name: &str, text: String| std::fs::write(dir.join(name), text).unwrap();
    let subs = |s: &str| {
        s.replace("FROM", FROM)
            .replace("TO", TO)
            .replace("OTHER", OTHER)
    };
    w(
        "user-feedback.json",
        subs(
            r#"{
  "FROM": { "movie": { "liked": [{"id": 1, "title": "A"}, {"id": 2, "title": "B"}], "disliked": [] },
          "tv": { "liked": [], "disliked": [{"id": 5, "title": "T"}] } },
  "TO": { "movie": { "liked": [], "disliked": [{"id": 2, "title": "B"}] }, "tv": { "liked": [], "disliked": [] } },
  "OTHER": { "movie": { "liked": [{"id": 1, "title": "A"}], "disliked": [] }, "tv": { "liked": [], "disliked": [] } }
}
"#,
        ),
    );
    w(
        "user-watchlist.json",
        subs(
            r#"{
  "FROM": { "movie": [{"id": 1, "title": "A", "added_at": "s1"}, {"id": 3, "title": "C", "added_at": "s3"}],
          "tv": [{"id": 1, "title": "Show", "added_at": "s4"}] },
  "TO": { "movie": [{"id": 3, "title": "C", "added_at": "target"}], "tv": [] }
}
"#,
        ),
    );
    w(
        "user-policies.json",
        subs(
            r#"{ "FROM": { "maxRating": "R", "kid": false }, "OTHER": { "maxRating": "PG", "kid": true } }
"#,
        ),
    );
    w(
        "usage.jsonl",
        subs(concat!(
            r#"{"ts":"1","sub":"FROM","username":"owner","type":"claude_call","model":"m","kind":"movie"}"#,
            "\n",
            r#"{"ts":"2","sub":"OTHER","username":"kid","type":"claude_call","model":"m","kind":"tv"}"#,
            "\n",
            r#"{"ts":"3","sub":"FROM","user"#,
            "\n",
        )),
    );
    w(
        "grabs.jsonl",
        subs(concat!(
            r#"{"ts":"1","type":"grabbed","title":"X","sub":"FROM"}"#,
            "\n",
            r#"{"ts":"2","type":"grabbed","title":"legacy, no sub"}"#,
            "\n",
        )),
    );
    w(
        "grabs.jsonl.1",
        subs(concat!(
            r#"{"ts":"0","type":"grabbed","sub":"FROM","title":"Y"}"#,
            "\n"
        )),
    );
}

/// sha256 of every file under `dir`.
fn hashes(dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file())
        .map(|p| {
            let digest = Sha256::digest(std::fs::read(&p).unwrap());
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                format!("{digest:x}"),
            )
        })
        .collect()
}

struct Fixture {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    secret: PathBuf,
}

impl Fixture {
    async fn new() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("stores");
        std::fs::create_dir(&dir).unwrap();
        for store in [Store::Server, Store::Iptv, Store::Media, Store::Recommender] {
            let db = build(store, &dir.join(file_of(store))).await;
            // The real schema has no sub column the map misses.
            for (t, c) in introspect_sub_columns(&db).await {
                assert!(
                    MAP.iter()
                        .any(|e| e.store == store && e.table == t && e.column == c),
                    "{}: {t}.{c} is not in rekey::MAP",
                    store.name()
                );
            }
            exec(&db, &seed_sql(store)).await;
            db.close().await;
        }
        seed_data_dir(&dir);
        let secret = tmp.path().join("session-secret");
        std::fs::write(&secret, format!("{SECRET}\n")).unwrap();
        Fixture {
            _tmp: tmp,
            dir,
            secret,
        }
    }

    fn opts(&self, apply: bool, secret: bool) -> Opts {
        let p = |s: Store| Some(self.dir.join(file_of(s)));
        Opts {
            from: FROM.into(),
            to: TO.into(),
            apply,
            server_db: p(Store::Server),
            iptv_db: p(Store::Iptv),
            media_db: p(Store::Media),
            recommender_db: p(Store::Recommender),
            data_dir: Some(self.dir.clone()),
            session_secret_file: secret.then(|| self.secret.clone()),
        }
    }

    async fn db(&self, store: Store) -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(self.dir.join(file_of(store))))
            .await
            .unwrap()
    }

    fn json(&self, name: &str) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.dir.join(name)).unwrap()).unwrap()
    }
}

fn file_of(store: Store) -> &'static str {
    match store {
        Store::Server => "server.db",
        Store::Iptv => "iptv.db",
        Store::Media => "media.db",
        Store::Recommender => "exchange.db",
    }
}

#[tokio::test]
async fn dry_run_writes_nothing_apply_moves_everything_and_a_second_apply_changes_nothing() {
    let f = Fixture::new().await;
    let before = hashes(&f.dir);

    // Dry run: exact counts, every file byte-identical, no new files.
    let dry = run(&f.opts(false, true)).await.unwrap();
    assert_eq!(hashes(&f.dir), before, "a dry run changed a file");

    let applied = run(&f.opts(true, true)).await.unwrap();
    // The dry run predicted exactly what the apply did.
    assert_eq!(dry[1..], applied[1..]);
    let text = applied.join("\n");
    for line in [
        "  members.sub moved to target: 1",
        "  members.sub source revoked: 1",
        "  members.invited_by moved: 2",
        "  invites.issued_by moved: 1",
        "  device_tokens.sub tokens revoked: 1",
        "  device_link_codes.claimed_sub deleted: 1",
        "  user_api_keys.sub re-encrypted for target: 1",
        "  iptv_favorites.sub moved: 1",
        "  iptv_favorites.sub dropped (target already had it): 1",
        "  iptv_playlist_tokens.sub tokens revoked: 1",
        "  playlists.sub moved: 1",
        "  playlists.sub moved with a renamed name clash: 1",
        "  rec_log.sub moved: 1",
        "  lines rewritten: 1",
    ] {
        assert!(text.contains(line), "missing {line:?} in\n{text}");
    }

    // Every SQLite file and every changed data file has one backup.
    let after = hashes(&f.dir);
    let backups: Vec<&String> = after.keys().filter(|k| k.contains(".pre-rekey-")).collect();
    assert_eq!(backups.len(), 4 + 6, "{backups:?}");
    let server_backup = backups
        .iter()
        .find(|b| b.starts_with("server.db."))
        .unwrap();
    let snap = SqlitePoolOptions::new()
        .connect_with(
            SqliteConnectOptions::new()
                .filename(f.dir.join(server_backup))
                .read_only(true),
        )
        .await
        .unwrap();
    let live: Vec<String> = rows(
        &snap,
        &format!("SELECT sub FROM members WHERE sub = '{FROM}' AND revoked_at IS NULL"),
    )
    .await;
    assert_eq!(live, [FROM], "the backup is the pre-re-key state");
    snap.close().await;

    check_server(&f).await;
    check_iptv(&f).await;
    check_media(&f).await;
    check_recommender(&f).await;
    check_data_dir(&f);

    // A second apply finds nothing: no file changes, no new backup.
    let again = run(&f.opts(true, true)).await.unwrap();
    assert_eq!(hashes(&f.dir), after, "a second --apply changed a file");
    let counts = again
        .iter()
        .filter(|l| l.starts_with("  ") && *l != "  (absent)");
    assert!(counts.clone().count() > 20);
    assert!(counts.into_iter().all(|l| l.ends_with(": 0")), "{again:?}");
}

async fn check_server(f: &Fixture) {
    let db = f.db(Store::Server).await;
    let q = |sql: String| {
        let db = db.clone();
        async move { rows(&db, &sql).await }
    };
    // The target keeps its own name and join date, gains admin; the source is
    // revoked and kept.
    assert_eq!(
        q(format!(
            "SELECT display_name || '|' || role || '|' || auth_mode || '|' || joined_at || '|' || COALESCE(revoked_at, '-') \
             FROM members WHERE sub = '{TO}'"
        ))
        .await,
        ["Owner|admin|workos|2026-09-01T00:00:00.000Z|-"]
    );
    assert_eq!(
        q(format!(
            "SELECT role FROM members WHERE sub = '{FROM}' AND revoked_at IS NOT NULL"
        ))
        .await,
        ["admin"]
    );
    assert_eq!(
        q(format!(
            "SELECT sub FROM members WHERE invited_by = '{TO}' ORDER BY sub"
        ))
        .await,
        [OTHER, TO]
    );
    assert_eq!(
        q("SELECT issued_by FROM invites ORDER BY code_hash".into()).await,
        [TO, OTHER]
    );
    assert_eq!(
        q("SELECT jti || ':' || reason FROM device_token_revocations ORDER BY jti".into()).await,
        ["j1:rekey", "j2:self_revoke"]
    );
    assert_eq!(
        q("SELECT code FROM device_link_codes ORDER BY code".into()).await,
        ["CODEOPEN", "CODEOTHR"]
    );
    let keys: Vec<(String, String)> =
        sqlx::query_as("SELECT sub, ciphertext FROM user_api_keys ORDER BY sub")
            .fetch_all(&db)
            .await
            .unwrap();
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0], (OTHER.to_string(), "b3RoZXI=".to_string()));
    let cipher = api_key_cipher(SECRET.as_bytes());
    assert_eq!(keys[1].0, TO);
    assert_eq!(
        decrypt_api_key(&cipher, TO, &keys[1].1).as_deref(),
        Some("sk-ant-test-key-1234")
    );
    assert_eq!(
        decrypt_api_key(&cipher, FROM, &keys[1].1),
        None,
        "bound to the new sub"
    );
    db.close().await;
}

async fn check_iptv(f: &Fixture) {
    let db = f.db(Store::Iptv).await;
    assert_eq!(
        rows(&db, "SELECT sub || '|' || item_id || '|' || added_ts FROM iptv_favorites ORDER BY sub, item_id").await,
        [format!("{OTHER}|1|o1"), format!("{TO}|1|f1"), format!("{TO}|2|target")]
    );
    assert_eq!(rows(&db, "SELECT sub FROM iptv_watch_history").await, [TO]);
    assert_eq!(
        rows(&db, "SELECT jti || '|' || sub || '|' || COALESCE(revoked_at, '-') FROM iptv_playlist_tokens ORDER BY jti")
            .await
            .iter()
            .map(|r| r.split('|').map(|p| if p.len() == 24 { "NOW" } else { p }).collect::<Vec<_>>().join("|"))
            .collect::<Vec<_>>(),
        [
            format!("p1|{FROM}|NOW"),
            format!("p2|{FROM}|NOW"),
            format!("p3|{OTHER}|-")
        ]
    );
    // p2's original revocation time is untouched.
    assert_eq!(
        rows(
            &db,
            "SELECT revoked_at FROM iptv_playlist_tokens WHERE jti = 'p2'"
        )
        .await,
        ["2026-02-02T00:00:00.000Z"]
    );
    db.close().await;
}

async fn check_media(f: &Fixture) {
    let db = f.db(Store::Media).await;
    assert_eq!(
        rows(&db, "SELECT sub || '|' || media_id || '|' || position_secs FROM media_watch_state ORDER BY sub, media_id").await,
        [format!("{OTHER}|1|5"), format!("{TO}|1|10"), format!("{TO}|2|99")]
    );
    assert_eq!(
        rows(
            &db,
            "SELECT id || '|' || sub || '|' || name FROM playlists ORDER BY id"
        )
        .await,
        [
            format!("1|{TO}|Favs #1"),
            format!("2|{TO}|Road"),
            format!("3|{TO}|Favs")
        ]
    );
    assert_eq!(
        rows(&db, "SELECT CAST(playlist_id AS TEXT) FROM playlist_items").await,
        ["1"]
    );
    assert_eq!(rows(&db, "SELECT sub FROM collections").await, [TO]);
    assert_eq!(
        rows(
            &db,
            "SELECT COALESCE(owner_sub, '-') FROM podcasts ORDER BY id"
        )
        .await,
        [TO, "-"]
    );
    db.close().await;
}

async fn check_recommender(f: &Fixture) {
    let db = f.db(Store::Recommender).await;
    assert_eq!(
        rows(&db, "SELECT sub || '|' || tmdb_id || '|' || signal || '|' || ts FROM user_feedback ORDER BY sub, tmdb_id").await,
        [
            format!("{OTHER}|10|like|o"),
            format!("{TO}|10|like|t"),
            format!("{TO}|11|dislike|target")
        ]
    );
    assert_eq!(rows(&db, "SELECT sub FROM recently_shown").await, [TO]);
    assert_eq!(
        rows(&db, "SELECT sub FROM rec_log ORDER BY id").await,
        [TO, OTHER]
    );
    assert_eq!(
        rows(&db, "SELECT CAST(rec_id AS TEXT) FROM rec_outcomes").await,
        ["1"]
    );
    db.close().await;
}

fn check_data_dir(f: &Fixture) {
    let fb = f.json("user-feedback.json");
    assert!(fb.get(FROM).is_none());
    assert_eq!(fb[TO]["movie"]["liked"], json!([{"id": 1, "title": "A"}]));
    // The target disliked 2; the source's like of it does not override that.
    assert_eq!(
        fb[TO]["movie"]["disliked"],
        json!([{"id": 2, "title": "B"}])
    );
    assert_eq!(fb[TO]["tv"]["disliked"], json!([{"id": 5, "title": "T"}]));
    assert_eq!(
        fb[OTHER]["movie"]["liked"],
        json!([{"id": 1, "title": "A"}])
    );

    let wl = f.json("user-watchlist.json");
    assert!(wl.get(FROM).is_none());
    assert_eq!(
        wl[TO]["movie"],
        json!([{"id": 3, "title": "C", "added_at": "target"}, {"id": 1, "title": "A", "added_at": "s1"}])
    );
    assert_eq!(
        wl[TO]["tv"],
        json!([{"id": 1, "title": "Show", "added_at": "s4"}])
    );

    let pol = f.json("user-policies.json");
    assert_eq!(
        pol,
        json!({ TO: {"maxRating": "R", "kid": false}, OTHER: {"maxRating": "PG", "kid": true} })
    );
    let raw = std::fs::read_to_string(f.dir.join("user-policies.json")).unwrap();
    assert!(
        raw.ends_with("}\n") && raw.contains("\n  \""),
        "written like JSON.stringify(_, null, 2)"
    );

    let usage = std::fs::read_to_string(f.dir.join("usage.jsonl")).unwrap();
    assert_eq!(
        usage,
        format!(
            "{{\"ts\":\"1\",\"sub\":\"{TO}\",\"username\":\"owner\",\"type\":\"claude_call\",\"model\":\"m\",\"kind\":\"movie\"}}\n\
             {{\"ts\":\"2\",\"sub\":\"{OTHER}\",\"username\":\"kid\",\"type\":\"claude_call\",\"model\":\"m\",\"kind\":\"tv\"}}\n\
             {{\"ts\":\"3\",\"sub\":\"{FROM}\",\"user\n"
        ),
        "only the parsed source line changes, byte for byte otherwise; a torn line is kept"
    );
    let grabs = std::fs::read_to_string(f.dir.join("grabs.jsonl")).unwrap();
    assert!(grabs.contains(TO) && !grabs.contains(FROM) && grabs.contains("legacy, no sub"));
    let rotated = std::fs::read_to_string(f.dir.join("grabs.jsonl.1")).unwrap();
    assert_eq!(
        rotated,
        format!("{{\"ts\":\"0\",\"type\":\"grabbed\",\"sub\":\"{TO}\",\"title\":\"Y\"}}\n")
    );
    assert!(!f.dir.join("usage.jsonl.1").exists());
}

// --- server.db cases --------------------------------------------------------

/// 'FROM' / 'TO' (quoted, so INSERT INTO survives) and NODE_CIPHERTEXT.
fn subs_in(sql: &str) -> String {
    sql.replace("'FROM'", &format!("'{FROM}'"))
        .replace("'TO'", &format!("'{TO}'"))
        .replace("NODE_CIPHERTEXT", NODE_CIPHERTEXT)
}

async fn server_with(seed: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("server.db");
    let db = build(Store::Server, &path).await;
    exec(&db, &subs_in(seed)).await;
    db.close().await;
    (tmp, path)
}

async fn server_rows(path: &Path, sql: &str) -> Vec<String> {
    let db = SqlitePoolOptions::new()
        .connect_with(SqliteConnectOptions::new().filename(path))
        .await
        .unwrap();
    let out = rows(&db, &subs_in(sql)).await;
    db.close().await;
    out
}

#[tokio::test]
async fn a_missing_target_member_is_created_from_the_source_with_its_own_auth_mode() {
    let (_t, path) = server_with(
        "INSERT INTO members VALUES ('FROM', 'Owner', 'admin', 'plex', NULL, '2026-01-01T00:00:00.000Z', NULL);",
    )
    .await;
    rekey_db(&path, Store::Server, FROM, TO, None, true)
        .await
        .unwrap();
    assert_eq!(
        server_rows(&path, "SELECT display_name || '|' || role || '|' || auth_mode || '|' || joined_at FROM members WHERE sub = 'TO' AND revoked_at IS NULL").await,
        ["Owner|admin|workos|2026-01-01T00:00:00.000Z"]
    );
}

#[tokio::test]
async fn a_live_source_unrevokes_the_target_and_a_revoked_source_passes_nothing_on() {
    let (_t, path) = server_with(
        "INSERT INTO members VALUES ('FROM', NULL, 'user', 'plex', NULL, 'j', NULL),
                                    ('TO', NULL, 'user', 'workos', NULL, 'j', '2026-05-05T00:00:00.000Z');",
    )
    .await;
    rekey_db(&path, Store::Server, FROM, TO, None, true)
        .await
        .unwrap();
    assert_eq!(
        server_rows(
            &path,
            "SELECT role || '|' || COALESCE(revoked_at, '-') FROM members WHERE sub = 'TO'"
        )
        .await,
        ["user|-"]
    );

    let (_t, path) = server_with(
        "INSERT INTO members VALUES ('FROM', NULL, 'admin', 'plex', NULL, 'j', '2026-05-05T00:00:00.000Z'),
                                    ('TO', NULL, 'user', 'workos', NULL, 'j', NULL);",
    )
    .await;
    let counts = rekey_db(&path, Store::Server, FROM, TO, None, true)
        .await
        .unwrap();
    assert_eq!(
        server_rows(
            &path,
            "SELECT role FROM members WHERE sub = 'TO' AND revoked_at IS NULL"
        )
        .await,
        ["user"]
    );
    assert!(!changes(&counts), "{counts:?}");

    // A target that already has the access gets no write (and no count).
    let (_t, path) = server_with(
        "INSERT INTO members VALUES ('FROM', NULL, 'admin', 'plex', NULL, 'j', NULL),
                                    ('TO', NULL, 'admin', 'workos', NULL, 'j', NULL);",
    )
    .await;
    let counts = rekey_db(&path, Store::Server, FROM, TO, None, true)
        .await
        .unwrap();
    assert_eq!(counts[0], ("members.sub moved to target".to_string(), 0));
    assert_eq!(counts[1], ("members.sub source revoked".to_string(), 1));
}

#[tokio::test]
async fn the_api_key_is_deleted_without_the_secret_with_a_wrong_secret_or_when_the_target_has_one()
{
    let seed = "INSERT INTO user_api_keys VALUES ('FROM', 'NODE_CIPHERTEXT', 'u');";
    let (_t, path) = server_with(seed).await;
    rekey_db(&path, Store::Server, FROM, TO, None, true)
        .await
        .unwrap();
    assert!(
        server_rows(&path, "SELECT sub FROM user_api_keys")
            .await
            .is_empty()
    );

    let (_t, path) = server_with(seed).await;
    let wrong = api_key_cipher(b"some-other-session-secret-0123456789abcdef");
    rekey_db(&path, Store::Server, FROM, TO, Some(&wrong), true)
        .await
        .unwrap();
    assert!(
        server_rows(&path, "SELECT sub FROM user_api_keys")
            .await
            .is_empty()
    );

    let (_t, path) = server_with(&format!(
        "{seed} INSERT INTO user_api_keys VALUES ('TO', 'dGFyZ2V0', 'u');"
    ))
    .await;
    let right = api_key_cipher(SECRET.as_bytes());
    rekey_db(&path, Store::Server, FROM, TO, Some(&right), true)
        .await
        .unwrap();
    assert_eq!(
        server_rows(&path, "SELECT sub || '|' || ciphertext FROM user_api_keys").await,
        [format!("{TO}|dGFyZ2V0")]
    );
}

#[test]
fn the_node_ciphertext_round_trips_through_the_rust_layout() {
    let cipher = api_key_cipher(SECRET.as_bytes());
    assert_eq!(
        decrypt_api_key(&cipher, FROM, NODE_CIPHERTEXT).as_deref(),
        Some("sk-ant-test-key-1234")
    );
    let again = encrypt_api_key(&cipher, OTHER, "sk-ant-x");
    assert_eq!(
        decrypt_api_key(&cipher, OTHER, &again).as_deref(),
        Some("sk-ant-x")
    );
    assert_eq!(decrypt_api_key(&cipher, FROM, &again), None);
}

// --- data-dir cases ---------------------------------------------------------

#[test]
fn a_jsonl_line_whose_sub_cannot_be_rewritten_in_place_stops_the_run() {
    let line = format!("{{\"sub\":\"{FROM}\",\"meta\":{{\"sub\":\"{FROM}\"}}}}\n");
    let err = rekey_jsonl(&line, FROM, TO).unwrap_err();
    assert!(err.contains("line 1"), "{err}");
    // A nested sub on another member's line is not the top-level sub: kept.
    let other = format!("{{\"sub\":\"{OTHER}\",\"meta\":{{\"sub\":\"{FROM}\"}}}}\n");
    assert_eq!(rekey_jsonl(&other, FROM, TO).unwrap(), (None, 0));
}

#[test]
fn a_json_map_without_the_source_is_left_alone_and_a_non_object_is_an_error() {
    let text = format!("{{\"{OTHER}\": {{}}}}\n");
    assert_eq!(
        rekey_json_map(&text, FROM, TO, JsonKind::Watchlist).unwrap(),
        (None, 0, 0)
    );
    assert!(rekey_json_map("[]", FROM, TO, JsonKind::Policies).is_err());
    // A policy the target already has wins.
    let both = format!("{{\"{FROM}\": {{\"kid\": true}}, \"{TO}\": {{\"kid\": false}}}}");
    let (new, moved, dropped) = rekey_json_map(&both, FROM, TO, JsonKind::Policies).unwrap();
    assert_eq!((moved, dropped), (0, 1));
    assert_eq!(
        serde_json::from_str::<Value>(&new.unwrap()).unwrap(),
        json!({ TO: {"kid": false} })
    );
}

#[tokio::test]
async fn a_missing_data_file_is_reported_absent_and_a_missing_db_is_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    let plans = plan_data_dir(tmp.path(), FROM, TO).unwrap();
    assert_eq!(plans.len(), 7);
    assert!(
        plans
            .iter()
            .all(|p| p.new_text.is_none() && p.counts.is_empty())
    );
    let err = rekey_db(
        &tmp.path().join("nope.db"),
        Store::Iptv,
        FROM,
        TO,
        None,
        false,
    )
    .await
    .unwrap_err();
    assert!(err.contains("nope.db"), "{err}");
    assert!(
        !tmp.path().join("nope.db").exists(),
        "never creates a store"
    );
}
