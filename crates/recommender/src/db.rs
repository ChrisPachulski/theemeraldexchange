//! exchange.db: pool, sqlite-vec, migrations and the small helpers the Python
//! `app/db.py` shared across recipes (vec rowid encoding, f32 blobs, the genre
//! aggregate, table generations, timestamps).

use std::sync::Once;

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};

use crate::{Error, Result};

macro_rules! migration {
    ($v:expr, $name:literal) => {
        (
            $v,
            $name,
            include_str!(concat!("../../../recommender/migrations/", $name, ".sql")),
        )
    };
}

/// The Python service's migration files, byte for byte, so the checksums equal
/// the ledger prod already holds.
pub const MIGRATIONS: &[(i64, &str, &str)] = &[
    migration!(1, "0001_initial"),
    migration!(2, "0002_rec_log_ts_index"),
    migration!(3, "0003_rec_log_datetime_ts_index"),
    migration!(4, "0004_rec_outcomes_datetime_ts_index"),
    migration!(5, "0005_iptv_kinds"),
    migration!(6, "0006_namespace_sub"),
    migration!(7, "0007_drop_iptv_kinds"),
    migration!(8, "0008_user_feedback_watched"),
];

/// MiniLM-L6 output width.
pub const EMBED_DIM: usize = 384;

/// The ledger table exactly as the Python migrator created it (media_core's own
/// CREATE IF NOT EXISTS is then a no-op), so a fresh DB's schema matches.
const LEDGER_DDL: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (
              version    INTEGER NOT NULL PRIMARY KEY,
              applied_at TEXT,
              checksum   TEXT    NOT NULL
            )";

/// Created before the .sql files run: 0007 deletes from it.
const VEC_TABLE_DDL: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS title_vec USING vec0(
  rowid         INTEGER PRIMARY KEY,
  kind          TEXT    PARTITION KEY,
  embedding     float[384] distance_metric=cosine
)";

/// Correlated genre aggregate shared by every title SELECT (titles aliased `t`):
/// a comma-joined, genre_id-ordered `genres` column.
pub const GENRE_AGG_SQL: &str = "(SELECT GROUP_CONCAT(genre_id) FROM (
                     SELECT g.genre_id FROM title_genres g
                     WHERE g.kind = t.kind AND g.tmdb_id = t.tmdb_id
                     ORDER BY g.genre_id
                   )) AS genres";

/// Register sqlite-vec on every connection this process opens.
fn register_sqlite_vec() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        type EntryPoint = unsafe extern "C" fn(
            *mut libsqlite3_sys::sqlite3,
            *mut *mut std::ffi::c_char,
            *const libsqlite3_sys::sqlite3_api_routines,
        ) -> std::ffi::c_int;
        // SAFETY: sqlite3_vec_init is the extension entry point with exactly
        // this C signature (the crate declares it as `fn()`), compiled with
        // SQLITE_CORE against the sqlite libsqlite3-sys links.
        let rc = unsafe {
            let init: EntryPoint = std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
            libsqlite3_sys::sqlite3_auto_extension(Some(init))
        };
        assert_eq!(
            rc,
            libsqlite3_sys::SQLITE_OK,
            "sqlite3_auto_extension failed"
        );
    });
}

/// Open (creating if needed) and migrate. The Python per-connection PRAGMAs:
/// WAL, busy_timeout 5000, synchronous NORMAL, foreign keys, 256 MiB mmap,
/// temp_store MEMORY.
pub async fn open(path: &std::path::Path) -> Result<SqlitePool> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| {
            sqlx::Error::Configuration(format!("failed to create {}: {e}", parent.display()).into())
        })?;
    }
    register_sqlite_vec();
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5))
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .pragma("mmap_size", "268435456")
        .pragma("temp_store", "MEMORY");
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;
    migrate(
        &pool,
        MIGRATIONS,
        media_core::db::allow_checksum_mismatch_from_env(),
    )
    .await?;
    Ok(pool)
}

/// A snapshot copy, read-only and immutable (no migrations, no locks, no
/// -shm writes). Immutable mode skips the WAL, so a snapshot whose -wal still
/// holds pages is refused rather than read stale.
pub async fn open_snapshot(path: &std::path::Path) -> Result<SqlitePool> {
    let wal = path.with_file_name(format!(
        "{}-wal",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    if std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0) {
        return Err(sqlx::Error::Configuration(
            format!(
                "{} has a non-empty WAL; checkpoint it first",
                path.display()
            )
            .into(),
        )
        .into());
    }
    register_sqlite_vec();
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(true);
    Ok(SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(opts)
        .await?)
}

async fn migrate(
    pool: &SqlitePool,
    migrations: &[(i64, &str, &str)],
    allow_checksum_mismatch: bool,
) -> Result<()> {
    sqlx::query(LEDGER_DDL).execute(pool).await?;
    sqlx::query(VEC_TABLE_DDL).execute(pool).await?;
    media_core::db::migrate(pool, migrations, allow_checksum_mismatch).await?;
    Ok(())
}

// sqlite-vec's PARTITION KEY still needs a globally unique rowid, and a movie
// and a show can share a TMDB id: TV rows carry bit 32.
const KIND_BIT: i64 = 1 << 32;

pub fn encode_vec_rowid(kind: &str, tmdb_id: i64) -> Result<i64> {
    let tv = match kind {
        "movie" => false,
        "tv" => true,
        _ => return Err(Error::Invalid(format!("unknown kind: {kind:?}"))),
    };
    if tmdb_id >= KIND_BIT {
        return Err(Error::Invalid(format!(
            "tmdb_id too large for vec rowid encoding: {tmdb_id}"
        )));
    }
    Ok(if tv { tmdb_id | KIND_BIT } else { tmdb_id })
}

pub fn decode_vec_rowid(rowid: i64, expected_kind: Option<&str>) -> Result<(&'static str, i64)> {
    let kind = if rowid & KIND_BIT != 0 { "tv" } else { "movie" };
    if let Some(want) = expected_kind
        && want != kind
    {
        return Err(Error::Invalid(format!(
            "vec rowid kind mismatch: rowid={rowid} encodes {kind}, expected {want}"
        )));
    }
    Ok((kind, rowid & !KIND_BIT))
}

/// Native-endian f32s, as Python's `struct.pack("<n>f")` wrote them.
pub fn serialize_f32(vec: &[f32]) -> Vec<u8> {
    vec.iter().flat_map(|f| f.to_ne_bytes()).collect()
}

pub fn deserialize_f32(blob: &[u8], dim: Option<usize>) -> Result<Vec<f32>> {
    if !blob.len().is_multiple_of(4) {
        return Err(Error::Invalid(format!(
            "vector blob of {} bytes is not a whole number of f32s",
            blob.len()
        )));
    }
    let out: Vec<f32> = blob
        .chunks_exact(4)
        .map(|c| f32::from_ne_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    if let Some(dim) = dim
        && out.len() != dim
    {
        return Err(Error::Invalid(format!(
            "vector length {} != expected {dim}",
            out.len()
        )));
    }
    Ok(out)
}

/// One table's fingerprint: (COUNT(*), MAX(rowid), MAX(ts column) when asked).
pub type TableGeneration = (i64, i64, Option<String>);

/// Cheap fingerprint of catalog tables for cache invalidation. COUNT and
/// MAX(rowid) catch the DELETE+INSERT rehydration of cast/crew/genres; the
/// optional timestamp column catches in-place upserts of titles/features.
pub async fn table_generation(
    pool: &SqlitePool,
    tables: &[(&str, Option<&str>)],
) -> Result<Vec<TableGeneration>> {
    let ident = |s: &str| {
        let mut chars = s.chars();
        chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    let mut out = Vec::with_capacity(tables.len());
    for &(table, ts_col) in tables {
        if !ident(table) || ts_col.is_some_and(|c| !ident(c)) {
            return Err(Error::Invalid(format!(
                "invalid identifier in table_generation spec: ({table:?}, {ts_col:?})"
            )));
        }
        let ts = ts_col.map_or("NULL".to_string(), |c| format!("COALESCE(MAX({c}), '')"));
        let sql = format!("SELECT COUNT(*), COALESCE(MAX(rowid), 0), {ts} FROM {table}");
        // Both identifiers were checked against [A-Za-z_][A-Za-z0-9_]* above.
        out.push(
            sqlx::query_as(sqlx::AssertSqlSafe(sql))
                .fetch_one(pool)
                .await?,
        );
    }
    Ok(out)
}

/// `datetime.now(timezone.utc).isoformat(timespec="microseconds")`.
pub fn utc_now_iso() -> String {
    iso_micros(chrono::Utc::now())
}

fn iso_micros(t: chrono::DateTime<chrono::Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
}

#[cfg(test)]
mod tests;
