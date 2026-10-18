//! Boot rules carried over from server/env.test.ts (the Plex cases are gone
//! with Plex) and services/authPosture.test.ts.

use std::collections::HashMap;

use super::*;

const BASE_SESSION_SECRET: &str = "test-secret-test-secret-test-secret-test-secret";

/// setBaselineEnv(): dev, every *arr configured, one shared root folder.
fn baseline() -> Vec<(&'static str, String)> {
    vec![
        ("SERVE_SPA", "0".into()),
        ("SESSION_SECRET", BASE_SESSION_SECRET.into()),
        (
            "STREAM_TOKEN_SECRET",
            "stream-secret-BBBBBBBBBBBBBBBBBBBBBBBBBBBB".into(),
        ),
        ("SONARR_API_KEY", "k".into()),
        ("RADARR_API_KEY", "k".into()),
        ("SAB_API_KEY", "k".into()),
        ("DEFAULT_ROOT_FOLDER_PATH", "/data/media".into()),
    ]
}

/// setBareProdEnv(): production with nothing optional configured.
fn bare_prod() -> Vec<(&'static str, String)> {
    let mut env: Vec<_> = baseline()
        .into_iter()
        .filter(|(k, _)| !k.ends_with("_API_KEY") && *k != "DEFAULT_ROOT_FOLDER_PATH")
        .collect();
    env.extend([
        ("NODE_ENV", "production".into()),
        ("ALLOWED_ORIGINS", "https://app.example".into()),
        (
            "SESSION_SECRET",
            "session-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
        ),
        (
            "DEVICE_TOKEN_SECRET",
            "device-secret-CCCCCCCCCCCCCCCCCCCCCCCCCCCC".into(),
        ),
        (
            "INTERNAL_PRINCIPAL_SECRET",
            "internal-secret-DDDDDDDDDDDDDDDDDDDDDDDDDD".into(),
        ),
    ]);
    env
}

/// Later entries win; an empty value is passed through as set-but-blank.
fn build(env: &[(&str, String)], over: &[(&str, &str)]) -> Result<Config, String> {
    let mut map: HashMap<String, String> = env
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    for (k, v) in over {
        map.insert(k.to_string(), v.to_string());
    }
    Config::from_lookup(|k| map.get(k).cloned())
}

fn without(env: Vec<(&'static str, String)>, keys: &[&str]) -> Vec<(&'static str, String)> {
    env.into_iter().filter(|(k, _)| !keys.contains(k)).collect()
}

fn err(r: Result<Config, String>) -> String {
    match r {
        Ok(_) => panic!("expected a boot error"),
        Err(e) => e,
    }
}

#[test]
fn blank_urls_fall_back_to_the_nas_host() {
    let c = build(
        &baseline(),
        &[("SONARR_URL", ""), ("RADARR_URL", ""), ("SAB_URL", "")],
    )
    .unwrap();
    assert_eq!(c.sonarr_url, "http://theemeraldexchange.local:8989/tv");
    assert_eq!(c.radarr_url, "http://theemeraldexchange.local:7878/movies");
    assert_eq!(c.sab_url, "http://theemeraldexchange.local:8080");
    let c = build(&baseline(), &[("SONARR_URL", "   "), ("SAB_URL", "\t")]).unwrap();
    assert_eq!(c.sonarr_url, "http://theemeraldexchange.local:8989/tv");
    assert_eq!(c.sab_url, "http://theemeraldexchange.local:8080");
    let c = build(
        &baseline(),
        &[
            ("SONARR_URL", "http://s:1"),
            ("RADARR_URL", "http://r:2"),
            ("SAB_URL", "http://b:3"),
        ],
    )
    .unwrap();
    assert_eq!(
        (
            c.sonarr_url.as_str(),
            c.radarr_url.as_str(),
            c.sab_url.as_str()
        ),
        ("http://s:1", "http://r:2", "http://b:3")
    );
}

#[test]
fn trusted_client_ip_headers_only_with_the_flag() {
    assert!(
        !build(&baseline(), &[])
            .unwrap()
            .auth
            .trust_client_ip_headers
    );
    assert!(
        build(&baseline(), &[("TRUST_CLIENT_IP_HEADERS", "1")])
            .unwrap()
            .auth
            .trust_client_ip_headers
    );
}

#[test]
fn production_boots_with_no_arr_sab_or_telemetry() {
    let c = build(&bare_prod(), &[]).unwrap();
    assert!(c.auth.is_prod);
    assert_eq!(c.sonarr_api_key, None);
    assert_eq!(c.radarr_api_key, None);
    assert_eq!(c.sab_api_key, None);
    assert_eq!(c.telemetry_dsn, None);
    assert!(!c.sonarr_enabled() && !c.radarr_enabled() && !c.sab_enabled());
}

#[test]
fn production_telemetry_enabled_without_a_dsn_fails() {
    assert!(err(build(&bare_prod(), &[("TELEMETRY_ENABLED", "1")])).contains("EEX_TELEMETRY_DSN"));
    let c = build(
        &bare_prod(),
        &[
            ("TELEMETRY_ENABLED", "1"),
            ("EEX_TELEMETRY_DSN", "https://k@g.example/1"),
        ],
    )
    .unwrap();
    assert_eq!(c.telemetry_dsn.as_deref(), Some("https://k@g.example/1"));
}

#[test]
fn production_root_folder_gate_fires_only_for_a_configured_arr() {
    assert!(err(build(&bare_prod(), &[("SONARR_API_KEY", "k")])).contains("ROOT_FOLDER_PATH"));
    assert!(err(build(&bare_prod(), &[("RADARR_API_KEY", "k")])).contains("ROOT_FOLDER_PATH"));
    let c = build(
        &bare_prod(),
        &[
            ("SONARR_API_KEY", "k"),
            ("DEFAULT_SONARR_ROOT_FOLDER_PATH", "/tv"),
        ],
    )
    .unwrap();
    assert_eq!(c.default_sonarr_root_folder_path.as_deref(), Some("/tv"));
    assert_eq!(c.default_radarr_root_folder_path, None);
    // The shared path covers both; a per-app path wins over it.
    let c = build(
        &baseline(),
        &[("DEFAULT_RADARR_ROOT_FOLDER_PATH", "/movies")],
    )
    .unwrap();
    assert_eq!(
        c.default_sonarr_root_folder_path.as_deref(),
        Some("/data/media")
    );
    assert_eq!(
        c.default_radarr_root_folder_path.as_deref(),
        Some("/movies")
    );
}

#[test]
fn serve_spa_relaxes_allowed_origins_in_production() {
    let env = without(bare_prod(), &["ALLOWED_ORIGINS"]);
    let c = build(&env, &[("SERVE_SPA", "1")]).unwrap();
    assert!(c.auth.serve_spa);
    assert!(c.auth.allowed_origins.is_empty());
    assert!(err(build(&env, &[("SERVE_SPA", "0")])).contains("ALLOWED_ORIGINS"));
    for blank in ["", "   "] {
        assert!(
            err(build(&bare_prod(), &[("ALLOWED_ORIGINS", blank)])).contains("ALLOWED_ORIGINS")
        );
    }
    let c = build(
        &bare_prod(),
        &[("ALLOWED_ORIGINS", "https://a.example,https://b.example")],
    )
    .unwrap();
    assert_eq!(
        c.auth.allowed_origins,
        ["https://a.example", "https://b.example"]
    );
    assert!(build(&baseline(), &[("ALLOWED_ORIGINS", "")]).is_ok());
}

#[test]
fn production_session_secret_strength() {
    for (value, needle) in [
        ("short", "too short"),
        (&"a".repeat(31)[..], "too short"),
        ("CHANGEME", "placeholder"),
    ] {
        let e = err(build(&bare_prod(), &[("SESSION_SECRET", value)]));
        assert!(e.contains("SESSION_SECRET") && e.contains(needle), "{e}");
    }
    assert!(build(&bare_prod(), &[("SESSION_SECRET", &"a".repeat(32))]).is_ok());
    // Long enough, but still a placeholder? Only exact placeholders are refused.
    assert!(build(&bare_prod(), &[("SESSION_SECRET", &"changeme".repeat(5))]).is_ok());
    assert!(build(&baseline(), &[("SESSION_SECRET", "short")]).is_ok());
}

#[test]
fn numeric_vars_fail_closed() {
    for (k, v) in [
        ("MIN_FREE_GB", "abc"),
        ("MIN_FREE_GB", "0"),
        ("MIN_FREE_GB", "-50"),
        ("MIN_FREE_GB", "NaN"),
        ("MIN_FREE_GB", "inf"),
        ("MAX_MOVIE_SIZE_GB", "big"),
        ("PORT", "3001.5"),
        ("PORT", "http"),
        ("PORT", "70000"),
        ("DB_BACKUP_KEEP", "1.5"),
        ("MEDIA_STREAM_TOKEN_TTL_SECS", "0"),
        ("ARR_MUTATE_RATE_CAPACITY", "x"),
    ] {
        assert!(err(build(&baseline(), &[(k, v)])).contains(k), "{k}={v}");
    }
    // Blank is unset: the default.
    assert_eq!(
        build(&baseline(), &[("MAX_TV_GB_PER_EPISODE", "")])
            .unwrap()
            .max_tv_gb_per_episode,
        5.0
    );
    let c = build(
        &baseline(),
        &[
            ("MIN_FREE_GB", "200"),
            ("MAX_MOVIE_SIZE_GB", "15"),
            ("MAX_TV_GB_PER_EPISODE", "7"),
            ("PORT", "3002"),
        ],
    )
    .unwrap();
    assert_eq!(
        (
            c.min_free_gb,
            c.max_movie_gb,
            c.max_tv_gb_per_episode,
            c.port
        ),
        (200.0, 15.0, 7.0, 3002)
    );
}

#[test]
fn defaults() {
    let c = build(&baseline(), &[]).unwrap();
    assert_eq!(c.port, 3001);
    assert_eq!(
        (c.min_free_gb, c.max_movie_gb, c.max_tv_gb_per_episode),
        (100.0, 10.0, 5.0)
    );
    assert_eq!(c.rejections_path, "./data/rejections.json");
    assert_eq!(c.user_feedback_path, "./data/user-feedback.json");
    assert_eq!(c.user_watchlist_path, "./data/user-watchlist.json");
    assert_eq!(c.user_policies_path, "./data/user-policies.json");
    assert_eq!(c.usage_log_path, "./data/usage.jsonl");
    assert_eq!(c.grab_log_path, "./data/grabs.jsonl");
    assert_eq!(c.recommender_db_path, "./data/exchange.db");
    assert_eq!(c.media_db_path, "./data/media.db");
    assert_eq!(c.media_core_url, "http://127.0.0.1:8002");
    assert_eq!(c.transcoder_url, "http://127.0.0.1:8003");
    assert_eq!(c.media_stream_token_ttl_secs, 21_600);
    assert_eq!(
        (c.db_backup_dir.as_str(), c.db_backup_keep),
        ("./data/backups", 7)
    );
    assert_eq!(c.db_backup_cron, "30 3 * * *");
    assert_eq!(c.release, "dev");
    assert_eq!(
        (
            c.arr_mutate_rate_capacity,
            c.arr_mutate_rate_refill,
            c.arr_mutate_rate_interval_ms
        ),
        (12, 12, 60_000)
    );
    assert!(!c.use_media_core && !c.music_roots_configured && !c.youtube_roots_configured);
    assert!(!c.dvr_enabled && !c.dvr_mounted());
    let c = build(
        &baseline(),
        &[("DVR_ENABLED", "true"), ("MUSIC_LIBRARY_PATHS", " /m ")],
    )
    .unwrap();
    assert!(c.dvr_mounted() && c.music_roots_configured);
    let c = build(&baseline(), &[("DVR_ENABLED", "1"), ("IPTV_DISABLED", "1")]).unwrap();
    assert!(!c.dvr_mounted());
    // Data paths keep a set-but-empty value, as `process.env.X ?? default` did.
    assert_eq!(
        build(&baseline(), &[("GRAB_LOG_PATH", "")])
            .unwrap()
            .grab_log_path,
        ""
    );
}

#[test]
fn service_urls_default_per_environment() {
    let c = build(&baseline(), &[("NODE_ENV", "test")]).unwrap();
    assert_eq!(c.recommender_url, "http://localhost:8000");
    let c = build(&bare_prod(), &[]).unwrap();
    assert_eq!(c.recommender_url, "http://recommender:8000");
    assert_eq!(c.media_core_url, "http://media-core:8002");
    assert_eq!(c.transcoder_url, "http://transcoder:8003");
    let c = build(
        &bare_prod(),
        &[("RECOMMENDER_URL", "http://10.0.0.99:9100")],
    )
    .unwrap();
    assert_eq!(c.recommender_url, "http://10.0.0.99:9100");
}

#[test]
fn local_recommender_needs_its_event_secret() {
    for secret in [None, Some("   ")] {
        let mut over = vec![("USE_LOCAL_RECOMMENDER", "1")];
        if let Some(s) = secret {
            over.push(("RECOMMENDER_EVENT_SECRET", s));
        }
        assert!(err(build(&baseline(), &over)).contains("RECOMMENDER_EVENT_SECRET"));
    }
    let c = build(
        &baseline(),
        &[
            ("USE_LOCAL_RECOMMENDER", "1"),
            ("RECOMMENDER_EVENT_SECRET", "shared-secret"),
        ],
    )
    .unwrap();
    assert!(c.use_local_recommender);
    assert_eq!(c.recommender_event_secret.as_deref(), Some("shared-secret"));
    // Production holds it to the secret rule.
    assert!(
        err(build(
            &bare_prod(),
            &[("RECOMMENDER_EVENT_SECRET", "secret")]
        ))
        .contains("placeholder")
    );
}

#[test]
fn default_profile_name_is_case_folded() {
    assert_eq!(
        build(&baseline(), &[]).unwrap().default_profile_name,
        "choose me"
    );
    assert_eq!(
        build(&baseline(), &[("DEFAULT_PROFILE_NAME", "Choose Me")])
            .unwrap()
            .default_profile_name,
        "choose me"
    );
    assert_eq!(
        build(&baseline(), &[("DEFAULT_PROFILE_NAME", "HD-1080P")])
            .unwrap()
            .default_profile_name,
        "hd-1080p"
    );
}

#[test]
fn token_secrets_fail_closed() {
    for k in [
        "STREAM_TOKEN_SECRET",
        "DEVICE_TOKEN_SECRET",
        "INTERNAL_PRINCIPAL_SECRET",
    ] {
        assert!(
            err(build(&without(bare_prod(), &[k]), &[])).contains(k),
            "{k}"
        );
    }
    let same = "identical-secret-XXXXXXXXXXXXXXXXXXXXXXXX";
    assert!(
        build(
            &baseline(),
            &[("SESSION_SECRET", same), ("STREAM_TOKEN_SECRET", same)]
        )
        .is_err()
    );
    assert!(
        build(
            &baseline(),
            &[
                ("SESSION_SECRET", same),
                ("INTERNAL_PRINCIPAL_SECRET", same)
            ]
        )
        .is_err()
    );
}

#[test]
fn suggestions_model() {
    assert_eq!(
        build(&baseline(), &[]).unwrap().suggestions_model,
        "claude-haiku-4-5"
    );
    assert_eq!(
        build(&baseline(), &[("SUGGESTIONS_MODEL", "   ")])
            .unwrap()
            .suggestions_model,
        "claude-haiku-4-5"
    );
    assert_eq!(
        build(&baseline(), &[("SUGGESTIONS_MODEL", " claude-sonnet-4-5 ")])
            .unwrap()
            .suggestions_model,
        "claude-sonnet-4-5"
    );
}

fn auth_config(over: &[(&str, &str)]) -> auth::config::Config {
    build(&baseline(), over).unwrap().auth
}

#[test]
fn posture_reports_only_public_configuration() {
    let mut c = auth_config(&[
        ("APPLE_CLIENT_ID", "com.example.web"),
        ("GOOGLE_CLIENT_ID", "public-google-client-id"),
        ("TRUST_CLIENT_IP_HEADERS", "1"),
        ("ALLOWED_ORIGINS", "https://app.example.test"),
    ]);
    c.is_prod = true;
    let p = auth_posture(&c);
    assert_eq!(
        p,
        AuthPosture {
            event: "auth_posture",
            providers: Providers {
                apple: true,
                google: true,
                workos: false
            },
            serve_spa: false,
            trusted_client_ip_headers: true,
            session_cookie_same_site: "none",
            allowed_origins: vec!["https://app.example.test".into()],
        }
    );
    let json = serde_json::to_string(&p).unwrap();
    assert!(!json.contains("client-id"));
    assert!(
        json.starts_with(r#"{"event":"auth_posture","providers":{"apple":true"#),
        "{json}"
    );
}

#[test]
fn posture_reports_lax_for_same_origin_and_development() {
    let mut c = auth_config(&[("WORKOS_CLIENT_ID", "client_public"), ("SERVE_SPA", "1")]);
    c.is_prod = true;
    let p = auth_posture(&c);
    assert!(p.providers.workos && !p.providers.apple && !p.providers.google);
    assert_eq!(p.session_cookie_same_site, "lax");
    let c = auth_config(&[]);
    assert_eq!(auth_posture(&c).session_cookie_same_site, "lax");
}

#[test]
fn posture_never_logs_url_credentials_or_paths() {
    let c = auth_config(&[(
        "ALLOWED_ORIGINS",
        "https://operator:secret@app.example.test/private,https://trailing-slash.example.test/,ftp://x.example,HTTPS://UPPER.example",
    )]);
    let p = auth_posture(&c);
    assert_eq!(p.allowed_origins, vec!["invalid_origin"; 4]);
    let json = serde_json::to_string(&p).unwrap();
    for leak in ["operator", "secret", "private"] {
        assert!(!json.contains(leak));
    }
}
