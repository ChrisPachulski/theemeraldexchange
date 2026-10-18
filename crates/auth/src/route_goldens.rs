//! Replays tests/fixtures/route-goldens.json through [`crate::router`]. The
//! generator (gen-auth-goldens.ts) ran the untouched TS route modules mounted
//! at app.ts's paths over the same seeded server.db; here every scenario must
//! give the same status, the same raw body text byte for byte (after the
//! shared normalization of the scenario's `volatile` fields), the same
//! Set-Cookie, the same iptv calls and the same final DB state.
//!
//! Documented deltas, applied to the TS side before comparing:
//!   - GET /api/auth/methods has no `plex` key (Plex is dropped).
//!   - A synthesized ADMIN_SUBS member's auth_mode is its sub's provider; TS
//!     said `plex` for any sub not starting with `apple:`.

use serde_json::{Map, Value};
use sqlx::SqlitePool;

use crate::AuthState;
use crate::testutil::*;

const OWNER: &str = "workos:user_01E4ZCR3C56J083X43JQXF3JK5";

fn goldens() -> &'static Value {
    static G: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    G.get_or_init(|| {
        serde_json::from_str(include_str!("../tests/fixtures/route-goldens.json")).unwrap()
    })
}

/// The string value of the first `"key":"..."` in `text`.
fn string_value(text: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\":\"");
    let start = text.find(&pat)? + pat.len();
    let len = text[start..].find('"')?;
    Some(text[start..start + len].to_string())
}

/// gen-auth-goldens.ts's normalize(): a `code` value is replaced everywhere
/// (verify_url embeds it), then every `"key":"<string>"` of a volatile key
/// becomes `"key":"<key>"`. The values (codes, tokens, ISO stamps, hex) never
/// hold a quote or a backslash.
fn normalize(text: &str, volatile: &[&str]) -> String {
    let mut out = text.to_string();
    if volatile.contains(&"code")
        && let Some(code) = string_value(&out, "code")
    {
        out = out.replace(&code, "<code>");
    }
    for key in volatile {
        let pat = format!("\"{key}\":\"");
        let mut next = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(i) = rest.find(&pat) {
            next.push_str(&rest[..i + pat.len()]);
            next.push_str(&format!("<{key}>"));
            let after = &rest[i + pat.len()..];
            rest = &after[after.find('"').unwrap()..];
        }
        next.push_str(rest);
        out = next;
    }
    out
}

/// The TS body with the documented deltas applied.
fn expected(ts: &str) -> String {
    ts.replace(r#"{"plex":false,"#, "{").replace(
        &format!(r#""sub":"{OWNER}","display_name":null,"role":"admin","auth_mode":"plex""#),
        &format!(r#""sub":"{OWNER}","display_name":null,"role":"admin","auth_mode":"workos""#),
    )
}

/// A query's rows as JSON objects (INTEGER or TEXT columns).
async fn rows(pool: &SqlitePool, sql: &str) -> Value {
    use sqlx::{Column, Row};
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_all(pool)
        .await
        .unwrap();
    rows.iter()
        .map(|r| {
            let mut m = Map::new();
            for c in r.columns() {
                let i = c.ordinal();
                let v = match r.try_get::<Option<i64>, _>(i) {
                    Ok(n) => n.into(),
                    Err(_) => r.try_get::<Option<String>, _>(i).unwrap().into(),
                };
                m.insert(c.name().to_string(), v);
            }
            Value::Object(m)
        })
        .collect()
}

#[test]
fn normalize_matches_the_generator() {
    let body = r#"{"code":"AB2C3DEF","verify_url":"https://x/#/link/AB2C3DEF","n":1}"#;
    assert_eq!(
        normalize(body, &["code"]),
        r#"{"code":"<code>","verify_url":"https://x/#/link/<code>","n":1}"#
    );
    let body = r#"[{"revoked_at":null},{"revoked_at":"2026-10-17 01:02:03"},{"revoked_at":"x"}]"#;
    assert_eq!(
        normalize(body, &["revoked_at"]),
        r#"[{"revoked_at":null},{"revoked_at":"<revoked_at>"},{"revoked_at":"<revoked_at>"}]"#
    );
    assert_eq!(
        normalize(r#"{"code_hash_prefix":"ab","code":"z"}"#, &["code"]),
        r#"{"code_hash_prefix":"ab","code":"<code>"}"#
    );
}

#[tokio::test]
async fn replays_the_ts_route_goldens() {
    let g = goldens();
    let iptv = iptv_stub().await;
    let db = pool().await;
    for table in [
        "server_state",
        "members",
        "device_tokens",
        "device_token_revocations",
        "invites",
        "device_link_codes",
    ] {
        insert_rows(&db, table, &g["seed"][table]).await;
    }
    let mut st = AuthState::new(
        (*db).clone(),
        config(&[
            ("ALLOWED_ORIGINS", "https://app.example"),
            ("IPTV_SERVICE_URL", &iptv.url),
        ]),
    );
    st.fixed_now = Some(g["minted_at"].as_i64().unwrap());
    let app = crate::router(st);

    let scenarios = g["scenarios"].as_array().unwrap();
    assert!(scenarios.len() > 60);
    for s in scenarios {
        let name = s["name"].as_str().unwrap();
        let headers: Vec<(&str, &str)> = s["headers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str().unwrap()))
            .collect();
        let volatile: Vec<&str> = s["volatile"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let r = call(
            &app,
            s["method"].as_str().unwrap(),
            s["path"].as_str().unwrap(),
            &headers,
            s["body"].as_str(),
        )
        .await;
        assert_eq!(
            r.status,
            s["status"].as_u64().unwrap() as u16,
            "{name}: {}",
            r.text
        );
        assert_eq!(
            normalize(&r.text, &volatile),
            expected(s["text"].as_str().unwrap()),
            "{name}"
        );
        let cookie = r
            .headers
            .get(axum::http::header::SET_COOKIE)
            .map(|v| v.to_str().unwrap());
        assert_eq!(cookie, s["set_cookie"].as_str(), "{name}");
    }

    assert_eq!(serde_json::json!(iptv.calls()), g["iptv_calls"]);
    let f = &g["final"];
    let check = |key: &'static str, sql: &'static str| {
        let pool = (*db).clone();
        async move {
            assert_eq!(rows(&pool, sql).await, f[key], "final {key}");
        }
    };
    check(
        "members",
        "SELECT sub, revoked_at IS NOT NULL AS revoked FROM members ORDER BY sub",
    )
    .await;
    check(
        "invites",
        "SELECT substr(code_hash, 1, 8) AS prefix, revoked_at IS NOT NULL AS revoked FROM invites \
         WHERE rowid <= 6 ORDER BY prefix",
    )
    .await;
    check(
        "revocations",
        "SELECT jti, reason FROM device_token_revocations ORDER BY jti",
    )
    .await;
    check(
        "device_names",
        "SELECT jti, device_name FROM device_tokens WHERE rowid <= 7 ORDER BY jti",
    )
    .await;
    check(
        "link_codes",
        "SELECT code, claimed_sub, claimed_username, claimed_role, claimed_auth_mode, \
         claimed_at IS NOT NULL AS claimed, consumed_at IS NOT NULL AS consumed \
         FROM device_link_codes WHERE code IN ('PEND2345', 'BEAR2345', 'EXPD2345', 'OLDD2345', 'LEGA2345') \
         ORDER BY code",
    )
    .await;
    for (key, table) in [
        ("invite_count", "invites"),
        ("device_count", "device_tokens"),
        ("link_code_count", "device_link_codes"),
    ] {
        let n: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
                .fetch_one(&*db)
                .await
                .unwrap();
        assert_eq!(n, f[key].as_i64().unwrap(), "final {key}");
    }
}
