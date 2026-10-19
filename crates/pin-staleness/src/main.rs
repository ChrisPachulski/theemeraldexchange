//! Image-pin staleness guard for docker-compose.yml.
//!
//! Every third-party image in the compose file is pinned tag@digest, so
//! nothing moves them but a human or Dependabot. The cloudflared pin once sat
//! on an ~18-month-old tag while its digest had been bumped separately (see
//! the LOCKSTEP note in docker-compose.yml). This flags any Docker Hub pin
//! whose tag was last pushed more than MAX_AGE_DAYS ago.
//!
//! Best-effort by design: only a confirmed stale tag fails (exit 1). Network
//! errors, Hub API changes, rate limits and non-Hub registries are warnings,
//! so a Hub blip never fails CI. Digest drift (pinned digest != the tag's
//! current digest) is printed but never fails: lagging a fast-moving tag is
//! the point of pinning the digest.
//!
//! Usage: `cargo run -p pin-staleness -- [compose-file]` (default docker-compose.yml)

use std::process::ExitCode;
use std::time::Duration;

use chrono::{DateTime, Utc};
use regex::Regex;

const MAX_AGE_DAYS: i64 = 365;

#[derive(Debug, PartialEq)]
struct Pin {
    repo: String,
    tag: String,
    digest: String,
}

/// `image: repo:tag@sha256:...` lines. Untagged or undigested images are
/// left to review; this only ages the pins that exist.
fn parse_image_pins(compose: &str) -> Vec<Pin> {
    let re = Regex::new(
        r#"(?m)^\s*image:\s*"?([a-z0-9][a-z0-9._/-]*?):([A-Za-z0-9._-]+)@(sha256:[0-9a-f]{64})"?\s*(?:#.*)?$"#,
    )
    .expect("static regex");
    re.captures_iter(compose)
        .map(|c| Pin {
            repo: c[1].to_string(),
            tag: c[2].to_string(),
            digest: c[3].to_string(),
        })
        .collect()
}

/// The Docker Hub API path for a compose repo, or None for another registry
/// (a first component with a dot or a port is a hostname: ghcr.io, lscr.io).
fn hub_repo_path(repo: &str) -> Option<String> {
    match repo.split_once('/') {
        None => Some(format!("library/{repo}")),
        Some((host, _)) if host.contains('.') || host.contains(':') => None,
        Some(_) => Some(repo.to_string()),
    }
}

fn age_days(pushed: &str, now: DateTime<Utc>) -> Option<i64> {
    let pushed = DateTime::parse_from_rfc3339(pushed).ok()?;
    Some((now - pushed.with_timezone(&Utc)).num_days())
}

fn main() -> ExitCode {
    let file = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "docker-compose.yml".into());
    let compose = match std::fs::read_to_string(&file) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[pin-staleness] cannot read {file}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let pins = parse_image_pins(&compose);
    if pins.is_empty() {
        eprintln!(
            "[pin-staleness] WARNING: no tag@digest image pins found in {file}; parser drift?"
        );
        return ExitCode::SUCCESS;
    }
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[pin-staleness] WARNING: no HTTP client ({e}); skipping (best-effort)");
            return ExitCode::SUCCESS;
        }
    };
    let mut stale = 0;
    for Pin { repo, tag, digest } in &pins {
        let Some(hub) = hub_repo_path(repo) else {
            println!("[pin-staleness] skip {repo}:{tag} (not a Docker Hub image)");
            continue;
        };
        let url = format!("https://hub.docker.com/v2/repositories/{hub}/tags/{tag}");
        let info: serde_json::Value = match client
            .get(&url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
        {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[pin-staleness] WARNING: could not query Hub for {hub}:{tag} ({e}); skipping (best-effort)"
                );
                continue;
            }
        };
        let Some(age) = info["last_updated"]
            .as_str()
            .and_then(|s| age_days(s, Utc::now()))
        else {
            eprintln!("[pin-staleness] WARNING: no usable last_updated for {hub}:{tag}; skipping");
            continue;
        };
        if age > MAX_AGE_DAYS {
            stale += 1;
            eprintln!(
                "[pin-staleness] STALE: {repo}:{tag}, tag last pushed {age} days ago (> {MAX_AGE_DAYS}). \
                 Bump the tag AND digest together (see the LOCKSTEP note in docker-compose.yml)."
            );
        } else {
            println!("[pin-staleness] ok: {repo}:{tag} (tag pushed {age} days ago)");
        }
        if let Some(current) = info["digest"].as_str().filter(|d| d != digest) {
            println!(
                "[pin-staleness] note: {repo}:{tag} pinned digest lags the tag's current digest ({}...)",
                &current[..19.min(current.len())]
            );
        }
    }
    if stale > 0 {
        eprintln!("[pin-staleness] {stale} stale pin(s) found");
        return ExitCode::FAILURE;
    }
    println!("[pin-staleness] all checked pins are fresh enough");
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pins_and_maps_registries() {
        let (a, b, c, d) = (
            "a".repeat(64),
            "b".repeat(64),
            "c".repeat(64),
            "d".repeat(64),
        );
        let fixture = format!(
            "services:\n  a:\n    image: cloudflare/cloudflared:2026.6.0@sha256:{a}\n  b:\n    image: postgres:15@sha256:{b}\n  \
             c:\n    image: \"redis:7-alpine@sha256:{c}\"\n  d:\n    image: ghcr.io/example/thing:1.2@sha256:{d}\n  \
             e:\n    image: untagged/no-digest:latest\n  f:\n    image: theemeraldexchange-backend:latest\n"
        );
        let pins = parse_image_pins(&fixture);
        assert_eq!(pins.len(), 4);
        assert_eq!(
            pins[0],
            Pin {
                repo: "cloudflare/cloudflared".into(),
                tag: "2026.6.0".into(),
                digest: format!("sha256:{a}")
            }
        );
        assert_eq!(pins[1].repo, "postgres");
        assert_eq!(pins[2].tag, "7-alpine");
        assert_eq!(
            hub_repo_path("postgres").as_deref(),
            Some("library/postgres")
        );
        assert_eq!(
            hub_repo_path("cloudflare/cloudflared").as_deref(),
            Some("cloudflare/cloudflared")
        );
        assert_eq!(hub_repo_path("ghcr.io/example/thing"), None);
        assert_eq!(hub_repo_path("localhost:5000/x"), None);
    }

    #[test]
    fn ages_tags_against_the_year_limit() {
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(age_days("2020-01-01T00:00:00Z", now).unwrap() > MAX_AGE_DAYS);
        assert!(age_days("2025-12-01T00:00:00.123456Z", now).unwrap() < MAX_AGE_DAYS);
        assert_eq!(age_days("not a date", now), None);
    }

    #[test]
    fn the_real_compose_file_still_parses() {
        let compose = include_str!("../../../docker-compose.yml");
        assert!(
            !parse_image_pins(compose).is_empty(),
            "no tag@digest pins found: parser drift"
        );
    }
}
