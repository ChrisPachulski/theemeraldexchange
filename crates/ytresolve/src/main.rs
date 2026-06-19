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

    // Fast path: the iOS Innertube client (pre-signed URLs, no JS engine).
    let ios = ytresolve::resolve(&id, &client, &ytresolve::ios_client()).await;

    let resolved = match ios {
        Ok(r) => Ok(r),
        // The iOS client can't serve this video (age/region/login-gated) or it
        // returned no deliverable stream — fall through to the Phase 3 web/cipher
        // path, which runs the player base.js sig+nsig functions in boa. Genuine
        // network/usage errors that aren't "iOS can't serve it" still fall
        // through; resolve_web reports its own distinct error if it also fails.
        Err(ytresolve::ResolveError::NotPlayable(_))
        | Err(ytresolve::ResolveError::NoStream) => {
            ytresolve::cipher::resolve_web(&id, &client).await
        }
        Err(e) => Err(e),
    };

    match resolved {
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
