//! Signature-cipher + `n`-throttle deciphering for the web client path.
//!
//! When the iOS client can't serve a video (age/region/login-gated), the web
//! client returns formats whose URL is split into a `signatureCipher` blob
//! (`s=<scrambled>&sp=sig&url=<base>`) and/or carries a throttled `n` query
//! param. To turn those into a playable URL we must run YouTube's obfuscated
//! player `base.js`:
//!   * SIG  — descramble `s`, then append it as the `sp` (usually `sig`) param.
//!   * NSIG — transform the `n` query param to defeat the download throttle.
//!
//! We don't reimplement either transform (they change every player build and are
//! deliberately un-reimplementable). Instead we *extract* the relevant JS — the
//! function + the globals it closes over — straight out of base.js using ported
//! yt-dlp regexes (see `signatures.json`), and execute it in boa (`jsengine`).
//!
//! The regex crate has no backreferences and can't match nested braces, so where
//! yt-dlp leaned on Python backrefs / its own JS interpreter we (a) use tolerant
//! character classes in the name regex then re-validate, and (b) balance braces
//! in Rust to slice function/object bodies. Origin of every pattern is documented
//! in `signatures.json`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::jsengine::{self, JsError};

/// `signatures.json`, embedded at compile time. The weekly canary edits the JSON
/// (a data refresh), never this source — same rot-fighting model as clients.json.
const SIGNATURES_JSON: &str = include_str!("../signatures.json");

fn patterns() -> &'static Value {
    static P: OnceLock<Value> = OnceLock::new();
    P.get_or_init(|| serde_json::from_str(SIGNATURES_JSON).expect("signatures.json is valid JSON"))
}

#[derive(Debug)]
pub enum CipherError {
    /// A volatile extraction regex matched nothing — the player likely changed
    /// shape and `signatures.json` needs a canary refresh. Carries which step.
    PatternMiss(&'static str),
    /// The JS engine threw while running an extracted function.
    Js(JsError),
    /// The signatureCipher blob was malformed (no `s` / no `url`).
    BadCipher(String),
    /// base.js / signatures.json had a structural surprise.
    Malformed(String),
}

impl std::fmt::Display for CipherError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CipherError::PatternMiss(s) => write!(f, "extraction pattern miss: {s}"),
            CipherError::Js(e) => write!(f, "{e}"),
            CipherError::BadCipher(s) => write!(f, "bad signatureCipher: {s}"),
            CipherError::Malformed(s) => write!(f, "malformed: {s}"),
        }
    }
}
impl std::error::Error for CipherError {}
impl From<JsError> for CipherError {
    fn from(e: JsError) -> Self {
        CipherError::Js(e)
    }
}

// ---------------------------------------------------------------------------
// Small string helpers (balanced-brace / bracket scanning the regex can't do).
// ---------------------------------------------------------------------------

/// Given `src` and the byte index of an opening `{`, return the substring from
/// that `{` to its matching `}` (inclusive), honoring strings/escapes so braces
/// inside JS string literals don't throw off the count.
fn balanced(src: &str, open_idx: usize, open: u8, close: u8) -> Option<String> {
    let bytes = src.as_bytes();
    if bytes.get(open_idx) != Some(&open) {
        return None;
    }
    let mut depth = 0i32;
    let mut i = open_idx;
    let mut in_str: Option<u8> = None;
    let mut escaped = false;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == q {
                in_str = None;
            }
        } else if c == b'"' || c == b'\'' || c == b'`' {
            in_str = Some(c);
        } else if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(src[open_idx..=i].to_string());
            }
        }
        i += 1;
    }
    None
}

/// Compile a pattern that contains the `%NAME%` placeholder by substituting the
/// regex-escaped identifier in for it. Used for body/object/array lookups keyed
/// by an already-extracted function/object name.
fn compile_named(pattern: &str, name: &str) -> Result<Regex, CipherError> {
    let p = pattern.replace("%NAME%", &regex::escape(name));
    Regex::new(&p).map_err(|e| CipherError::Malformed(format!("regex {p:?}: {e}")))
}

fn str_array<'a>(v: &'a Value, key: &str) -> impl Iterator<Item = &'a str> {
    v.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

// ---------------------------------------------------------------------------
// SIG: self-contained signature-descramble extraction.
// ---------------------------------------------------------------------------

/// A self-contained JS snippet that descrambles a signature, plus the function
/// name to call. Self-contained = it carries the helper transform object inline,
/// so it runs in boa with no other part of base.js present.
#[derive(Debug, Clone)]
pub struct SigFn {
    /// `var <obj>={...}; function <name>(a){...}` — the prelude for `eval_call`.
    pub prelude: String,
    /// The function name to invoke (declared in `prelude`).
    pub name: String,
}

impl SigFn {
    /// Run the descramble on a scrambled `s`, returning the working signature.
    pub fn decipher(&self, s: &str) -> Result<String, CipherError> {
        Ok(jsengine::eval_call(&self.prelude, &self.name, s)?)
    }
}

/// Extract the signature function name from base.js (first ported pattern wins).
pub fn extract_sig_name(jscode: &str) -> Result<String, CipherError> {
    for pat in str_array(&patterns()["sig_function_name"], "patterns") {
        let Ok(re) = Regex::new(pat) else { continue };
        if let Some(caps) = re.captures(jscode)
            && let Some(m) = caps.name("sig") {
                return Ok(m.as_str().to_string());
            }
    }
    Err(CipherError::PatternMiss("sig_function_name"))
}

/// Given the sig function name, slice its `function(args){body}` out of base.js.
/// Returns (argname, body-with-braces).
fn extract_function_body(jscode: &str, name: &str) -> Result<(String, String), CipherError> {
    let body_pat = patterns()["sig_function_body"]["patterns"][0]
        .as_str()
        .ok_or_else(|| CipherError::Malformed("sig_function_body pattern missing".into()))?;
    let re = compile_named(body_pat, name)?;
    let caps = re
        .captures(jscode)
        .ok_or(CipherError::PatternMiss("sig_function_body"))?;
    let args = caps
        .name("args")
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_default();
    // The match ends at the opening `{`; balance from there.
    let open_idx = caps.get(0).unwrap().end() - 1;
    let body = balanced(jscode, open_idx, b'{', b'}')
        .ok_or(CipherError::PatternMiss("sig_function_body(balance)"))?;
    let argname = args.split(',').next().unwrap_or("a").trim().to_string();
    Ok((argname, body))
}

/// Find the helper object name the sig body calls (the first `IDENT.method(` in
/// the body, where IDENT isn't the argument), then slice `var IDENT={...};`.
fn extract_helper_object(jscode: &str, body: &str, argname: &str) -> Result<String, CipherError> {
    let obj_name_pat = patterns()["helper_object"]["patterns"][1]
        .as_str()
        .ok_or_else(|| CipherError::Malformed("helper_object name pattern missing".into()))?;
    let re = Regex::new(obj_name_pat).map_err(|e| CipherError::Malformed(e.to_string()))?;
    let mut obj_name = None;
    for caps in re.captures_iter(body) {
        if let Some(m) = caps.name("obj") {
            let cand = m.as_str();
            if cand != argname {
                obj_name = Some(cand.to_string());
                break;
            }
        }
    }
    let obj_name = obj_name.ok_or(CipherError::PatternMiss("helper_object(name)"))?;

    let decl_pat = patterns()["helper_object"]["patterns"][0]
        .as_str()
        .ok_or_else(|| CipherError::Malformed("helper_object decl pattern missing".into()))?;
    let decl_re = compile_named(decl_pat, &obj_name)?;
    let m = decl_re
        .find(jscode)
        .ok_or(CipherError::PatternMiss("helper_object(decl)"))?;
    let open_idx = m.end() - 1; // at the `{`
    let obj_literal = balanced(jscode, open_idx, b'{', b'}')
        .ok_or(CipherError::PatternMiss("helper_object(balance)"))?;
    Ok(format!("var {obj_name}={obj_literal};"))
}

/// Full SIG extraction: name -> body -> helper object -> self-contained prelude.
pub fn extract_sig_fn(jscode: &str) -> Result<SigFn, CipherError> {
    let name = extract_sig_name(jscode)?;
    let (argname, body) = extract_function_body(jscode, &name)?;
    let helper = extract_helper_object(jscode, &body, &argname)?;
    // Declare the helper object first, then the named function that uses it.
    let prelude = format!("{helper}\nfunction {name}({argname}){body}");
    Ok(SigFn { prelude, name })
}

// ---------------------------------------------------------------------------
// NSIG: n-throttle function name + global-var prelude extraction.
// ---------------------------------------------------------------------------

/// The extracted `n` transform: the function source as an expression plus the
/// global-array prelude it closes over (may be empty on older players).
#[derive(Debug, Clone)]
pub struct NsigFn {
    pub prelude: String,
    /// A `function(a){...}` expression ready for `eval_call`.
    pub fn_src: String,
}

impl NsigFn {
    pub fn transform(&self, n: &str) -> Result<String, CipherError> {
        let out = jsengine::eval_call(&self.prelude, &self.fn_src, n)?;
        // If the function returns the input unchanged (or an enhanced_except_
        // sentinel) it failed internally — yt-dlp treats this as an error.
        if out == n || out.starts_with("enhanced_except_") || out.ends_with(n) {
            return Err(CipherError::Js(JsError(format!(
                "nsig returned an exception sentinel for input {n:?}"
            ))));
        }
        Ok(out)
    }
}

/// Extract the global `'use strict';var X=...` array statement (prelude) and its
/// name. Returns `("", "")` when no global array exists (older players) — that's
/// not an error, the nsig fn just doesn't close over one.
pub fn extract_global_var(jscode: &str) -> (String, String) {
    for pat in str_array(&patterns()["player_js_global_var"], "patterns") {
        let Ok(re) = Regex::new(pat) else { continue };
        if let Some(caps) = re.captures(jscode) {
            let code = caps.name("code").map(|m| m.as_str().to_string());
            let name = caps.name("name").map(|m| m.as_str().to_string());
            if let (Some(code), Some(name)) = (code, name) {
                return (format!("{code};"), name);
            }
        }
    }
    (String::new(), String::new())
}

/// Extract the `n`-function name, handling the global-array indirection
/// (`nfunc[idx]`) and the `"nn"[+x]` / fromCharCode(110) obfuscation of "n".
pub fn extract_nsig_name(jscode: &str) -> Result<String, CipherError> {
    let node = &patterns()["nsig_function_name"];

    for pat in str_array(node, "patterns") {
        let Ok(re) = Regex::new(pat) else { continue };
        if let Some(caps) = re.captures(jscode) {
            let Some(nfunc) = caps.name("nfunc").map(|m| m.as_str().to_string()) else {
                continue;
            };
            match caps.name("idx") {
                // `nfunc[idx]` — resolve element idx of `var nfunc=[...]`.
                Some(idx_m) => {
                    let idx: usize = idx_m.as_str().parse().unwrap_or(0);
                    if let Some(name) = resolve_array_deref(jscode, &nfunc, idx)? {
                        return Ok(name);
                    }
                }
                None => return Ok(nfunc),
            }
        }
    }

    // Fallback: the `..._w8_` return-sentinel function form.
    for pat in str_array(node, "fallback_patterns") {
        let Ok(re) = Regex::new(pat) else { continue };
        if let Some(caps) = re.captures(jscode)
            && let Some(m) = caps.name("name") {
                return Ok(m.as_str().to_string());
            }
    }

    Err(CipherError::PatternMiss("nsig_function_name"))
}

/// `var <name>=[a,b,c];` -> the idx-th identifier element (the real fn name).
fn resolve_array_deref(
    jscode: &str,
    array_name: &str,
    idx: usize,
) -> Result<Option<String>, CipherError> {
    let pat = patterns()["nsig_function_name"]["array_deref"]["pattern"]
        .as_str()
        .ok_or_else(|| CipherError::Malformed("array_deref pattern missing".into()))?;
    let re = compile_named(pat, array_name)?;
    let Some(caps) = re.captures(jscode) else {
        return Ok(None);
    };
    let arr = caps
        .name("arr")
        .map(|m| m.as_str())
        .ok_or(CipherError::PatternMiss("array_deref(arr)"))?;
    // Elements are bare identifiers; split inside the [...] on commas.
    let inner = arr.trim_start_matches('[').trim_end_matches(']');
    let elem = inner.split(',').nth(idx).map(|s| s.trim().to_string());
    Ok(elem.filter(|s| !s.is_empty()))
}

/// Full NSIG extraction: global prelude + name -> function body -> fn expression.
pub fn extract_nsig_fn(jscode: &str) -> Result<NsigFn, CipherError> {
    let (prelude, _varname) = extract_global_var(jscode);
    let name = extract_nsig_name(jscode)?;
    let (argname, body) = extract_function_body(jscode, &name)?;
    let fn_src = format!("function({argname}){body}");
    Ok(NsigFn { prelude, fn_src })
}

// ---------------------------------------------------------------------------
// signatureCipher blob parsing + URL assembly.
// ---------------------------------------------------------------------------

/// Parse a `signatureCipher` value (`s=..&sp=..&url=..`, urlencoded) into its
/// scrambled signature, the param name to write it back under, and the base URL.
pub struct CipherParts {
    pub s: String,
    pub sp: String,
    pub url: String,
}

pub fn parse_signature_cipher(blob: &str) -> Result<CipherParts, CipherError> {
    let mut s = None;
    let mut sp = None;
    let mut url = None;
    for pair in blob.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        let v = urldecode(v);
        match k {
            "s" => s = Some(v),
            "sp" => sp = Some(v),
            "url" => url = Some(v),
            _ => {}
        }
    }
    Ok(CipherParts {
        s: s.ok_or_else(|| CipherError::BadCipher("no `s`".into()))?,
        sp: sp.unwrap_or_else(|| "sig".to_string()),
        url: url.ok_or_else(|| CipherError::BadCipher("no `url`".into()))?,
    })
}

/// Minimal percent-decoder (also turns `+` into space, per form-urlencoding).
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let h = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]));
                if let (Some(a), Some(b)) = h {
                    out.push((a << 4) | b);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Append/replace the `n` query param value on a googlevideo URL.
pub fn replace_n_param(url: &str, new_n: &str) -> String {
    let Some(q_idx) = url.find('?') else {
        return url.to_string();
    };
    let (base, query) = url.split_at(q_idx + 1);
    let mut found = false;
    let rebuilt: Vec<String> = query
        .split('&')
        .map(|pair| {
            if let Some((k, _)) = pair.split_once('=')
                && k == "n" {
                    found = true;
                    return format!("n={new_n}");
                }
            pair.to_string()
        })
        .collect();
    let mut out = format!("{base}{}", rebuilt.join("&"));
    if !found {
        out.push_str(&format!("&n={new_n}"));
    }
    out
}

// ---------------------------------------------------------------------------
// Orchestration: resolve a video via the web client + cipher path.
// ---------------------------------------------------------------------------

/// Deobfuscate one googlevideo URL: apply SIG (if the format came as a
/// signatureCipher blob) and/or NSIG (if the URL carries an `n` param). Both
/// extractors are passed in pre-extracted so we run base.js extraction once per
/// player, not once per format.
pub fn deobfuscate_url(
    format: &Value,
    sig_fn: &SigFn,
    nsig_fn: Option<&NsigFn>,
) -> Result<String, CipherError> {
    // Either a direct `url` (maybe n-throttled) or a `signatureCipher` blob.
    let mut url = if let Some(blob) = format.get("signatureCipher").and_then(Value::as_str) {
        let parts = parse_signature_cipher(blob)?;
        let sig = sig_fn.decipher(&parts.s)?;
        // Append the deciphered signature under its `sp` param name.
        let joiner = if parts.url.contains('?') { '&' } else { '?' };
        format!("{}{}{}={}", parts.url, joiner, parts.sp, urlencode(&sig))
    } else if let Some(u) = format.get("url").and_then(Value::as_str) {
        u.to_string()
    } else {
        return Err(CipherError::BadCipher("format has neither url nor signatureCipher".into()));
    };

    // NSIG: replace the throttle param if present and we have the transform.
    if let Some(nsig) = nsig_fn
        && let Some(n) = current_n_param(&url) {
            let new_n = nsig.transform(&n)?;
            url = replace_n_param(&url, &new_n);
        }
    Ok(url)
}

fn current_n_param(url: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|pair| {
        pair.split_once('=')
            .filter(|(k, _)| *k == "n")
            .map(|(_, v)| v.to_string())
    })
}

/// Minimal percent-encoder for the deciphered signature (RFC 3986 unreserved +
/// passthrough is unsafe for a query value, so encode everything non-unreserved).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Resolve a video via the WEB client + cipher path. This is the Phase 3 entry
/// the orchestrator chains AFTER `ytresolve::resolve()` (the iOS fast path) fails
/// with `NotPlayable`/`NoStream`. It fetches base.js + the web player response,
/// extracts the sig (+ nsig) functions once, deobfuscates the best video+audio
/// adaptive pair, and returns a `Resolved`.
///
/// Note: progressive (muxed) web formats also carry cipher; we prefer the
/// adaptive pair for parity with the iOS path's `video`/`audio` contract.
pub async fn resolve_web(
    id: &str,
    client: &reqwest::Client,
) -> Result<crate::Resolved, crate::ResolveError> {
    use crate::player_js;

    if !crate::is_valid_id(id) {
        return Err(crate::ResolveError::InvalidId);
    }

    // 1. base.js (for sig/nsig extraction + the signatureTimestamp).
    let player = player_js::fetch_player_js(id, client)
        .await
        .map_err(map_player_err)?;
    let sts = player_js::extract_signature_timestamp(&player.code);

    // 2. The web player response (signatureCipher formats), tied to that player.
    let resp = player_js::fetch_web_player_response(id, client, sts)
        .await
        .map_err(map_player_err)?;

    let status = resp["playabilityStatus"]["status"].as_str().unwrap_or("");
    if status != "OK" {
        return Err(crate::ResolveError::NotPlayable(status.to_string()));
    }

    // 3. Extract the transforms ONCE for this player build.
    let sig_fn = extract_sig_fn(&player.code).map_err(map_cipher_err)?;
    let nsig_fn = extract_nsig_fn(&player.code).ok(); // optional; older players lack it

    let sd = &resp["streamingData"];
    let duration_secs = resp["videoDetails"]["lengthSeconds"]
        .as_str()
        .and_then(|s| s.parse().ok());
    let hls = sd["hlsManifestUrl"].as_str().map(str::to_string);

    let adaptive = sd["adaptiveFormats"].as_array();
    let video = pick_and_deobfuscate(adaptive, "video/mp4", "avc1", &sig_fn, nsig_fn.as_ref());
    let audio = pick_and_deobfuscate(adaptive, "audio/mp4", "mp4a", &sig_fn, nsig_fn.as_ref());

    if hls.is_none() && (video.is_none() || audio.is_none()) {
        return Err(crate::ResolveError::NoStream);
    }

    Ok(crate::Resolved {
        video_id: id.to_string(),
        hls,
        progressive: None,
        video,
        audio,
        duration_secs,
    })
}

/// Pick the best adaptive format by (height, bitrate) under 1080p matching mime +
/// codec, then deobfuscate its URL into a `StreamRef`.
fn pick_and_deobfuscate(
    formats: Option<&Vec<Value>>,
    mime: &str,
    codec: &str,
    sig_fn: &SigFn,
    nsig_fn: Option<&NsigFn>,
) -> Option<crate::StreamRef> {
    let best = formats?
        .iter()
        .filter(|f| {
            let m = f["mimeType"].as_str().unwrap_or("");
            m.contains(mime) && m.contains(codec) && f["height"].as_u64().unwrap_or(0) <= 1080
        })
        .max_by_key(|f| {
            (
                f["height"].as_u64().unwrap_or(0),
                f["bitrate"].as_u64().unwrap_or(0),
            )
        })?;

    let url = deobfuscate_url(best, sig_fn, nsig_fn).ok()?;
    Some(crate::StreamRef {
        url,
        mime: best["mimeType"].as_str().unwrap_or("").to_string(),
        height: best["height"].as_u64(),
        bitrate: best["bitrate"].as_u64(),
    })
}

fn map_player_err(e: crate::player_js::PlayerError) -> crate::ResolveError {
    use crate::player_js::PlayerError;
    match e {
        PlayerError::Http(e) => crate::ResolveError::Http(e),
        other => crate::ResolveError::NotPlayable(other.to_string()),
    }
}

fn map_cipher_err(e: CipherError) -> crate::ResolveError {
    // A pattern miss means the player rotated past our regexes — surface it as a
    // distinct, non-playable reason so the caller can fall back to yt-dlp.
    crate::ResolveError::NotPlayable(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_json_parses_and_has_expected_keys() {
        let p = patterns();
        for key in [
            "sig_function_name",
            "nsig_function_name",
            "player_js_global_var",
            "helper_object",
            "sig_function_body",
        ] {
            assert!(p.get(key).is_some(), "signatures.json missing {key}");
        }
    }

    #[test]
    fn balanced_handles_nested_and_strings() {
        let src = r#"var x={a:function(b){return "}}"+b}};rest"#;
        let open = src.find('{').unwrap();
        let got = balanced(src, open, b'{', b'}').unwrap();
        assert!(got.starts_with("{a:function"));
        assert!(got.ends_with("}}"));
        // braces inside the "}}" string must not end the object early
        assert!(got.contains(r#""}}""#));
    }

    #[test]
    fn parse_signature_cipher_splits_fields() {
        let blob = "s=AB%3DCD&sp=sig&url=https%3A%2F%2Fexample.com%2Fvideoplayback%3Fid%3D1";
        let p = parse_signature_cipher(blob).unwrap();
        assert_eq!(p.s, "AB=CD");
        assert_eq!(p.sp, "sig");
        assert_eq!(p.url, "https://example.com/videoplayback?id=1");
    }

    #[test]
    fn replace_n_param_replaces_existing() {
        let u = "https://r1.googlevideo.com/videoplayback?id=7&n=OLD&mime=video";
        assert_eq!(
            replace_n_param(u, "NEW"),
            "https://r1.googlevideo.com/videoplayback?id=7&n=NEW&mime=video"
        );
    }

    #[test]
    fn replace_n_param_appends_when_absent() {
        let u = "https://r1.googlevideo.com/videoplayback?id=7";
        assert_eq!(replace_n_param(u, "NEW"), "https://r1.googlevideo.com/videoplayback?id=7&n=NEW");
    }

    // ---- The pinned-fixture SIG test (the must-pass proof). ----
    //
    // A real signature transform from a classic-pattern player: a `var Xo={...}`
    // helper object (reverse / swap / splice) + a `Yo=function(a){a=a.split("");
    // ...;return a.join("")}` descrambler. We assert extraction finds the fn,
    // pulls the helper, and boa deciphers a known input to the known output.
    #[test]
    fn extract_and_decipher_classic_sig_fixture() {
        let js = include_str!("../tests/fixtures/sig_classic_player.js");
        let sig = extract_sig_fn(js).expect("should extract classic sig fn");
        // The fixture descrambler does: reverse, swap[0<->3], slice(2), reverse.
        // We assert against the value computed by the SAME JS run in node (baked
        // into the fixture's comment) so the test is self-checking.
        let input = "ABCDEFGHIJ";
        let got = sig.decipher(input).expect("boa runs the sig fn");
        assert_eq!(got, "ABCDEFJH", "deciphered sig mismatch (got {got})");
    }

    // ---- NSIG: extraction (array-indirection + global prelude) + boa run. ----
    //
    // Proves the n-throttle machinery end-to-end on a fixture in the modern shape
    // (global array prelude, `nfunc[idx]` call site, `"nn"[+x]` obfuscation). The
    // live `player_es6` may need further pattern tuning, but this proves the
    // extractor resolves the array deref, slices the body, and boa runs it.
    #[test]
    fn extract_and_run_nsig_fixture() {
        let js = include_str!("../tests/fixtures/nsig_player.js");

        // Name extraction must resolve Naa[0] -> Xqz.
        let name = extract_nsig_name(js).expect("nsig name");
        assert_eq!(name, "Xqz", "array-indirection should resolve to Xqz");

        // Global prelude must be captured (the 'use strict';var gG=... line).
        let (prelude, varname) = extract_global_var(js);
        assert!(prelude.contains("split"), "global prelude captured");
        assert_eq!(varname, "gG");

        // Full extraction + boa execution.
        let nsig = extract_nsig_fn(js).expect("nsig fn");
        let out = nsig.transform("abcde").expect("boa runs nsig");
        assert_eq!(out, "edcbaX", "nsig transform mismatch (got {out})");
    }

    #[test]
    fn nsig_name_handles_plain_get_n_form() {
        // `.get("n"))&&(b=nfunc(b)` — the simplest (no array, no obfuscation) form.
        let js = r#"function foo(a){a.D&&(b=a.get("n"))&&(b=decipher(b),a.set("n",b))}
                    decipher=function(x){return x+"!"};"#;
        let name = extract_nsig_name(js).expect("plain get(n) name");
        assert_eq!(name, "decipher");
    }

    /// LIVE probe against the current player — network + volatile, hence ignored.
    /// Run with `cargo test -p ytresolve -- --ignored live_player_cipher_status`.
    ///
    /// STATUS (player `ac678d18` / player_es6, probed 2026-06): the global-array
    /// prelude and `signatureTimestamp` extract cleanly, but the classic SIG
    /// descrambler (`X=function(a){a=a.split("")...return a.join("")}`) and the
    /// query-param `&n=` NSIG call site are GONE — the player inlines them behind
    /// a `g.oH` URL class and a `/n/<val>` path-rewrite. Anchored regexes (ours
    /// and yt-dlp's) miss; this is exactly why yt-dlp now hands the whole base.js
    /// to an external JS solver (EJS) instead of regex-extracting. Cracking it
    /// here is a follow-up: either tune `signatures.json` to the new shapes, or
    /// load the full base.js into boa and call the dispatch entrypoint. The boa
    /// engine + extraction framework below are proven by the fixture tests above.
    #[tokio::test]
    #[ignore = "network + depends on the live YouTube player build"]
    async fn live_player_cipher_status() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap();
        let player = crate::player_js::fetch_player_js("dQw4w9WgXcQ", &client)
            .await
            .expect("fetch base.js");
        eprintln!("live player_id = {}", player.player_id);

        let (prelude, varname) = extract_global_var(&player.code);
        eprintln!(
            "global prelude: name={varname:?} bytes={} (empty={})",
            prelude.len(),
            prelude.is_empty()
        );
        eprintln!("sts = {:?}", crate::player_js::extract_signature_timestamp(&player.code));

        match extract_sig_fn(&player.code) {
            Ok(s) => eprintln!("SIG extracted: name={}", s.name),
            Err(e) => eprintln!("SIG extraction FAILED (expected on es6): {e}"),
        }
        match extract_nsig_fn(&player.code) {
            Ok(_) => eprintln!("NSIG extracted"),
            Err(e) => eprintln!("NSIG extraction FAILED (expected on es6): {e}"),
        }
        // Intentionally no assert: this is a status probe, not a gate.
    }
}
