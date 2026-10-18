//! Serves src/fake_tmdb.rs to tests/fixtures/gen_ingest_goldens.py: reads a
//! scenario JSON file, prints the base URL on stdout, serves until killed.
//! The request log is at `GET <base>/__log`.
//!
//!     cargo build -p recommender --example fake_tmdb
//!     target/debug/examples/fake_tmdb <scenario.json>

#[path = "../src/fake_tmdb.rs"]
mod fake_tmdb;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: fake_tmdb <scenario.json>");
    let scenario = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let fake = fake_tmdb::start(&scenario).await;
    println!("{}", fake.base);
    std::future::pending::<()>().await;
}
