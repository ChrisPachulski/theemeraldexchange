use super::*;
use sqlx::sqlite::SqlitePoolOptions;

/// The ledger of the prod exchange.db (2026-10-08 snapshot, read with
/// immutable=1): 0005 carries the post-amnesty hash.
const PROD_LEDGER: [&str; 8] = [
    "bc3085e98a5941060f86c8c1eac0f267b4f907afe6fd9bd2296da5a99510a1d6",
    "48cffea53ed95b70b7a7250d5abace956773903d09036d1bed81ac86f21bb09b",
    "cce1559630fc02d4668f6089c3e6bd44fadd61136100d53a6464a1c2b90d1af7",
    "77b9d46dc2e4479d45a74333eead86fc033da55d5588349c4a73400cc830de1c",
    "e0e43a41fc581e05b405de2fe6ad45b4e6257fb2178c36a7c05cb2d0f045a6f4",
    "5c9ee8d0a1c5b4032b61b8f45ceb4fb1eceff23037ebca5573b2b31f79f7f951",
    "2db07504b4b05f6f1d022453d3e22311a873ec466307f6e983541198d29018e7",
    "4262f47b1ff707ed836bb03881150de805f187a54bb966f6b2d6b6cb986e36b4",
];

type SchemaRow = (String, String, String, Option<String>);

async fn schema(pool: &SqlitePool) -> Vec<SchemaRow> {
    sqlx::query_as("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn ledger(pool: &SqlitePool) -> Vec<(i64, String, String)> {
    sqlx::query_as(
        "SELECT version, checksum, COALESCE(applied_at, '') FROM schema_migrations ORDER BY version",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn fresh() -> (tempfile::TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("data/exchange.db")).await.unwrap();
    (dir, pool)
}

#[tokio::test]
async fn fresh_db_matches_prod_ledger_and_python_schema() {
    let (_dir, pool) = fresh().await;
    let rows = ledger(&pool).await;
    assert_eq!(
        rows.iter().map(|r| (r.0, r.1.as_str())).collect::<Vec<_>>(),
        PROD_LEDGER
            .iter()
            .enumerate()
            .map(|(i, h)| (i as i64 + 1, *h))
            .collect::<Vec<_>>()
    );

    let golden: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/schema-golden.json")).unwrap();
    let want: Vec<SchemaRow> = serde_json::from_value(golden["schema"].clone()).unwrap();
    let got = schema(&pool).await;
    for (g, w) in got.iter().zip(&want) {
        assert_eq!(g, w);
    }
    assert_eq!(got.len(), want.len());
    let want_ledger: Vec<(i64, String)> = serde_json::from_value(golden["ledger"].clone()).unwrap();
    assert_eq!(
        want_ledger,
        rows.into_iter().map(|r| (r.0, r.1)).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn pragmas_are_set_on_pool_connections() {
    let (_dir, pool) = fresh().await;
    let mut conn = pool.acquire().await.unwrap();
    let text: (String, String) =
        sqlx::query_as("SELECT (SELECT * FROM pragma_journal_mode), vec_version()")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
    assert_eq!(text, ("wal".to_string(), "v0.1.9".to_string()));
    let ints: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT * FROM pragma_busy_timeout), (SELECT * FROM pragma_synchronous), \
         (SELECT * FROM pragma_foreign_keys), (SELECT * FROM pragma_temp_store)",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    // synchronous 1 = NORMAL, temp_store 2 = MEMORY.
    assert_eq!(ints, (5000, 1, 1, 2));
    let mmap: i64 = sqlx::query_scalar("PRAGMA mmap_size")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(mmap, 268_435_456);
}

#[tokio::test]
async fn migrate_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("exchange.db");
    let pool = open(&path).await.unwrap();
    let (s1, l1) = (schema(&pool).await, ledger(&pool).await);
    pool.close().await;
    let pool = open(&path).await.unwrap();
    assert_eq!(schema(&pool).await, s1);
    assert_eq!(
        ledger(&pool).await,
        l1,
        "nothing re-applied, applied_at untouched"
    );
}

#[tokio::test]
async fn changed_migration_fails_unless_allowed() {
    let (_dir, pool) = fresh().await;
    let mut edited = MIGRATIONS.to_vec();
    let sneaky = format!("{}\n-- edited\n", MIGRATIONS[7].2);
    edited[7].2 = &sneaky;
    let err = migrate(&pool, &edited, false)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("checksum mismatch on applied migration 8"),
        "{err}"
    );
    let before = ledger(&pool).await;
    migrate(&pool, &edited, true).await.unwrap();
    assert_eq!(ledger(&pool).await, before, "tolerated, not re-applied");
}

#[tokio::test]
async fn vec_table_must_exist_before_the_sql_migrations() {
    // recommender/tests/test_fresh_volume_boot.py: without the pre-loop vec0
    // DDL, 0007's DELETE FROM title_vec fails and 0007 is not recorded.
    register_sqlite_vec();
    let dir = tempfile::tempdir().unwrap();
    let pool = SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(dir.path().join("exchange.db"))
            .create_if_missing(true),
    )
    .await
    .unwrap();
    let err = media_core::db::migrate(&pool, MIGRATIONS, false)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("title_vec"), "{err}");
    let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM schema_migrations")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(versions, (1..=6).collect::<Vec<_>>());
}

#[tokio::test]
async fn vec_knn_round_trips_kind_encoded_rowids() {
    let (_dir, pool) = fresh().await;
    let unit = |i: usize| {
        let mut v = vec![0f32; EMBED_DIM];
        v[i] = 1.0;
        v
    };
    // A movie and a show sharing TMDB id 1399, plus a far movie.
    for (kind, id, vec) in [
        ("movie", 1399, unit(0)),
        ("tv", 1399, unit(0)),
        ("movie", 7, unit(1)),
    ] {
        sqlx::query("INSERT INTO title_vec(rowid, kind, embedding) VALUES (?, ?, ?)")
            .bind(encode_vec_rowid(kind, id).unwrap())
            .bind(kind)
            .bind(serialize_f32(&vec))
            .execute(&pool)
            .await
            .unwrap();
    }
    let knn = async |kind: &str| -> Vec<(i64, f64)> {
        let rows: Vec<(i64, f64)> = sqlx::query_as(
            "SELECT v.rowid AS vec_rowid, v.distance AS distance
               FROM title_vec v
              WHERE v.kind = ? AND v.embedding MATCH ? AND k = ?
              ORDER BY v.distance",
        )
        .bind(kind)
        .bind(serialize_f32(&unit(0)))
        .bind(10)
        .fetch_all(&pool)
        .await
        .unwrap();
        rows.into_iter()
            .map(|(rowid, d)| (decode_vec_rowid(rowid, Some(kind)).unwrap().1, d))
            .collect()
    };
    let movies = knn("movie").await;
    assert_eq!(movies.iter().map(|r| r.0).collect::<Vec<_>>(), [1399, 7]);
    assert!(movies[0].1.abs() < 1e-6 && (movies[1].1 - 1.0).abs() < 1e-6);
    let tv = knn("tv").await;
    assert_eq!(tv.iter().map(|r| r.0).collect::<Vec<_>>(), [1399]);

    let stored: Vec<u8> = sqlx::query_scalar("SELECT embedding FROM title_vec WHERE rowid = ?")
        .bind(encode_vec_rowid("tv", 1399).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(deserialize_f32(&stored, Some(EMBED_DIM)).unwrap(), unit(0));
}

#[test]
fn vec_rowid_encoding() {
    assert_eq!(encode_vec_rowid("movie", 1399).unwrap(), 1399);
    assert_eq!(encode_vec_rowid("tv", 1399).unwrap(), 1399 | (1 << 32));
    assert_eq!(
        decode_vec_rowid(1399 | (1 << 32), None).unwrap(),
        ("tv", 1399)
    );
    assert_eq!(
        decode_vec_rowid(1399, Some("movie")).unwrap(),
        ("movie", 1399)
    );
    assert!(decode_vec_rowid(1399, Some("tv")).is_err());
    assert!(encode_vec_rowid("tv", 1 << 32).is_err());
    assert!(encode_vec_rowid("movie", 1 << 32).is_err());
    assert!(encode_vec_rowid("iptv_vod", 1).is_err());
}

#[test]
fn f32_blobs() {
    let v = [1.5f32, -0.25, 3.0e-8];
    let blob = serialize_f32(&v);
    // struct.pack("3f", 1.5, -0.25, 3e-8) on a little-endian host.
    assert_eq!(&blob[..8], &[0, 0, 0xc0, 0x3f, 0, 0, 0x80, 0xbe]);
    assert_eq!(deserialize_f32(&blob, Some(3)).unwrap(), v);
    assert_eq!(deserialize_f32(&blob, None).unwrap(), v);
    assert!(deserialize_f32(&blob, Some(4)).is_err());
    assert!(deserialize_f32(&blob[..5], None).is_err());
}

#[tokio::test]
async fn table_generation_moves_on_insert_and_timestamp() {
    // recommender/tests/test_cache_invalidation.py.
    let (_dir, pool) = fresh().await;
    let spec = [("titles", Some("fetched_at")), ("title_cast", None)];
    let g0 = table_generation(&pool, &spec).await.unwrap();
    assert_eq!(g0, [(0, 0, Some(String::new())), (0, 0, None)]);
    sqlx::query(
        "INSERT INTO titles(tmdb_id, kind, title, vote_count, popularity, status, fetched_at) \
         VALUES (1, 'movie', 'Title 1', 100, 1.0, 'Released', 't0')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let g1 = table_generation(&pool, &spec).await.unwrap();
    assert_ne!(g1, g0);
    sqlx::query("UPDATE titles SET fetched_at = 't1' WHERE tmdb_id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let g2 = table_generation(&pool, &spec).await.unwrap();
    assert_ne!(g2, g1);
    assert_eq!(table_generation(&pool, &spec).await.unwrap(), g2);
}

#[tokio::test]
async fn table_generation_rejects_bad_identifier() {
    let (_dir, pool) = fresh().await;
    for spec in [
        ("titles; DROP TABLE titles", None),
        ("titles", Some("x)")),
        ("1titles", None),
        ("", None),
    ] {
        assert!(matches!(
            table_generation(&pool, &[spec]).await,
            Err(Error::Invalid(_))
        ));
    }
}

#[tokio::test]
async fn genre_agg_sql_orders_genres() {
    let (_dir, pool) = fresh().await;
    sqlx::raw_sql(
        "INSERT INTO titles(tmdb_id, kind, title, fetched_at) VALUES (5, 'tv', 'Five', 't0');
         INSERT INTO title_genres VALUES (5, 'tv', 80), (5, 'tv', 18), (5, 'movie', 99);",
    )
    .execute(&pool)
    .await
    .unwrap();
    let genres: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {GENRE_AGG_SQL} FROM titles t WHERE t.tmdb_id = 5"
    )))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(genres.as_deref(), Some("18,80"));
}

#[test]
fn iso_timestamp_matches_python_isoformat() {
    use chrono::TimeZone;
    let t = chrono::Utc.with_ymd_and_hms(2026, 10, 18, 4, 5, 6).unwrap();
    assert_eq!(iso_micros(t), "2026-10-18T04:05:06.000000+00:00");
    let t = t + chrono::Duration::microseconds(12);
    assert_eq!(iso_micros(t), "2026-10-18T04:05:06.000012+00:00");
    assert_eq!(utc_now_iso().len(), 32);
}

// recommender/tests/test_watched_feedback.py: 0008 widens the signal CHECK to
// 'watched' and keeps the rows it rebuilds.
#[tokio::test]
async fn migration_0008_allows_watched_and_preserves_rows() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE user_feedback (
          sub     TEXT    NOT NULL,
          kind    TEXT    NOT NULL,
          tmdb_id INTEGER NOT NULL,
          signal  TEXT    NOT NULL CHECK (signal IN ('like','dislike','reject','shown','clicked','added')),
          ts      TEXT    NOT NULL,
          PRIMARY KEY (sub, kind, tmdb_id, signal)
        );",
    )
    .execute(&pool)
    .await
    .unwrap();
    let insert = |tmdb_id: i64, signal: &'static str| {
        sqlx::query("INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts) VALUES ('plex:494190801', 'movie', ?, ?, '2026-06-06T00:00:00Z')")
            .bind(tmdb_id)
            .bind(signal)
            .execute(&pool)
    };
    insert(42, "like").await.unwrap();
    assert!(
        insert(7, "watched").await.is_err(),
        "pre-0008 CHECK rejects watched"
    );
    let (version, _, sql) = MIGRATIONS[7];
    assert_eq!(version, 8);
    sqlx::raw_sql(sql).execute(&pool).await.unwrap();
    let likes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_feedback WHERE signal='like'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(likes, 1);
    insert(7, "watched").await.unwrap();
    assert!(insert(8, "nope").await.is_err());
}
