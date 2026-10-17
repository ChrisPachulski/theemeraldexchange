//! Xtream Codes `player_api.php` client: creds, URL building, the lenient
//! coercions the panels need (numbers arrive as strings and vice versa), the
//! catalog parsers, and a fetch that trusts the operator-configured panel but
//! re-checks every redirect hop with the SSRF guard.

use chrono::{DateTime, SecondsFormat, Utc};
use media_core::ssrf_guard;
use reqwest::Url;
use serde_json::Value;

use crate::config::Config;

#[derive(Clone)]
pub struct Creds {
    pub host: String,
    pub username: String,
    pub password: String,
}

impl Creds {
    pub fn from_config(c: &Config) -> Result<Self, String> {
        if c.xtream_host.is_empty() || c.xtream_username.is_empty() || c.xtream_password.is_empty()
        {
            return Err("xtream_credentials_missing".into());
        }
        Ok(Creds {
            host: c.xtream_host.trim_end_matches('/').to_string(),
            username: c.xtream_username.clone(),
            password: c.xtream_password.clone(),
        })
    }
}

pub fn build_player_api_url(
    creds: &Creds,
    action: Option<&str>,
    extra: &[(&str, String)],
) -> Result<Url, String> {
    let mut url = Url::parse(&format!("{}/player_api.php", creds.host))
        .map_err(|_| "xtream_bad_host".to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("username", &creds.username)
            .append_pair("password", &creds.password);
        if let Some(a) = action {
            q.append_pair("action", a);
        }
        for (k, v) in extra {
            q.append_pair(k, v);
        }
    }
    Ok(url)
}

#[derive(Debug, PartialEq)]
pub struct AccountInfo {
    pub expires_at: Option<DateTime<Utc>>,
    pub max_connections: f64,
    pub active_connections: f64,
    pub status: String,
}

pub fn parse_account_info(payload: &Value) -> AccountInfo {
    let root = &payload["user_info"];
    // Some resellers send `active_connections` instead of `active_cons`.
    let active = match &root["active_cons"] {
        Value::Null => &root["active_connections"],
        v => v,
    };
    AccountInfo {
        expires_at: safe_epoch(&root["exp_date"]),
        max_connections: js_number_or_zero(&root["max_connections"]),
        active_connections: js_number_or_zero(active),
        status: root["status"].as_str().unwrap_or("").to_string(),
    }
}

// ---- lenient coercions (num / numOrNull / str / safeEpoch* in xtream.ts) ----

/// JS `Number(s)` for the strings panels send: trimmed, empty is 0.
pub(crate) fn parse_js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        0.0
    } else {
        t.parse::<f64>().unwrap_or(f64::NAN)
    }
}

/// `num`: numbers pass, numeric strings parse, anything else is 0.
pub fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => Some(parse_js_number(s))
            .filter(|n| n.is_finite())
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

/// `numOrNull`: null stays null, everything else goes through `num`.
pub fn num_or_null(v: &Value) -> Option<f64> {
    (!v.is_null()).then(|| num(v))
}

/// `Number(x ?? 0) || 0` as used by parseAccountInfo.
fn js_number_or_zero(v: &Value) -> f64 {
    let n = match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => parse_js_number(s),
        Value::Bool(b) => f64::from(u8::from(*b)),
        _ => 0.0,
    };
    if n.is_nan() { 0.0 } else { n }
}

/// `str`: strings pass, null is None, anything else is JS `String(v)`.
pub fn str_(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(js_string(other)),
    }
}

fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => i.to_string(),
            (None, Some(f)) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{f:.0}"),
            (None, Some(f)) => f.to_string(),
            _ => n.to_string(),
        },
        Value::Array(a) => a.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `safeEpochDate`: unix seconds (number or numeric string), positive and
/// inside the JS Date range, else None.
pub fn safe_epoch(v: &Value) -> Option<DateTime<Utc>> {
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => parse_js_number(s),
        _ => return None,
    };
    let ms = (n * 1000.0).trunc();
    if !n.is_finite() || n <= 0.0 || ms > 8.64e15 {
        return None;
    }
    DateTime::from_timestamp_millis(ms as i64)
}

/// `toISOString()` form: millisecond precision, `Z`.
pub fn iso(d: DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn epoch_iso(v: Option<f64>) -> Option<String> {
    v.and_then(|n| safe_epoch(&Value::from(n))).map(iso)
}

fn int(v: &Value) -> i64 {
    num(v) as i64
}
fn int_or_null(v: &Value) -> Option<i64> {
    num_or_null(v).map(|n| n as i64)
}
fn flag(v: &Value) -> i64 {
    i64::from(num(v) != 0.0)
}
/// `a ?? b`: the first unless it is null/missing.
fn or<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if a.is_null() { b } else { a }
}

/// Lowercase + trim so a tvg-id joins the lowercase XMLTV feed; blank is None.
pub fn normalize_epg_channel_id(id: Option<String>) -> Option<String> {
    id.map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
}

// ---- rows + parsers ----

#[derive(Clone, Debug, PartialEq)]
pub struct CategoryRow {
    pub category_id: i64,
    pub name: String,
    pub parent_id: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChannelRow {
    pub stream_id: i64,
    pub num: i64,
    pub name: String,
    pub stream_icon: Option<String>,
    pub epg_channel_id: Option<String>,
    pub category_id: Option<i64>,
    pub is_adult: i64,
    pub tv_archive: i64,
    pub tv_archive_duration: Option<i64>,
    pub added_ts: Option<String>,
    pub fetched_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VodRow {
    pub stream_id: i64,
    pub name: String,
    pub stream_icon: Option<String>,
    pub rating: Option<f64>,
    pub category_id: Option<i64>,
    pub container_extension: Option<String>,
    pub added_ts: Option<String>,
    pub tmdb_id: Option<i64>,
    pub year: Option<i64>,
    pub plot: Option<String>,
    pub director: Option<String>,
    pub cast_csv: Option<String>,
    pub fetched_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SeriesRow {
    pub series_id: i64,
    pub name: String,
    pub cover: Option<String>,
    pub plot: Option<String>,
    pub rating: Option<f64>,
    pub category_id: Option<i64>,
    pub tmdb_id: Option<i64>,
    pub last_modified: Option<String>,
    pub fetched_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EpisodeRow {
    pub episode_id: String,
    pub series_id: i64,
    pub season: i64,
    pub episode_num: i64,
    pub title: Option<String>,
    pub container_extension: Option<String>,
    pub added_ts: Option<String>,
    pub plot: Option<String>,
    pub duration_secs: Option<i64>,
}

fn items(raw: &Value) -> &[Value] {
    raw.as_array().map(Vec::as_slice).unwrap_or(&[])
}

pub fn parse_categories(raw: &Value) -> Vec<CategoryRow> {
    items(raw)
        .iter()
        .map(|o| CategoryRow {
            category_id: int(&o["category_id"]),
            name: str_(&o["category_name"]).unwrap_or_default(),
            parent_id: int(&o["parent_id"]),
        })
        .collect()
}

pub fn parse_live_streams(raw: &Value, fetched_at: &str) -> Vec<ChannelRow> {
    items(raw)
        .iter()
        .map(|o| ChannelRow {
            stream_id: int(&o["stream_id"]),
            num: int(&o["num"]),
            name: str_(&o["name"]).unwrap_or_default(),
            stream_icon: str_(&o["stream_icon"]),
            epg_channel_id: normalize_epg_channel_id(str_(&o["epg_channel_id"])),
            category_id: int_or_null(&o["category_id"]),
            is_adult: flag(&o["is_adult"]),
            tv_archive: flag(&o["tv_archive"]),
            tv_archive_duration: int_or_null(&o["tv_archive_duration"]),
            added_ts: epoch_iso(num_or_null(&o["added"])),
            fetched_at: fetched_at.to_string(),
        })
        .collect()
}

pub fn parse_vod_streams(raw: &Value, fetched_at: &str) -> Vec<VodRow> {
    items(raw)
        .iter()
        .map(|o| VodRow {
            stream_id: int(&o["stream_id"]),
            name: str_(&o["name"]).unwrap_or_default(),
            stream_icon: str_(&o["stream_icon"]),
            rating: num_or_null(&o["rating"]),
            category_id: int_or_null(&o["category_id"]),
            container_extension: str_(&o["container_extension"]),
            added_ts: epoch_iso(num_or_null(&o["added"])),
            tmdb_id: int_or_null(or(&o["tmdb"], &o["tmdb_id"])),
            year: int_or_null(&o["year"]),
            plot: str_(&o["plot"]),
            director: str_(&o["director"]),
            cast_csv: str_(&o["cast"]),
            fetched_at: fetched_at.to_string(),
        })
        .collect()
}

pub fn parse_series_list(raw: &Value, fetched_at: &str) -> Vec<SeriesRow> {
    items(raw)
        .iter()
        .map(|o| SeriesRow {
            series_id: int(&o["series_id"]),
            name: str_(&o["name"]).unwrap_or_default(),
            cover: str_(&o["cover"]),
            plot: str_(&o["plot"]),
            rating: num_or_null(&o["rating"]),
            category_id: int_or_null(&o["category_id"]),
            tmdb_id: int_or_null(or(&o["tmdb"], &o["tmdb_id"])),
            last_modified: str_(&o["last_modified"]),
            fetched_at: fetched_at.to_string(),
        })
        .collect()
}

/// `get_series_info`: episodes keyed by season, flattened. A season whose value
/// is not a list is skipped; an episode list sent as an array is indexed by
/// position, as `Object.entries` would.
pub fn parse_series_info(raw: &Value, series_id: i64) -> Vec<EpisodeRow> {
    let seasons: Vec<(String, &Value)> = match &raw["episodes"] {
        Value::Object(m) => m.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Value::Array(a) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => Vec::new(),
    };
    let mut out = Vec::new();
    for (season, eps) in seasons {
        let Some(eps) = eps.as_array() else { continue };
        let season = num(&Value::String(season)) as i64;
        for o in eps {
            let info = &o["info"];
            out.push(EpisodeRow {
                episode_id: match o.get("id") {
                    None => "undefined".into(),
                    Some(Value::Null) => "null".into(),
                    Some(v) => js_string(v),
                },
                series_id,
                season,
                episode_num: int(&o["episode_num"]),
                title: str_(&o["title"]),
                container_extension: str_(&o["container_extension"]),
                added_ts: epoch_iso(num_or_null(&o["added"])),
                plot: str_(or(&info["plot"], &info["description"])),
                duration_secs: int_or_null(&info["duration_secs"]),
            });
        }
    }
    out
}

// ---- network ----

#[derive(Clone, Copy, Debug)]
pub enum Kind {
    Live,
    Vod,
    Series,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Live => "live",
            Kind::Vod => "vod",
            Kind::Series => "series",
        }
    }
}

pub struct Client {
    creds: Creds,
    http: reqwest::Client,
}

impl Client {
    pub fn new(creds: Creds, timeout_ms: u64) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.without_url().to_string())?;
        Ok(Client { creds, http })
    }

    async fn get_json(&self, url: Url, label: &str) -> Result<Value, String> {
        let res = send_guarded(&self.http, url, label).await?;
        let status = res.status();
        if !status.is_success() {
            return Err(format!("{label}_{}", status.as_u16()));
        }
        res.json::<Value>()
            .await
            .map_err(|e| format!("{label}_bad_json: {}", e.without_url()))
    }

    /// Catalog lists are JSON arrays. Anything else (an auth-error object, null,
    /// an HTML page) fails the sync: read as empty, the reconcile would delete
    /// that whole kind.
    async fn get_list(&self, action: &str) -> Result<Value, String> {
        let label = format!("xtream.{action}");
        let raw = self
            .get_json(
                build_player_api_url(&self.creds, Some(action), &[])?,
                &label,
            )
            .await?;
        if raw.is_array() {
            Ok(raw)
        } else {
            Err(format!("{label}_not_a_list"))
        }
    }

    pub async fn account_info(&self) -> Result<AccountInfo, String> {
        let url = build_player_api_url(&self.creds, None, &[])?;
        let json = self.get_json(url, "xtream_account").await?;
        Ok(parse_account_info(&json))
    }

    pub async fn categories(&self, kind: Kind) -> Result<Vec<CategoryRow>, String> {
        let action = match kind {
            Kind::Live => "get_live_categories",
            Kind::Vod => "get_vod_categories",
            Kind::Series => "get_series_categories",
        };
        Ok(parse_categories(&self.get_list(action).await?))
    }

    pub async fn live_streams(&self, fetched_at: &str) -> Result<Vec<ChannelRow>, String> {
        Ok(parse_live_streams(
            &self.get_list("get_live_streams").await?,
            fetched_at,
        ))
    }

    pub async fn vod_streams(&self, fetched_at: &str) -> Result<Vec<VodRow>, String> {
        Ok(parse_vod_streams(
            &self.get_list("get_vod_streams").await?,
            fetched_at,
        ))
    }

    pub async fn series_list(&self, fetched_at: &str) -> Result<Vec<SeriesRow>, String> {
        Ok(parse_series_list(
            &self.get_list("get_series").await?,
            fetched_at,
        ))
    }

    pub async fn series_info(&self, series_id: i64) -> Result<Vec<EpisodeRow>, String> {
        let url = build_player_api_url(
            &self.creds,
            Some("get_series_info"),
            &[("series_id", series_id.to_string())],
        )?;
        Ok(parse_series_info(
            &self.get_json(url, "xtream.get_series_info").await?,
            series_id,
        ))
    }
}

/// GET a trusted, operator-configured URL (the panel, an external EPG feed;
/// sometimes plain http) and return the first non-redirect response. A 30x is
/// upstream-controlled, so every redirect target goes through the SSRF guard
/// before it is dialed. `http` must not follow redirects itself. Errors never
/// carry the URL: a panel URL holds the provider password.
pub async fn send_guarded(
    http: &reqwest::Client,
    mut url: Url,
    label: &str,
) -> Result<reqwest::Response, String> {
    for hop in 0..=ssrf_guard::MAX_REDIRECTS {
        if hop > 0 {
            ssrf_guard::guard_url(&url)
                .await
                .map_err(|e| format!("{label}_blocked: {e}"))?;
        }
        let res = http
            .get(url.clone())
            .send()
            .await
            .map_err(|e| format!("{label}_failed: {}", e.without_url()))?;
        if res.status().is_redirection()
            && let Some(loc) = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
        {
            url = url.join(loc).map_err(|_| format!("{label}_bad_redirect"))?;
            continue;
        }
        return Ok(res);
    }
    Err(format!("{label}_too_many_redirects"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testpanel::Panel;
    use serde_json::json;

    fn creds() -> Creds {
        Creds {
            host: "https://panel.example".into(),
            username: "u".into(),
            password: "p".into(),
        }
    }

    #[test]
    fn builds_player_api_urls() {
        assert_eq!(
            build_player_api_url(&creds(), Some("get_live_categories"), &[])
                .unwrap()
                .as_str(),
            "https://panel.example/player_api.php?username=u&password=p&action=get_live_categories"
        );
        assert_eq!(
            build_player_api_url(
                &creds(),
                Some("get_vod_streams"),
                &[("category_id", "12".into())]
            )
            .unwrap()
            .as_str(),
            "https://panel.example/player_api.php?username=u&password=p&action=get_vod_streams&category_id=12"
        );
    }

    #[test]
    fn creds_strip_trailing_slashes_and_require_all_three() {
        let c = crate::config::test_config(&[
            ("XTREAM_HOST", "https://panel.example//"),
            ("XTREAM_USERNAME", "u"),
            ("XTREAM_PASSWORD", "p"),
        ]);
        assert_eq!(
            Creds::from_config(&c).unwrap().host,
            "https://panel.example"
        );
        let c = crate::config::test_config(&[("XTREAM_HOST", "https://panel.example")]);
        assert_eq!(
            Creds::from_config(&c).err().as_deref(),
            Some("xtream_credentials_missing")
        );
    }

    #[test]
    fn parses_account_info_tolerating_strings() {
        let a = parse_account_info(
            &json!({"user_info": {"exp_date": "1893456000", "max_connections": "4", "status": "Active"}}),
        );
        assert!(a.expires_at.is_some());
        assert_eq!((a.max_connections, a.status.as_str()), (4.0, "Active"));
        let b = parse_account_info(
            &json!({"user_info": {"exp_date": 1893456000, "max_connections": 2, "active_connections": "2"}}),
        );
        assert_eq!((b.max_connections, b.active_connections), (2.0, 2.0));
        assert_eq!(parse_account_info(&json!(null)).max_connections, 0.0);
    }

    #[test]
    fn parses_categories() {
        let rows = parse_categories(&json!([
            {"category_id": "1", "category_name": "News", "parent_id": 0},
            {"category_id": 2, "category_name": "Sports", "parent_id": "0"},
        ]));
        assert_eq!(
            rows,
            vec![
                CategoryRow {
                    category_id: 1,
                    name: "News".into(),
                    parent_id: 0
                },
                CategoryRow {
                    category_id: 2,
                    name: "Sports".into(),
                    parent_id: 0
                },
            ]
        );
    }

    #[test]
    fn parses_live_streams_with_archive_flags_and_normalized_tvg() {
        let c = &parse_live_streams(
            &json!([{
                "stream_id": 100, "num": 1, "name": "C1", "stream_icon": "http://x/y.png",
                "epg_channel_id": "  CNBC.us  ", "category_id": "1", "is_adult": "0",
                "tv_archive": "1", "tv_archive_duration": "7", "added": "1716000000",
            }]),
            "2026-05-24T00:00:00Z",
        )[0];
        assert_eq!(
            (c.stream_id, c.num, c.category_id, c.is_adult, c.tv_archive),
            (100, 1, Some(1), 0, 1)
        );
        assert_eq!(c.tv_archive_duration, Some(7));
        assert_eq!(c.epg_channel_id.as_deref(), Some("cnbc.us"));
        assert_eq!(c.added_ts.as_deref(), Some("2024-05-18T02:40:00.000Z"));
        assert_eq!(c.fetched_at, "2026-05-24T00:00:00Z");
        let rows = parse_live_streams(
            &json!([{"stream_id": 2, "epg_channel_id": ""}, {"stream_id": 3}]),
            "t",
        );
        assert!(rows.iter().all(|r| r.epg_channel_id.is_none()));
    }

    #[test]
    fn parses_vod_and_series_with_tmdb() {
        let v = &parse_vod_streams(
            &json!([{"stream_id": 9, "name": "Movie", "container_extension": "mp4", "tmdb": "603", "rating": "7.8"}]),
            "t",
        )[0];
        assert_eq!(
            (v.stream_id, v.tmdb_id, v.rating),
            (9, Some(603), Some(7.8))
        );
        assert_eq!(v.container_extension.as_deref(), Some("mp4"));
        let s = &parse_series_list(
            &json!([{"series_id": 11, "name": "Show", "rating": 8.1, "category_id": 4, "tmdb": 1399}]),
            "t",
        )[0];
        assert_eq!(
            (s.series_id, s.tmdb_id, s.category_id),
            (11, Some(1399), Some(4))
        );
    }

    #[test]
    fn lenient_coercions_match_js() {
        assert_eq!(num(&json!("abc")), 0.0);
        assert_eq!(num(&json!(" 12 ")), 12.0);
        assert_eq!(num(&json!(true)), 0.0);
        assert_eq!(num_or_null(&json!("abc")), Some(0.0));
        assert_eq!(num_or_null(&json!(null)), None);
        assert_eq!(str_(&json!(603)), Some("603".into()));
        assert_eq!(str_(&json!(7.5)), Some("7.5".into()));
        assert_eq!(safe_epoch(&json!(0)), None);
        assert_eq!(safe_epoch(&json!("-5")), None);
        assert_eq!(safe_epoch(&json!(1e300)), None);
    }

    #[test]
    fn series_info_flattens_seasons_with_info_fallbacks() {
        let eps = parse_series_info(
            &json!({"episodes": {
                "1": [{"id": "e1", "episode_num": "1", "title": "Pilot", "container_extension": "mp4",
                       "added": "1716000000", "info": {"plot": "desc", "duration_secs": "1320"}}],
                "2": [{"id": "e2", "episode_num": 2, "info": {"description": "fallback-desc"}}],
            }}),
            11,
        );
        assert_eq!(eps.len(), 2);
        assert_eq!(
            (
                eps[0].episode_id.as_str(),
                eps[0].season,
                eps[0].episode_num
            ),
            ("e1", 1, 1)
        );
        assert_eq!(
            (eps[0].plot.as_deref(), eps[0].duration_secs),
            (Some("desc"), Some(1320))
        );
        assert!(eps[0].added_ts.is_some());
        assert_eq!(
            (eps[1].season, eps[1].plot.as_deref(), eps[1].duration_secs),
            (2, Some("fallback-desc"), None)
        );
        assert!(parse_series_info(&json!({"episodes": {"1": "not-an-array"}}), 7).is_empty());
        assert!(parse_series_info(&json!({}), 7).is_empty());
    }

    #[tokio::test]
    async fn fetchers_hit_the_right_actions_and_reject_non_lists() {
        let panel = Panel::start().await;
        panel.set(
            "get_live_categories",
            json!([{"category_id": "1", "category_name": "News", "parent_id": 0}]),
        );
        panel.set(
            "get_live_streams",
            json!([{"stream_id": 5, "name": "C", "epg_channel_id": "X.us"}]),
        );
        let x = panel.client();
        assert_eq!(x.categories(Kind::Live).await.unwrap()[0].name, "News");
        assert_eq!(
            x.live_streams("t").await.unwrap()[0]
                .epg_channel_id
                .as_deref(),
            Some("x.us")
        );

        for body in [
            json!({"user_info": {"auth": 0}}),
            json!(null),
            json!("oops"),
        ] {
            panel.set("get_vod_streams", body);
            assert_eq!(
                x.vod_streams("t").await.unwrap_err(),
                "xtream.get_vod_streams_not_a_list"
            );
        }
        panel.set_status("get_series_categories", 503);
        assert_eq!(
            x.categories(Kind::Series).await.unwrap_err(),
            "xtream.get_series_categories_503"
        );

        panel.set("", json!({"user_info": {"max_connections": 3, "active_connections": "2", "status": "Active"}}));
        let a = x.account_info().await.unwrap();
        assert_eq!((a.max_connections, a.active_connections), (3.0, 2.0));
    }

    #[tokio::test]
    async fn a_redirect_into_the_internal_network_is_refused_before_it_is_dialed() {
        let panel = Panel::start().await;
        let x = panel.client();
        for target in [
            "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
            "http://localhost:8000/admin",
            "http://10.0.0.7/internal",
        ] {
            panel.set_redirect("get_live_streams", target);
            let hits = panel.hits();
            let err = x.live_streams("t").await.unwrap_err();
            assert!(
                err.starts_with("xtream.get_live_streams_blocked"),
                "{target}: {err}"
            );
            assert!(
                !err.contains("password"),
                "errors must not leak the creds: {err}"
            );
            assert_eq!(panel.hits(), hits + 1, "only the trusted panel was dialed");
        }
    }
}
