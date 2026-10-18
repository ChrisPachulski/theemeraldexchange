//! arrGrab.test.ts, arrAdd.test.ts, arrAdvanced.test.ts, grabLog.test.ts and
//! grabEventType.driftguard.test.ts, carried over.

use super::*;
use crate::testutil::{capture_logs, logs};

const MIN_FREE: f64 = 100.0 * GB;

fn folder(free: f64) -> Folder {
    Folder {
        path: "/data/movies".into(),
        free_space: free,
    }
}

// --- ledger (arrGrab.test.ts) --------------------------------------------------------

#[test]
fn reserve_reduces_availability_and_release_restores_it() {
    let (l, f) = (
        Ledger::new("radarr", MIN_FREE),
        folder(MIN_FREE + 10.0 * GB),
    );
    assert_eq!(l.available_bytes(&f), f.free_space);
    assert!(l.reserve(&f, 4.0 * GB));
    assert_eq!(l.available_bytes(&f), f.free_space - 4.0 * GB);
    assert_eq!(l.pending_bytes(&f), 4.0 * GB);
    l.release(&f, 4.0 * GB);
    assert_eq!(l.available_bytes(&f), f.free_space);
    assert_eq!(l.pending_bytes(&f), 0.0);
}

#[test]
fn reserve_refuses_to_dip_below_the_floor_and_sees_earlier_reservations() {
    let (l, f) = (
        Ledger::new("radarr", MIN_FREE),
        folder(MIN_FREE + 10.0 * GB),
    );
    assert!(!l.reserve(&f, 11.0 * GB));
    assert_eq!(l.pending_bytes(&f), 0.0);
    assert!(l.reserve(&f, 6.0 * GB));
    assert!(!l.reserve(&f, 6.0 * GB), "4 GB headroom left");
    assert_eq!(l.pending_bytes(&f), 6.0 * GB);
}

#[test]
fn junk_amounts_are_refused_and_ignored() {
    let (l, f) = (
        Ledger::new("sonarr", MIN_FREE),
        folder(MIN_FREE + 10.0 * GB),
    );
    for junk in [f64::NAN, f64::INFINITY, 0.0, -GB] {
        assert!(!l.reserve(&f, junk));
    }
    assert_eq!(l.pending_bytes(&f), 0.0);
    assert!(l.reserve(&f, 4.0 * GB));
    for junk in [f64::NAN, -GB, 0.0] {
        l.release(&f, junk);
    }
    assert_eq!(l.pending_bytes(&f), 4.0 * GB);
    assert!(l.reserve(&f, 2.0 * GB));
    assert_eq!(l.pending_bytes(&f), 6.0 * GB);
}

#[test]
fn over_release_floors_at_zero_and_partial_release_trims_the_oldest() {
    let (l, f) = (
        Ledger::new("radarr", MIN_FREE),
        folder(MIN_FREE + 10.0 * GB),
    );
    assert!(l.reserve(&f, 2.0 * GB));
    l.release(&f, 5.0 * GB);
    assert_eq!(l.pending_bytes(&f), 0.0);
    assert!(l.reserve(&f, 2.0 * GB) && l.reserve(&f, 3.0 * GB));
    l.release(&f, 2.5 * GB);
    assert_eq!(l.pending_bytes(&f), 2.5 * GB);
}

#[tokio::test]
async fn a_leaked_reservation_self_heals_after_the_ttl() {
    capture_logs();
    let l = Ledger::with_ttl("sonarr", MIN_FREE, Duration::from_millis(150));
    let f = folder(MIN_FREE + 10.0 * GB);
    assert!(l.reserve(&f, 5.0 * GB));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        l.pending_bytes(&f),
        5.0 * GB,
        "a live grab is never expired early"
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(l.pending_bytes(&f), 0.0);
    assert_eq!(l.available_bytes(&f), f.free_space);
    assert!(l.reserve(&f, 5.0 * GB));
    assert!(logs().contains("pruned stale disk reservation"));
}

#[test]
fn ledgers_are_independent() {
    let (a, b) = (
        Ledger::new("radarr", MIN_FREE),
        Ledger::new("sonarr", MIN_FREE),
    );
    let f = folder(MIN_FREE + 10.0 * GB);
    assert!(a.reserve(&f, 4.0 * GB));
    assert_eq!(b.pending_bytes(&f), 0.0);
}

// --- grab log (arrGrab/grabLog tests) -------------------------------------------------

fn log_in(dir: &tempfile::TempDir) -> GrabLog {
    GrabLog(JsonlLog::new(dir.path().join("grabs.jsonl")))
}

fn ev(item: u64, kind: &str) -> Obj {
    Obj::new().put("itemId", item).put("type", kind)
}

fn field(raw: &RawValue, k: &str) -> Value {
    serde_json::from_str::<Value>(raw.get()).unwrap()[k].clone()
}

#[tokio::test]
async fn the_recorder_injects_the_app_and_keeps_key_order() {
    let dir = tempfile::tempdir().unwrap();
    let log = log_in(&dir);
    log.record(Arr::Radarr, ev(7, "grab_started").put("sub", "local:42"))
        .await;
    let text = std::fs::read_to_string(dir.path().join("grabs.jsonl")).unwrap();
    let re = regex::Regex::new(r#"^\{"ts":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z","app":"radarr","itemId":7,"type":"grab_started","sub":"local:42"\}\n$"#).unwrap();
    assert!(re.is_match(&text), "{text}");
}

#[tokio::test]
async fn a_failed_write_is_logged_not_raised() {
    capture_logs();
    let dir = tempfile::tempdir().unwrap();
    // The log path is a directory: every append fails.
    std::fs::create_dir(dir.path().join("grabs.jsonl")).unwrap();
    log_in(&dir).record(Arr::Sonarr, ev(1, "grab_failed")).await;
    assert!(logs().contains("grab log write failed"));
}

#[tokio::test]
async fn recent_is_newest_first_limited_and_skips_bad_lines() {
    let dir = tempfile::tempdir().unwrap();
    let log = log_in(&dir);
    assert!(log.recent(10).await.is_empty(), "no file yet");
    for i in 0..50 {
        log.record(Arr::Sonarr, ev(i, "grab_started")).await;
    }
    let ids: Vec<Value> = log
        .recent(5)
        .await
        .iter()
        .map(|e| field(e, "itemId"))
        .collect();
    assert_eq!(ids, [49, 48, 47, 46, 45]);
    std::fs::OpenOptions::new()
        .append(true)
        .open(dir.path().join("grabs.jsonl"))
        .and_then(|mut f| std::io::Write::write_all(&mut f, b"not json\n"))
        .unwrap();
    log.record(Arr::Sonarr, ev(50, "grab_succeeded")).await;
    // The bad line costs a slot of the tail read, as in the TS.
    let ids: Vec<Value> = log
        .recent(3)
        .await
        .iter()
        .map(|e| field(e, "itemId"))
        .collect();
    assert_eq!(ids, [50, 49]);
    let ids: Vec<Value> = log
        .recent(10)
        .await
        .iter()
        .take(3)
        .map(|e| field(e, "itemId"))
        .collect();
    assert_eq!(ids, [50, 49, 48]);
}

#[tokio::test]
async fn for_item_filters_by_app_item_and_sub() {
    let dir = tempfile::tempdir().unwrap();
    let log = log_in(&dir);
    log.record(Arr::Sonarr, ev(7, "grab_started")).await;
    log.record(Arr::Sonarr, ev(7, "no_releases").put("sub", "a"))
        .await;
    log.record(Arr::Radarr, ev(7, "grab_started")).await;
    log.record(Arr::Sonarr, ev(8, "grab_started")).await;
    log.record(Arr::Sonarr, ev(7, "grab_failed").put("sub", "b"))
        .await;
    let types =
        |v: Vec<Box<RawValue>>| -> Vec<Value> { v.iter().map(|e| field(e, "type")).collect() };
    assert_eq!(
        types(log.for_item(Arr::Sonarr, 7, 10, "a").await),
        ["no_releases", "grab_started"]
    );
    assert_eq!(
        types(log.for_item(Arr::Sonarr, 7, 10, "b").await),
        ["grab_failed", "grab_started"]
    );
    assert_eq!(
        types(log.for_item(Arr::Radarr, 7, 10, "a").await),
        ["grab_started"]
    );
    assert!(log.for_item(Arr::Sonarr, 999, 10, "a").await.is_empty());
}

#[tokio::test]
async fn a_rolled_file_still_serves_old_events() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("grabs.jsonl");
    let pad = format!(
        "{}\n",
        r#"{"app":"sonarr","itemId":42,"type":"grab_succeeded","title":"X"}"#
    );
    let mut text = pad.repeat((crate::jsonl::ROTATE_AT_BYTES as usize / pad.len()) + 5);
    text.push_str(r#"{"app":"sonarr","itemId":42,"type":"grab_succeeded","title":"PRE_ROLL"}"#);
    text.push('\n');
    std::fs::write(&path, text).unwrap();
    let log = log_in(&dir);
    log.record(Arr::Radarr, ev(1, "grab_started").put("title", "POST_ROLL"))
        .await;
    let primary = std::fs::read_to_string(&path).unwrap();
    assert_eq!(primary.lines().count(), 1);
    assert!(primary.contains("POST_ROLL"));
    assert!(
        std::fs::read_to_string(dir.path().join("grabs.jsonl.1"))
            .unwrap()
            .contains("PRE_ROLL")
    );
    let titles: Vec<Value> = log
        .recent(3)
        .await
        .iter()
        .map(|e| field(e, "title"))
        .collect();
    assert_eq!(titles, ["POST_ROLL", "PRE_ROLL", "X"]);
}

#[test]
fn the_client_union_matches_every_grab_event_type() {
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/lib/api/grabs.ts"),
    )
    .unwrap();
    let decl = src.split("export type GrabEventType =").nth(1).unwrap();
    let decl = decl.split("\n\n").next().unwrap();
    let mut client: Vec<&str> = decl.split('\'').skip(1).step_by(2).collect();
    let mut server = GRAB_EVENT_TYPES.to_vec();
    client.sort_unstable();
    server.sort_unstable();
    assert_eq!(client, server);
    assert!(server.contains(&"planned_size_exceeds_free_space"));
}

#[test]
fn grab_event_type_maps_the_status() {
    let reply = |s: u16| Reply {
        status: StatusCode::from_u16(s).unwrap(),
        headers: Default::default(),
        body: Default::default(),
    };
    assert_eq!(grab_event_type(&reply(201)), "grab_succeeded");
    assert_eq!(grab_event_type(&reply(504)), "grab_unconfirmed");
    assert_eq!(grab_event_type(&reply(500)), "grab_failed");
}

// --- add pipeline (arrAdd.test.ts) ------------------------------------------------------

#[test]
fn pick_profile_prefers_the_name_then_1080p_hd_not_any_first() {
    let p = |list: Value| -> Option<i64> {
        pick_profile(list.as_array().unwrap(), "choose me").map(|p| p["id"].as_i64().unwrap())
    };
    assert_eq!(
        p(json!([{"id":1,"name":"Any"},{"id":2,"name":"HD-1080p"},{"id":3,"name":"Choose Me"}])),
        Some(3)
    );
    assert_eq!(
        p(json!([{"id":1,"name":"Any"},{"id":2,"name":"Ultra-1080p"}])),
        Some(2)
    );
    assert_eq!(
        p(json!([{"id":1,"name":"Any"},{"id":2,"name":"HD - 720p"}])),
        Some(2)
    );
    assert_eq!(
        p(json!([{"id":1,"name":"Any"},{"id":2,"name":"SD"}])),
        Some(2)
    );
    assert_eq!(p(json!([{"id":9,"name":"Any"}])), Some(9));
    assert_eq!(p(json!([{"id":7,"name":" Choose Me "}])), Some(7));
    assert_eq!(p(json!([])), None);
}

/// tests/vectors/arr-add-defaults.json: the SPA pre-fills the Add modals with
/// the same picks (pickDefaultProfileId / pickDefaultRootFolder run the file too).
#[test]
fn add_defaults_agree_with_the_spa_vectors() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/vectors/arr-add-defaults.json"
    );
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for c in v["profiles"].as_array().unwrap() {
        // Config trims and lowercases DEFAULT_PROFILE_NAME.
        let preferred = c["preferred"].as_str().unwrap().trim().to_lowercase();
        let got = pick_profile(c["profiles"].as_array().unwrap(), &preferred).map(|p| &p["id"]);
        assert_eq!(
            got,
            c["expected_id"].as_i64().map(|_| &c["expected_id"]),
            "{}",
            c["name"]
        );
    }
    for c in v["root_folders"].as_array().unwrap() {
        // Config turns a blank value into unset.
        let configured = c["configured"].as_str().filter(|s| !s.is_empty());
        let got = default_folder(c["folders"].as_array().unwrap(), configured)
            .ok()
            .map(path_str);
        let want = match (configured, c["matched"].as_bool().unwrap()) {
            // A configured path the live list lacks is refused, not replaced.
            (Some(_), false) => None,
            _ => c["expected_path"].as_str(),
        };
        assert_eq!(got, want, "{}", c["name"]);
    }
}

#[test]
fn normalize_path_strips_trailing_separators_and_lowercases() {
    assert_eq!(normalize_path("/Data/TV///"), "/data/tv");
    assert_eq!(normalize_path("C:\\Media\\Movies\\"), "c:\\media\\movies");
}

#[test]
fn the_space_gate_fails_closed() {
    let l = Ledger::new("radarr", MIN_FREE);
    let huge = MIN_FREE + 500.0 * GB;
    let gate = |path: Value, folders: Value| {
        gate_root_folder_space(Some(&path), folders.as_array().unwrap(), &l, MIN_FREE)
    };
    let fail = |r: Result<(Folder, f64), (StatusCode, Value)>| r.unwrap_err();
    assert_eq!(
        gate_root_folder_space(None, &[], &l, MIN_FREE)
            .unwrap_err()
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        fail(gate(json!(""), json!([]))).1,
        json!({ "error": "rootFolderPath_required" })
    );
    assert_eq!(
        fail(gate(
            json!("/data/none"),
            json!([{ "path": "/data/tv", "freeSpace": huge }])
        )),
        (
            StatusCode::BAD_REQUEST,
            json!({ "error": "unknown_root_folder", "path": "/data/none" })
        )
    );
    for free in [json!(null), json!("lots"), json!({})] {
        let (status, body) = fail(gate(
            json!("/data/tv"),
            json!([{ "path": "/data/tv", "freeSpace": free }]),
        ));
        assert_eq!(
            (status, &body["error"]),
            (
                StatusCode::INSUFFICIENT_STORAGE,
                &json!("free_space_unknown")
            )
        );
    }
    let below = fail(gate(
        json!("/data/tv"),
        json!([{ "path": "/data/tv", "freeSpace": MIN_FREE - 1.0 }]),
    ));
    assert_eq!(below.1["error"], "insufficient_disk_space");
    let (f, _) = gate(
        json!("/data/tv"),
        json!([{ "path": "/data/tv", "freeSpace": huge }]),
    )
    .unwrap();
    assert_eq!(
        f,
        Folder {
            path: "/data/tv".into(),
            free_space: huge
        }
    );
}

#[test]
fn the_space_gate_tolerates_slash_and_case_and_reports_the_upstream_path() {
    let l = Ledger::new("radarr", MIN_FREE);
    let folders = [json!({ "path": "/data/tv/", "freeSpace": MIN_FREE + GB })];
    for want in ["/data/tv/", "/data/tv", "/DATA/TV"] {
        let (f, _) = gate_root_folder_space(Some(&json!(want)), &folders, &l, MIN_FREE).unwrap();
        assert_eq!(f.path, "/data/tv/");
    }
    // An exact match wins over a normalized one.
    let two = [
        json!({ "path": "/data/Media", "freeSpace": MIN_FREE + GB }),
        json!({ "path": "/data/media", "freeSpace": MIN_FREE + 2.0 * GB }),
    ];
    let (f, _) = gate_root_folder_space(Some(&json!("/data/media")), &two, &l, MIN_FREE).unwrap();
    assert_eq!(f.free_space, MIN_FREE + 2.0 * GB);
}

#[test]
fn the_space_gate_subtracts_in_flight_reservations() {
    let l = Ledger::new("radarr", MIN_FREE);
    let f = Folder {
        path: "/data/tv-gate".into(),
        free_space: MIN_FREE + 10.0 * GB,
    };
    assert!(l.reserve(&f, 9.0 * GB));
    let folders = [json!({ "path": "/data/tv-gate", "freeSpace": f.free_space })];
    let (_, available) =
        gate_root_folder_space(Some(&json!("/data/tv-gate")), &folders, &l, MIN_FREE).unwrap();
    assert_eq!(available, MIN_FREE + GB);
}

#[test]
fn the_failure_payload_leaves_out_empty_fields() {
    let u = Unresolved {
        reason: "default_root_folder_missing",
        expected_path: Some("/data/configured".into()),
        available_paths: Some(vec![json!("/data/other")]),
        expected_name: Some(String::new()),
        ..Default::default()
    };
    assert_eq!(
        u.payload(),
        json!({ "error": "default_root_folder_missing", "expected_path": "/data/configured", "available_paths": ["/data/other"] })
    );
    assert_eq!(u.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        Unresolved::new("unknown_root_folder").status(),
        StatusCode::BAD_REQUEST
    );
}

// --- advanced options (arrAdvanced.test.ts) ---------------------------------------------

const DEC_GB: f64 = 1e9;

fn raw_release(over: Value) -> Value {
    let mut r = json!({
        "guid": "g", "indexerId": 1, "title": "T", "size": 3.0 * DEC_GB, "qualityWeight": 40,
        "quality": { "quality": { "name": "WEBDL-1080p" } }, "languages": [{ "name": "English" }],
        "protocol": "usenet", "seeders": 12, "indexer": "Eweka", "ageHours": 5,
        "rejected": false, "rejections": [],
    });
    for (k, v) in over.as_object().unwrap() {
        if v.is_null() {
            r.as_object_mut().unwrap().remove(k);
        } else {
            r[k] = v.clone();
        }
    }
    r
}

#[test]
fn project_release_sizes_caps_and_defaults() {
    let cap = Some(5.0 * DEC_GB);
    assert_eq!(
        project_release(&raw_release(json!({})), cap)["overCap"],
        false
    );
    let over = project_release(&raw_release(json!({ "size": 12.0 * DEC_GB })), cap);
    assert_eq!(
        (over["overCap"].clone(), over["sizeGb"].clone()),
        (json!(true), json!(12))
    );
    assert_eq!(
        project_release(&raw_release(json!({ "size": 99.0 * DEC_GB })), None)["overCap"],
        false
    );
    let bare = project_release(
        &json!({ "guid": "g", "indexerId": 1, "title": "T", "size": "x" }),
        cap,
    );
    assert_eq!(bare["size"], 0);
    assert_eq!(bare["sizeGb"], 0);
    assert_eq!(bare["protocol"], "unknown");
    assert_eq!(bare["quality"], "Unknown");
    assert_eq!(bare["languages"], json!([]));
    assert_eq!(bare["rejections"], json!([]));
    assert_eq!(
        project_release(&raw_release(json!({ "ageHours": null, "age": 2 })), cap)["ageHours"],
        48
    );
    assert_eq!(
        project_release(&raw_release(json!({ "temporarilyRejected": true })), cap)["rejected"],
        true
    );
}

#[test]
fn build_command_body_allowlists_names_and_fields() {
    let allow = [
        CommandSpec {
            name: "RefreshSeries",
            requires: &[],
            passthrough: &["seriesId"],
        },
        CommandSpec {
            name: "EpisodeSearch",
            requires: &["episodeIds"],
            passthrough: &["episodeIds"],
        },
    ];
    assert_eq!(
        build_command_body(&json!(null), &allow),
        Err("invalid_body")
    );
    assert_eq!(build_command_body(&json!([1]), &allow), Err("invalid_body"));
    assert_eq!(
        build_command_body(&json!({ "name": "Backup" }), &allow),
        Err("command_not_allowed")
    );
    assert_eq!(
        build_command_body(&json!({ "name": "EpisodeSearch" }), &allow),
        Err("missing_required_field")
    );
    assert_eq!(
        build_command_body(
            &json!({ "name": "EpisodeSearch", "episodeIds": [] }),
            &allow
        ),
        Err("missing_required_field")
    );
    assert_eq!(
        build_command_body(
            &json!({ "name": "RefreshSeries", "seriesId": 5, "evil": "x" }),
            &allow
        ),
        Ok(json!({ "name": "RefreshSeries", "seriesId": 5 }))
    );
}

#[test]
fn edit_patch_keeps_only_well_typed_allowlisted_fields() {
    let p = extract_edit_patch(&json!({
        "monitored": false, "qualityProfileId": 7, "rootFolderPath": "/data", "title": "HACK", "path": "/etc", "id": 9,
    }));
    assert_eq!(
        Value::Object(p),
        json!({ "monitored": false, "qualityProfileId": 7, "rootFolderPath": "/data" })
    );
    assert!(
        extract_edit_patch(
            &json!({ "monitored": "yes", "qualityProfileId": "7", "rootFolderPath": "" })
        )
        .is_empty()
    );
    assert!(extract_edit_patch(&json!(null)).is_empty());
    assert!(extract_edit_patch(&json!([1])).is_empty());
    let patch = extract_edit_patch(&json!({ "monitored": false, "qualityProfileId": 9 }));
    assert_eq!(
        merge_edit(
            json!({ "id": 5, "title": "Keep", "monitored": true, "qualityProfileId": 1 }),
            patch
        ),
        json!({ "id": 5, "title": "Keep", "monitored": false, "qualityProfileId": 9 })
    );
}

#[test]
fn map_history_accepts_both_shapes_and_sorts_newest_first() {
    let rec = json!({ "date": "2026-06-20T00:00:00Z", "eventType": "grabbed", "sourceTitle": "X", "quality": { "quality": { "name": "WEBDL-1080p" } } });
    assert_eq!(map_history(&json!([rec.clone()])).len(), 1);
    assert_eq!(map_history(&json!({ "records": [rec] })).len(), 1);
    assert!(map_history(&json!(null)).is_empty());
    assert!(map_history(&json!({ "nope": true })).is_empty());
    let out = map_history(&json!([
        { "date": "2026-06-01T00:00:00Z", "eventType": "grabbed", "sourceTitle": "old" },
        { "date": "not-a-date", "eventType": "grabbed", "sourceTitle": "bad" },
        { "date": "2026-06-20T00:00:00Z", "eventType": "grabbed", "sourceTitle": "new" },
    ]));
    let titles: Vec<&Value> = out.iter().map(|r| &r["sourceTitle"]).collect();
    assert_eq!(titles, ["new", "old", "bad"]);
    assert_eq!(out[2]["quality"], "Unknown");
    let a = &map_history(&json!([{ "date": "d", "seasonNumber": 2, "episodeId": 9 }]))[0];
    assert_eq!(
        (a["seasonNumber"].clone(), a["episodeId"].clone()),
        (json!(2), json!(9))
    );
    let b = &map_history(&json!([{ "date": "d" }]))[0];
    assert!(b.get("seasonNumber").is_none() && b.get("episodeId").is_none());
}

#[test]
fn parse_interactive_grab_validates_and_defaults() {
    assert_eq!(parse_interactive_grab(&json!(null)), None);
    assert_eq!(
        parse_interactive_grab(&json!({ "guid": "", "indexerId": 1 })),
        None
    );
    assert_eq!(
        parse_interactive_grab(&json!({ "guid": "g", "indexerId": "x" })),
        None
    );
    assert_eq!(
        parse_interactive_grab(&json!({ "guid": "g", "indexerId": 9 })),
        Some(GrabPick {
            guid: "g".into(),
            indexer_id: 9.0,
            allow_over_cap: false
        })
    );
    assert!(
        parse_interactive_grab(&json!({ "guid": "g", "indexerId": 9, "allowOverCap": true }))
            .unwrap()
            .allow_over_cap
    );
}

#[tokio::test]
async fn every_interactive_outcome_maps_to_the_contract() {
    let run = async |r: InteractiveGrab| {
        let res = interactive_grab_response(r);
        let status = res.status().as_u16();
        let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
        (status, serde_json::from_slice::<Value>(&body).unwrap())
    };
    assert_eq!(
        run(InteractiveGrab::Grabbed {
            title: Some(json!("T")),
            size_gb: 3.0
        })
        .await,
        (
            200,
            json!({ "status": "grabbed", "title": "T", "sizeGb": 3 })
        )
    );
    assert_eq!(run(InteractiveGrab::OverCap).await.0, 424);
    assert_eq!(run(InteractiveGrab::ReleaseNotFound).await.0, 404);
    assert_eq!(
        run(InteractiveGrab::NoSpace).await,
        (507, json!({ "error": "insufficient_disk_space" }))
    );
    assert_eq!(
        run(InteractiveGrab::UpstreamError(503)).await,
        (502, json!({ "error": "grab_failed", "status": 503 }))
    );
}

fn ok_reply(status: u16) -> Result<Reply, upstream::Error> {
    Ok(Reply {
        status: StatusCode::from_u16(status).unwrap(),
        headers: Default::default(),
        body: Default::default(),
    })
}

async fn interactive(
    log: &GrabLog,
    pick: GrabPick,
    releases: Option<Vec<Value>>,
    grab_status: u16,
    reserve: Option<(&Ledger, &Folder)>,
    posted: &std::sync::atomic::AtomicUsize,
) -> InteractiveGrab {
    execute_interactive_grab(
        log,
        GrabRequest {
            app: Arr::Radarr,
            item_id: 5,
            sub: "local:1",
            pick: &pick,
            cap_gb: 5.0,
            reserve,
        },
        |_| Some(5.0 * DEC_GB),
        async || Ok(releases),
        async |_: &str, _: f64| {
            posted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            ok_reply(grab_status)
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn execute_interactive_grab_paths() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let dir = tempfile::tempdir().unwrap();
    let log = log_in(&dir);
    let pick = |guid: &str, over: bool| GrabPick {
        guid: guid.into(),
        indexer_id: 9.0,
        allow_over_cap: over,
    };
    let rel = |size: f64| {
        vec![
            json!({ "guid": "g", "indexerId": 9, "title": "Picked", "size": size, "qualityWeight": 50 }),
        ]
    };
    let posted = AtomicUsize::new(0);

    // The ledger refuses: 507, and the grab is never POSTed.
    let tight = Ledger::new("radarr", MIN_FREE);
    let f = folder(MIN_FREE + DEC_GB);
    let r = interactive(
        &log,
        pick("g", false),
        Some(rel(3.0 * DEC_GB)),
        200,
        Some((&tight, &f)),
        &posted,
    )
    .await;
    assert_eq!(
        (r, posted.load(Ordering::SeqCst)),
        (InteractiveGrab::NoSpace, 0)
    );
    let types: Vec<Value> = log
        .recent(5)
        .await
        .iter()
        .map(|e| field(e, "type"))
        .collect();
    assert_eq!(types, ["grab_started"]);

    // Reserved around the grab, released after.
    let roomy = Ledger::new("radarr", MIN_FREE);
    let f = folder(MIN_FREE + 100.0 * DEC_GB);
    let r = interactive(
        &log,
        pick("g", false),
        Some(rel(3.0 * DEC_GB)),
        200,
        Some((&roomy, &f)),
        &posted,
    )
    .await;
    assert_eq!(
        r,
        InteractiveGrab::Grabbed {
            title: Some(json!("Picked")),
            size_gb: 3.0
        }
    );
    assert_eq!(roomy.pending_bytes(&f), 0.0);

    assert_eq!(
        interactive(&log, pick("g", false), None, 200, None, &posted).await,
        InteractiveGrab::UpstreamError(502)
    );
    assert_eq!(
        interactive(
            &log,
            pick("ghost", false),
            Some(rel(3.0 * DEC_GB)),
            200,
            None,
            &posted
        )
        .await,
        InteractiveGrab::ReleaseNotFound
    );
    let before = posted.load(Ordering::SeqCst);
    assert_eq!(
        interactive(
            &log,
            pick("g", false),
            Some(rel(30.0 * DEC_GB)),
            200,
            None,
            &posted
        )
        .await,
        InteractiveGrab::OverCap
    );
    assert_eq!(
        posted.load(Ordering::SeqCst),
        before,
        "no grab over the cap"
    );
    assert!(matches!(
        interactive(
            &log,
            pick("g", true),
            Some(rel(30.0 * DEC_GB)),
            200,
            None,
            &posted
        )
        .await,
        InteractiveGrab::Grabbed { .. }
    ));
    assert_eq!(
        interactive(
            &log,
            pick("g", false),
            Some(rel(3.0 * DEC_GB)),
            500,
            None,
            &posted
        )
        .await,
        InteractiveGrab::UpstreamError(500)
    );
}

// --- numbers ------------------------------------------------------------------------

#[test]
fn js_rounding_helpers() {
    assert_eq!(round2(1.073741824), 1.07);
    assert_eq!(round2(0.125), 0.13);
    assert_eq!(
        gb_2dp(134217728.0),
        0.13,
        "toFixed breaks an exact tie upward"
    );
    assert_eq!(gb_2dp(3.0 * GB), 3.0);
    assert_eq!(gb_2dp(2.5 * GB + 1.0), 2.5);
    assert_eq!(num(10.0), json!(10));
    assert_eq!(num(f64::NAN), Value::Null);
    assert_eq!(js_str(&json!(42.0)), "42");
    assert_eq!(js_str(&json!("x")), "x");
}

#[test]
fn obj_keeps_insertion_order_and_spread_semantics() {
    let o = Obj::new()
        .put("b", 1)
        .put("a", "x")
        .opt("skip", None::<u8>)
        .put("b", 2);
    assert_eq!(o.json(), r#"{"b":2,"a":"x"}"#);
    let nested = Obj::new()
        .put("z", 1)
        .put("inner", Obj::new().put("y", true).put("x", 0));
    assert_eq!(
        serde_json::to_string(&nested).unwrap(),
        r#"{"z":1,"inner":{"y":true,"x":0}}"#
    );
}
