//! Fresh-dir boot: the real eex-recommender binary, in the production posture,
//! pointed at a data dir that does not exist yet, must create it, migrate a
//! fresh exchange.db (vec0 table first, so 0007's DELETE FROM title_vec works)
//! and serve /health with an empty catalog. Replaces
//! scripts/recommender-fresh-volume-boot-proof.sh and test_fresh_volume_boot.py;
//! the container layer (gosu, caps, read-only rootfs) is proven in CI by
//! scripts/ci-recommender-image-check.sh.

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};

/// The binary's fixed listen port (main.rs LISTEN).
const HEALTH: &str = "http://127.0.0.1:8000/health";
const EVENT: &str = "fresh-boot-event-secret-xxxxxxxxxxxxxxxx";

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn fresh_dir_boots_migrates_and_serves_health() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let db = data.join("exchange.db");
    assert!(!data.exists(), "precondition: the volume starts cold");

    let mut server = Server(
        Command::new(env!("CARGO_BIN_EXE_eex-recommender"))
            .env_clear()
            .env("NODE_ENV", "production")
            .env("RECOMMENDER_DB_PATH", &db)
            .env("RECOMMENDER_EVENT_SECRET", EVENT)
            .env(
                "INTERNAL_PRINCIPAL_SECRET",
                "fresh-boot-principal-secret-zzzzzzzzzzzzzzzz",
            )
            .env("RECOMMENDER_HOLDOUT_PATH", tmp.path().join("absent.jsonl"))
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );

    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    let body: serde_json::Value = loop {
        if let Some(status) = server.0.try_wait().unwrap() {
            panic!("eex-recommender exited during boot: {status} (is port 8000 taken?)");
        }
        if let Ok(res) = client
            .get(HEALTH)
            .header("x-recommender-secret", EVENT)
            .send()
            .await
        {
            assert_eq!(res.status(), 200);
            break serde_json::from_str(&res.text().await.unwrap()).unwrap();
        }
        assert!(Instant::now() < deadline, "/health never answered");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };

    assert_eq!(body["ok"], true);
    assert_eq!(body["titles"], 0);
    assert_eq!(body["title_vectors"], 0);
    assert_eq!(body["db_path"], db.display().to_string());
    assert_eq!(body["internal_principal_mode"], "enforce");
    drop(server);

    let pool = SqlitePool::connect_with(SqliteConnectOptions::new().filename(&db).read_only(true))
        .await
        .unwrap();
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    let embedded: Vec<i64> = recommender::db::MIGRATIONS.iter().map(|m| m.0).collect();
    assert_eq!(applied, embedded, "every migration applied on a fresh boot");
    let vec0: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'title_vec'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(vec0, 1, "the vec0 table exists after boot");
}
