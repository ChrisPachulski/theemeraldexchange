//! usageLog.test.ts (minus readUsageForUser, which had no caller) and
//! usage.test.ts.

use serde_json::{Value, json};

use super::*;
use crate::testutil::{ADMIN, ALICE, BOB, get_req, json_req, member, send, state_in};

const CHUNK: usize = 64 * 1024;

fn ev<'a>(sub: &'a str, event: &'static str, kind: Kind) -> Event<'a> {
    Event::new(sub, sub, event, "claude-haiku-4-5", kind)
}

fn line(v: Value) -> String {
    format!("{v}\n")
}

/// One line whose emoji username straddles the 64 KiB block boundary.
fn boundary_line() -> String {
    let event = |error: &str| {
        json!({
            "ts": auth::now_iso(), "sub": "boundary", "username": "\u{1f49a}", "type": "claude_call",
            "model": "m", "kind": "movie", "costCents": 0.25, "error": error,
        })
        .to_string()
            + "\n"
    };
    let base = event("");
    let marker = base.find('\u{1f49a}').unwrap();
    event(&"x".repeat(marker + 1 + CHUNK - base.len()))
}

#[tokio::test]
async fn writes_and_reads_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlLog::new(dir.path().join("usage.jsonl"));
    append(&log, &ev("alice", "claude_call", Kind::Movie))
        .await
        .unwrap();
    append(&log, &ev("bob", "claude_call", Kind::Tv))
        .await
        .unwrap();
    let events = recent(&log, 10).await;
    let subs: Vec<Value> = events
        .iter()
        .map(|r| serde_json::from_str::<Value>(r.get()).unwrap()["sub"].clone())
        .collect();
    assert_eq!(subs, [json!("bob"), json!("alice")]);
}

#[tokio::test]
async fn a_line_is_written_in_the_ts_key_order() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlLog::new(dir.path().join("usage.jsonl"));
    let usage = Usage {
        input: Some(100),
        output: Some(60),
        cache_creation: None,
        cache_read: Some(80),
    };
    append(
        &log,
        &Event::call("s", "u", "m", Kind::Tv, 2, &usage, 0.0388),
    )
    .await
    .unwrap();
    append(&log, &Event::error("s", "u", "m", Kind::Movie, "boom"))
        .await
        .unwrap();
    let text = std::fs::read_to_string(log.path()).unwrap();
    let lines: Vec<&str> = text
        .lines()
        .map(|l| &l[l.find(",\"sub\"").unwrap()..])
        .collect();
    assert_eq!(
        lines,
        [
            r#","sub":"s","username":"u","type":"claude_call","model":"m","kind":"tv","callCount":2,"inputTokens":100,"outputTokens":60,"cacheReadInputTokens":80,"costCents":0.0388}"#,
            r#","sub":"s","username":"u","type":"claude_error","model":"m","kind":"movie","error":"boom"}"#,
        ]
    );
}

#[tokio::test]
async fn returns_nothing_when_the_log_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlLog::new(dir.path().join("usage.jsonl"));
    assert!(recent(&log, 10).await.is_empty());
}

#[tokio::test]
async fn skips_malformed_lines() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlLog::new(dir.path().join("usage.jsonl"));
    append(&log, &ev("a", "claude_call", Kind::Movie))
        .await
        .unwrap();
    log.append("not json").await.unwrap();
    append(&log, &ev("b", "claude_call", Kind::Tv))
        .await
        .unwrap();
    assert_eq!(recent(&log, 10).await.len(), 2);
}

#[tokio::test]
async fn utf8_split_across_read_blocks_survives() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlLog::new(dir.path().join("usage.jsonl"));
    std::fs::write(log.path(), boundary_line()).unwrap();
    let events = recent(&log, 1).await;
    let v: Value = serde_json::from_str(events[0].get()).unwrap();
    assert_eq!(v["username"], "\u{1f49a}");
    let summary = summarize(&log, 0.0).await;
    assert_eq!(summary.len(), 1);
    assert_eq!(
        summary[0].json(),
        json!({ "sub": "boundary", "username": "\u{1f49a}", "calls": 1, "errors": 0, "inputTokens": 0, "outputTokens": 0,
                "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0, "costCents": 0.25 })
    );
}

#[tokio::test]
async fn a_failed_append_does_not_poison_later_ones() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("not-a-directory");
    std::fs::write(&blocker, "x").unwrap();
    let log = JsonlLog::new(blocker.join("usage.jsonl"));
    assert!(
        append(&log, &ev("alice", "claude_call", Kind::Movie))
            .await
            .is_err()
    );
    std::fs::remove_file(&blocker).unwrap();
    append(&log, &ev("bob", "claude_call", Kind::Tv))
        .await
        .unwrap();
    let subs: Vec<String> = recent(&log, 10)
        .await
        .iter()
        .map(|r| {
            serde_json::from_str::<Value>(r.get()).unwrap()["sub"]
                .as_str()
                .unwrap()
                .into()
        })
        .collect();
    assert_eq!(subs, ["bob"]);
}

#[tokio::test]
async fn summarizes_per_user_with_cost_totals() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlLog::new(dir.path().join("usage.jsonl"));
    let call = |input: u64, output: u64, cost: f64| Event {
        input_tokens: Some(input),
        output_tokens: Some(output),
        cost_cents: Some(js_number(cost)),
        ..ev("alice", "claude_call", Kind::Movie)
    };
    append(&log, &call(1000, 500, 0.35)).await.unwrap();
    append(&log, &call(2000, 800, 0.60)).await.unwrap();
    append(&log, &Event::error("bob", "bob", "m", Kind::Tv, "401"))
        .await
        .unwrap();
    let summary = summarize(&log, 0.0).await;
    let alice = summary.iter().find(|r| r.sub == "alice").unwrap();
    let bob = summary.iter().find(|r| r.sub == "bob").unwrap();
    assert_eq!(
        (alice.calls, alice.errors, alice.input_tokens),
        (2.0, 0.0, 3000.0)
    );
    assert!((alice.cost_cents - 0.95).abs() < 0.005);
    assert_eq!((bob.calls, bob.errors), (0.0, 1.0));
    assert_eq!(summary[0].sub, "alice", "most expensive first");
}

#[tokio::test]
async fn respects_the_since_cutoff() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlLog::new(dir.path().join("usage.jsonl"));
    append(&log, &ev("alice", "claude_call", Kind::Movie))
        .await
        .unwrap();
    let in_an_hour = chrono::Utc::now().timestamp_millis() as f64 + 3_600_000.0;
    assert!(summarize(&log, in_an_hour).await.is_empty());
}

#[tokio::test]
async fn stops_scanning_at_the_first_event_older_than_the_cutoff() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlLog::new(dir.path().join("usage.jsonl"));
    let recent_ts = auth::now_iso();
    let old_ts = (chrono::Utc::now() - chrono::Duration::hours(25))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let row = |ts: &str, sub: &str, cost: f64| {
        line(
            json!({ "ts": ts, "sub": sub, "username": sub, "type": "claude_call", "model": "m", "kind": "movie", "costCents": cost }),
        )
    };
    let text = row(&old_ts, "ghost", 99.0)
        + &row(&recent_ts, "alice", 0.1)
        + &row(&recent_ts, "alice", 0.2);
    std::fs::write(log.path(), text).unwrap();
    let summary = summarize(
        &log,
        chrono::Utc::now().timestamp_millis() as f64 - 3_600_000.0,
    )
    .await;
    let alice = summary.iter().find(|r| r.sub == "alice").unwrap();
    assert_eq!(alice.calls, 2.0);
    assert!((alice.cost_cents - 0.3).abs() < 0.005);
    assert!(summary.iter().all(|r| r.sub != "ghost"));
}

#[tokio::test]
async fn counts_more_than_ten_thousand_events_in_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlLog::new(dir.path().join("usage.jsonl"));
    let now = chrono::Utc::now();
    let text: String = (0..12_000)
        .rev()
        .map(|i| {
            let ts = (now - chrono::Duration::seconds(i)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            line(json!({ "ts": ts, "sub": "alice", "username": "alice", "type": "claude_call", "model": "m", "kind": "movie", "costCents": 0.01 }))
        })
        .collect();
    std::fs::write(log.path(), text).unwrap();
    let summary = summarize(&log, 0.0).await;
    assert_eq!(summary[0].calls, 12_000.0);
    assert!((summary[0].cost_cents - 120.0).abs() < 0.05);
}

#[tokio::test]
async fn spans_the_rotated_log() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlLog::new(dir.path().join("usage.jsonl"));
    let old = json!({ "ts": auth::now_iso(), "sub": "alice", "username": "alice", "type": "claude_call", "model": "m",
                      "kind": "movie", "inputTokens": 100, "outputTokens": 50, "costCents": 0.10 });
    std::fs::write(log.rotated(), line(old)).unwrap();
    let newer = Event {
        input_tokens: Some(200),
        output_tokens: Some(100),
        cost_cents: Some(js_number(0.20)),
        ..ev("alice", "claude_call", Kind::Movie)
    };
    append(&log, &newer).await.unwrap();
    let summary = summarize(&log, 0.0).await;
    assert_eq!((summary[0].calls, summary[0].input_tokens), (2.0, 300.0));
    assert!((summary[0].cost_cents - 0.30).abs() < 0.005);
}

#[test]
fn cost_matches_haiku_pricing() {
    let only = |f: fn(&mut Usage)| {
        let mut u = Usage::default();
        f(&mut u);
        compute_cost_cents(&u)
    };
    assert_eq!(only(|u| u.input = Some(1_000_000)), 100.0);
    assert_eq!(only(|u| u.output = Some(1_000_000)), 500.0);
    assert_eq!(only(|u| u.cache_read = Some(1_000_000)), 10.0);
    assert_eq!(only(|u| u.cache_creation = Some(1_000_000)), 125.0);
    assert_eq!(compute_cost_cents(&Usage::default()), 0.0);
    // Four decimals: 100 in + 60 out = 0.01 + 0.03.
    assert_eq!(
        only(|u| *u = Usage {
            input: Some(100),
            output: Some(60),
            ..Usage::default()
        }),
        0.04
    );
}

// --- routes ----------------------------------------------------------------------------

async fn usage_app() -> (tempfile::TempDir, crate::AppState, axum::Router) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage.jsonl").to_str().unwrap().to_string();
    let st = state_in(&dir, &[("USAGE_LOG_PATH", &path)]).await;
    let app = crate::router(st.clone());
    (dir, st, app)
}

#[tokio::test]
async fn routes_gate_on_auth_and_admin() {
    let (_dir, st, app) = usage_app().await;
    assert_eq!(send(&app, get_req("/api/usage/me")).await.status, 401);
    let user = member(&st, ALICE, "alice", "user").await;
    for path in ["/api/usage/admin", "/api/usage/log"] {
        assert_eq!(
            send(&app, json_req("GET", path, Some(&user), None))
                .await
                .status,
            403,
            "{path}"
        );
    }
}

#[tokio::test]
async fn me_is_zeros_without_events_and_scoped_to_the_caller() {
    let (_dir, st, app) = usage_app().await;
    let alice = member(&st, ALICE, "alice", "user").await;
    let r = send(&app, json_req("GET", "/api/usage/me", Some(&alice), None)).await;
    assert_eq!(
        serde_json::from_str::<Value>(&r.body).unwrap(),
        json!({ "sub": ALICE, "username": "alice", "calls": 0, "errors": 0, "inputTokens": 0, "outputTokens": 0,
                "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0, "costCents": 0 })
    );
    let call = |sub, cost: f64| Event {
        cost_cents: Some(js_number(cost)),
        ..ev(sub, "claude_call", Kind::Movie)
    };
    append(&st.usage, &call(ALICE, 1.5)).await.unwrap();
    append(&st.usage, &call(BOB, 99.0)).await.unwrap();
    let r = send(&app, json_req("GET", "/api/usage/me", Some(&alice), None)).await;
    let body: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(
        (
            body["sub"].as_str(),
            body["calls"].as_f64(),
            body["costCents"].as_f64()
        ),
        (Some(ALICE), Some(1.0), Some(1.5))
    );
}

#[tokio::test]
async fn admin_sees_every_user_and_the_newest_events() {
    let (_dir, st, app) = usage_app().await;
    let admin = member(&st, ADMIN, "admin", "admin").await;
    append(&st.usage, &ev(ALICE, "claude_call", Kind::Movie))
        .await
        .unwrap();
    append(&st.usage, &Event::error(BOB, "bob", "m", Kind::Tv, "boom"))
        .await
        .unwrap();
    let r = send(
        &app,
        json_req("GET", "/api/usage/admin", Some(&admin), None),
    )
    .await;
    let rows: Vec<Value> = serde_json::from_str(&r.body).unwrap();
    let mut subs: Vec<&str> = rows.iter().map(|r| r["sub"].as_str().unwrap()).collect();
    let mut want = [ALICE, BOB];
    subs.sort_unstable();
    want.sort_unstable();
    assert_eq!(subs, want);

    let r = send(&app, json_req("GET", "/api/usage/log", Some(&admin), None)).await;
    let rows: Vec<Value> = serde_json::from_str(&r.body).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["sub"], BOB, "newest first");
    // ?limit: floor, capped at 200; zero, negative or junk is the default 50.
    for (q, n) in [
        ("1.9", 1),
        ("0.5", 0),
        ("-3", 2),
        ("abc", 2),
        ("", 2),
        ("500", 2),
    ] {
        let r = send(
            &app,
            json_req(
                "GET",
                &format!("/api/usage/log?limit={q}"),
                Some(&admin),
                None,
            ),
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Vec<Value>>(&r.body).unwrap().len(),
            n,
            "limit={q}"
        );
    }
}
