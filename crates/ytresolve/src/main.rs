//! `eex-ytresolve <videoId>` — print a JSON line of deliverable stream refs for a
//! YouTube video id, or exit non-zero so the caller falls back to yt-dlp.
//!
//! Drop-in replacement for the `yt-dlp -g` subprocess: same shape of contract
//! (one id in, a resolution out), but native, in-process YouTube extraction with
//! no Python, no JS engine, no PoToken.

use std::time::Duration;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let id = std::env::args().nth(1).unwrap_or_default();

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("eex-ytresolve: client init failed: {e}");
            std::process::exit(2);
        }
    };

    match ytresolve::resolve(&id, &client, &ytresolve::ios_client()).await {
        Ok(r) => {
            // One JSON line on stdout; the caller (ytdlp.ts) parses it.
            println!("{}", serde_json::to_string(&r).expect("Resolved serializes"));
        }
        Err(e) => {
            eprintln!("eex-ytresolve: {e}");
            std::process::exit(1);
        }
    }
}
