//! Thin wrapper over [`boa_engine`], a pure-Rust JavaScript engine.
//!
//! Why a JS engine at all? The iOS Innertube client (see `lib.rs`) returns
//! pre-signed URLs, so the common path needs no JS. But age/region/login-gated
//! videos only come back from the **web** client, whose `url`/`s`/`n` params are
//! obfuscated by YouTube's player `base.js`. Deciphering them means *running*
//! YouTube's own JS — the signature transform and the `n`-throttle function are
//! deliberately un-reimplementable by hand and change every player build. Even
//! yt-dlp now shells the `n` challenge out to an external JS runtime (its `jsc`
//! provider subsystem); boa lets us do the same in-process, with no node/deno
//! subprocess and no Python — matching this crate's "no external runtime" goal.
//!
//! This module is intentionally tiny: define a `prelude` (global-array / helper
//! declarations the player function closes over) plus a single `function`, call
//! it with one string argument, and hand the string result back to Rust. All the
//! volatile *extraction* (which function, what prelude) lives in `cipher.rs`.

use boa_engine::{Context, Source};

/// A failure running JS in the embedded engine. We keep our own error type
/// (rather than leaking `boa_engine::JsError`, whose lifetime/`Trace` details
/// are an unstable surface) so callers depend only on a stable message string.
#[derive(Debug, Clone)]
pub struct JsError(pub String);

impl std::fmt::Display for JsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "js engine: {}", self.0)
    }
}
impl std::error::Error for JsError {}

/// Define `prelude` + `fn_src` (an *expression* that evaluates to a function,
/// e.g. `function(a){...}` or a bare name already declared in the prelude), then
/// invoke it with the single string `arg` and return the result coerced to a
/// String.
///
/// `fn_src` is bound to a fresh identifier and called as `__eex_fn(<arg>)`; the
/// arg is injected as a JSON string literal so it can't break out of the call or
/// inject code. The prelude runs first in the same realm, so the function can
/// reference any globals it declares (YouTube's player splits the sig/nsig logic
/// across a global array + helper object the function closes over).
pub fn eval_call(prelude: &str, fn_src: &str, arg: &str) -> Result<String, JsError> {
    // serde_json gives us a spec-correct JS string literal (handles quotes,
    // backslashes, control chars, non-BMP) — never hand-roll JS escaping.
    let arg_lit = serde_json::to_string(arg).map_err(|e| JsError(e.to_string()))?;

    // `(fn_src)` is parenthesised so a leading `function(...)` parses as an
    // expression, not a (illegal, unnamed) declaration. Trailing prelude `;` is
    // harmless. The whole program's completion value is the call result.
    let program = format!(
        "{prelude}\nvar __eex_fn = ({fn_src});\n__eex_fn({arg_lit});",
        prelude = prelude,
        fn_src = fn_src,
        arg_lit = arg_lit,
    );

    let mut ctx = Context::default();
    let value = ctx
        .eval(Source::from_bytes(&program))
        .map_err(|e| JsError(e.to_string()))?;

    // The sig/nsig functions return strings; coerce defensively in case a player
    // build returns something String()-able.
    value
        .to_string(&mut ctx)
        .map(|s| s.to_std_string_escaped())
        .map_err(|e| JsError(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Proves boa is wired and `eval_call` round-trips a string through a real JS
    /// function — the classic sig primitive (split → reverse → join).
    #[test]
    fn runs_a_trivial_reverse_function() {
        let out = eval_call(
            "",
            r#"function(s){ return s.split("").reverse().join(""); }"#,
            "abcde",
        )
        .expect("boa should run the reverse fn");
        assert_eq!(out, "edcba");
    }

    /// The function may reference globals declared in the prelude (mirrors how the
    /// player function closes over a global helper array/object).
    #[test]
    fn function_can_close_over_prelude_globals() {
        let out = eval_call(
            "var TBL = ['z','y','x'];",
            r#"function(s){ return TBL[0] + s; }"#,
            "_tail",
        )
        .expect("prelude globals visible to fn");
        assert_eq!(out, "z_tail");
    }

    /// The string arg is injected as a JSON literal, so quotes/backslashes in the
    /// input can't break out of the call (injection guard).
    #[test]
    fn arg_is_injection_safe() {
        let out = eval_call("", r#"function(s){ return s.length + ":" + s; }"#, "a\"b\\c")
            .expect("weird chars are safe");
        assert_eq!(out, "5:a\"b\\c");
    }

    /// A thrown JS error surfaces as a Rust `Err`, not a panic.
    #[test]
    fn js_throw_becomes_err() {
        let r = eval_call("", r#"function(s){ throw new Error("boom"); }"#, "x");
        assert!(r.is_err(), "a JS throw must be an Err");
    }
}
