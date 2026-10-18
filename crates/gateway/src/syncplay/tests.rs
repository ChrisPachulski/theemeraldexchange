//! Carried over from syncplay.test.ts (fake clock pinned at 2026-07-01T12:00Z).

use std::sync::atomic::Ordering;

use axum::http::Request;
use serde_json::json;

use super::*;
use crate::testutil::*;

struct T {
    _dir: tempfile::TempDir,
    st: AppState,
    app: Router,
    alice: String,
    bob: String,
    carol: String,
}

async fn setup() -> T {
    let dir = tempfile::tempdir().unwrap();
    let st = user_state(&dir, &[]).await;
    st.syncplay
        .fake_now
        .store(1_782_907_200_000, Ordering::SeqCst);
    let app = crate::router(st.clone());
    let alice = member(&st, ALICE, "user-alice", "user").await;
    let bob = member(&st, BOB, "user-bob", "user").await;
    let carol = member(&st, CAROL, "user-carol", "user").await;
    T {
        _dir: dir,
        st,
        app,
        alice,
        bob,
        carol,
    }
}

impl T {
    fn advance(&self, ms: i64) {
        self.st.syncplay.fake_now.fetch_add(ms, Ordering::SeqCst);
    }

    async fn post(&self, cookie: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let r = send(
            &self.app,
            json_req(
                "POST",
                &format!("/api/syncplay{path}"),
                Some(cookie),
                body.as_ref(),
            ),
        )
        .await;
        (
            r.status.as_u16(),
            serde_json::from_str(&r.body).unwrap_or(Value::Null),
        )
    }

    async fn get(&self, cookie: &str, path: &str) -> (u16, Value) {
        let r = send(
            &self.app,
            json_req("GET", &format!("/api/syncplay{path}"), Some(cookie), None),
        )
        .await;
        (
            r.status.as_u16(),
            serde_json::from_str(&r.body).unwrap_or(Value::Null),
        )
    }

    async fn create(&self, cookie: &str, id: u64) -> Value {
        let (status, g) = self
            .post(
                cookie,
                "/groups",
                Some(json!({ "media_kind": "movie", "media_id": id })),
            )
            .await;
        assert_eq!(status, 200);
        g
    }

    async fn listing(&self, cookie: &str) -> Vec<Value> {
        let (status, v) = self.get(cookie, "/groups").await;
        assert_eq!(status, 200);
        v["items"].as_array().unwrap().clone()
    }

    /// POST a command whose body arrives in two chunks, running `during`
    /// while the handler waits on the read.
    async fn streamed<F: Future<Output = ()>>(
        &self,
        cookie: &str,
        gid: &str,
        body: Value,
        during: F,
    ) -> (u16, Value) {
        let bytes = body.to_string().into_bytes();
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(2);
        let req = Request::post(format!("/api/syncplay/groups/{gid}/command"))
            .header("cookie", cookie)
            .header("content-type", "application/json")
            .body(Body::from_stream(tokio_stream(rx)))
            .unwrap();
        let app = self.app.clone();
        let pending = tokio::spawn(async move { send(&app, req).await });
        tx.send(Ok(bytes[..1].to_vec())).await.unwrap();
        tokio::task::yield_now().await;
        during.await;
        tx.send(Ok(bytes[1..].to_vec())).await.unwrap();
        drop(tx);
        let r = pending.await.unwrap();
        (
            r.status.as_u16(),
            serde_json::from_str(&r.body).unwrap_or(Value::Null),
        )
    }
}

use std::future::Future;

fn tokio_stream(
    mut rx: tokio::sync::mpsc::Receiver<Result<Vec<u8>, std::io::Error>>,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

fn gid(g: &Value) -> String {
    g["id"].as_str().unwrap().to_string()
}

fn subs(g: &Value) -> Vec<String> {
    g["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["sub"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn create_join_and_keep_members_in_lockstep() {
    let t = setup().await;
    let g = t.create(&t.alice, 7).await;
    assert_eq!(
        (g["paused"].clone(), g["members"].as_array().unwrap().len()),
        (json!(true), 1)
    );
    let id = gid(&g);
    let (s, joined) = t.post(&t.bob, &format!("/groups/{id}/join"), None).await;
    assert_eq!((s, joined["members"].as_array().unwrap().len()), (200, 2));

    let (_, play) = t
        .post(
            &t.alice,
            &format!("/groups/{id}/command"),
            Some(json!({ "type": "play", "position_secs": 30 })),
        )
        .await;
    assert_eq!(
        (play["paused"].clone(), play["position_secs"].clone()),
        (json!(false), json!(30))
    );

    t.advance(10_000);
    let (s, polled) = t.get(&t.bob, &format!("/groups/{id}")).await;
    assert_eq!(s, 200);
    assert_eq!(polled["position_secs"], json!(40));
    assert!(polled["version"].as_u64() > g["version"].as_u64());

    t.post(
        &t.bob,
        &format!("/groups/{id}/command"),
        Some(json!({ "type": "pause", "position_secs": 41 })),
    )
    .await;
    t.advance(45_000);
    let (_, frozen) = t.get(&t.bob, &format!("/groups/{id}")).await;
    assert_eq!(
        (frozen["paused"].clone(), frozen["position_secs"].clone()),
        (json!(true), json!(41))
    );
}

#[tokio::test]
async fn every_member_sees_the_full_roster() {
    let t = setup().await;
    let g = t.create(&t.alice, 42).await;
    let id = gid(&g);
    let by_bob = t.listing(&t.bob).await;
    assert_eq!(
        by_bob[0],
        json!({ "id": id, "host_sub": ALICE, "media_kind": "movie", "media_id": 42, "paused": true,
                "position_secs": 0, "version": 1, "members": [{ "sub": ALICE, "username": "user-alice" }], "member_count": 1 })
    );
    assert_eq!(t.listing(&t.alice).await, by_bob);

    t.post(&t.bob, &format!("/groups/{id}/join"), None).await;
    let after = &t.listing(&t.bob).await[0];
    assert_eq!(
        (after["host_sub"].clone(), after["member_count"].clone()),
        (json!(ALICE), json!(2))
    );

    t.post(&t.bob, &format!("/groups/{id}/leave"), None).await;
    let after = &t.listing(&t.bob).await[0];
    assert_eq!(after["member_count"], json!(1));
    assert_eq!(subs(after), vec![ALICE]);
}

#[tokio::test]
async fn rejects_non_members_unknown_groups_and_bad_bodies() {
    let t = setup().await;
    let (_, g) = t
        .post(
            &t.alice,
            "/groups",
            Some(json!({ "media_kind": "episode", "media_id": 3 })),
        )
        .await;
    let id = gid(&g);
    assert_eq!(
        t.get(&t.bob, &format!("/groups/{id}")).await,
        (403, json!({ "error": "not_member" }))
    );
    assert_eq!(
        t.post(
            &t.bob,
            &format!("/groups/{id}/command"),
            Some(json!({ "type": "play" }))
        )
        .await
        .0,
        403
    );
    assert_eq!(
        t.get(&t.alice, "/groups/nope").await,
        (404, json!({ "error": "not_found" }))
    );
    for (body, code) in [
        (
            json!({ "media_kind": "song", "media_id": 1 }),
            "invalid_media_kind",
        ),
        (
            json!({ "media_kind": "movie", "media_id": -1 }),
            "invalid_media_id",
        ),
        (
            json!({ "media_kind": "movie", "media_id": "7" }),
            "invalid_media_id",
        ),
    ] {
        assert_eq!(
            t.post(&t.alice, "/groups", Some(body)).await,
            (400, json!({ "error": code }))
        );
    }
    assert_eq!(
        t.post(
            &t.alice,
            &format!("/groups/{id}/command"),
            Some(json!({ "type": "seek" }))
        )
        .await,
        (400, json!({ "error": "invalid_position" }))
    );
    assert_eq!(
        t.post(
            &t.alice,
            &format!("/groups/{id}/command"),
            Some(json!({ "type": "stop" }))
        )
        .await,
        (400, json!({ "error": "invalid_type" }))
    );
}

#[tokio::test]
async fn last_leave_deletes_and_idle_members_are_pruned() {
    let t = setup().await;
    let id = gid(&t.create(&t.alice, 5).await);
    t.post(&t.bob, &format!("/groups/{id}/join"), None).await;
    t.post(&t.alice, &format!("/groups/{id}/leave"), None).await;
    let (s, still) = t.get(&t.bob, &format!("/groups/{id}")).await;
    assert_eq!(
        (s, still["host_sub"].clone()),
        (200, json!(BOB)),
        "hosting moves to a survivor"
    );
    t.post(&t.bob, &format!("/groups/{id}/leave"), None).await;
    assert_eq!(t.get(&t.bob, &format!("/groups/{id}")).await.0, 404);

    let id2 = gid(&t.create(&t.alice, 5).await);
    assert_ne!(id2, id);
    t.advance(61_000);
    assert!(t.listing(&t.bob).await.is_empty());
}

#[tokio::test]
async fn a_silent_host_timeout_rehosts_and_bumps_the_version() {
    let t = setup().await;
    let id = gid(&t.create(&t.alice, 21).await);
    let (_, joined) = t.post(&t.bob, &format!("/groups/{id}/join"), None).await;
    t.advance(40_000);
    assert_eq!(t.get(&t.bob, &format!("/groups/{id}")).await.0, 200);
    t.advance(40_000);
    let (s, snap) = t.get(&t.bob, &format!("/groups/{id}")).await;
    assert_eq!(s, 200);
    assert_eq!(subs(&snap), vec![BOB]);
    assert_eq!(snap["host_sub"], json!(BOB));
    assert!(snap["version"].as_u64() > joined["version"].as_u64());
    assert_eq!(t.listing(&t.bob).await[0]["host_sub"], json!(BOB));
}

#[tokio::test]
async fn rehosting_skips_members_pruned_in_the_same_sweep() {
    let t = setup().await;
    let id = gid(&t.create(&t.alice, 23).await);
    t.post(&t.bob, &format!("/groups/{id}/join"), None).await;
    t.post(&t.carol, &format!("/groups/{id}/join"), None).await;
    t.advance(40_000);
    assert_eq!(t.get(&t.carol, &format!("/groups/{id}")).await.0, 200);
    t.advance(40_000);
    let (_, snap) = t.get(&t.carol, &format!("/groups/{id}")).await;
    assert_eq!(subs(&snap), vec![CAROL]);
    assert_eq!(snap["host_sub"], json!(CAROL));
}

#[tokio::test]
async fn a_member_who_left_mid_read_is_refused() {
    let t = setup().await;
    let id = gid(&t.create(&t.alice, 9).await);
    t.post(&t.bob, &format!("/groups/{id}/join"), None).await;
    let leave = async {
        t.post(&t.bob, &format!("/groups/{id}/leave"), None).await;
    };
    let (s, _) = t
        .streamed(
            &t.bob,
            &id,
            json!({ "type": "play", "position_secs": 99 }),
            leave,
        )
        .await;
    assert_eq!(s, 403);
    let (_, after) = t.get(&t.alice, &format!("/groups/{id}")).await;
    assert_eq!(
        (after["paused"].clone(), after["position_secs"].clone()),
        (json!(true), json!(0))
    );
    assert_eq!(subs(&after), vec![ALICE]);
}

#[tokio::test]
async fn a_group_deleted_or_pruned_mid_read_is_a_404() {
    let t = setup().await;
    let id = gid(&t.create(&t.alice, 11).await);
    let leave = async {
        t.post(&t.alice, &format!("/groups/{id}/leave"), None).await;
    };
    assert_eq!(
        t.streamed(
            &t.alice,
            &id,
            json!({ "type": "seek", "position_secs": 120 }),
            leave
        )
        .await
        .0,
        404
    );
    assert!(t.listing(&t.alice).await.is_empty());

    let id = gid(&t.create(&t.alice, 13).await);
    let idle = async { t.advance(61_000) };
    assert_eq!(
        t.streamed(
            &t.alice,
            &id,
            json!({ "type": "play", "position_secs": 5 }),
            idle
        )
        .await
        .0,
        404
    );
}

#[tokio::test]
async fn the_command_is_stamped_at_apply_time() {
    let t = setup().await;
    let id = gid(&t.create(&t.alice, 15).await);
    let slow = async { t.advance(20_000) };
    let (s, snap) = t
        .streamed(
            &t.alice,
            &id,
            json!({ "type": "play", "position_secs": 30 }),
            slow,
        )
        .await;
    assert_eq!((s, snap["position_secs"].clone()), (200, json!(30)));
    assert_eq!(
        t.get(&t.alice, &format!("/groups/{id}")).await.1["position_secs"],
        json!(30)
    );
}

#[tokio::test]
async fn a_malformed_streamed_body_never_touches_the_group() {
    let t = setup().await;
    let g = t.create(&t.alice, 17).await;
    let id = gid(&g);
    assert_eq!(
        t.streamed(&t.alice, &id, json!({ "type": "seek" }), async {})
            .await
            .0,
        400
    );
    assert_eq!(
        t.streamed(
            &t.alice,
            &id,
            json!({ "type": "play", "position_secs": "soon" }),
            async {}
        )
        .await
        .0,
        400
    );
    let (_, after) = t.get(&t.alice, &format!("/groups/{id}")).await;
    assert_eq!(
        (
            after["paused"].clone(),
            after["position_secs"].clone(),
            after["version"].clone()
        ),
        (json!(true), json!(0), g["version"].clone())
    );
}

#[tokio::test]
async fn requires_authentication() {
    let t = setup().await;
    let r = send(&t.app, json_req("GET", "/api/syncplay/groups", None, None)).await;
    assert_eq!(r.status, 401);
}

#[test]
fn positions_round_to_milliseconds_as_js_numbers() {
    assert_eq!(js_round3(30.0).to_string(), "30");
    assert_eq!(js_round3(40.0004).to_string(), "40");
    assert_eq!(js_round3(1.23456).to_string(), "1.235");
}
