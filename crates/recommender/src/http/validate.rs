//! Request bodies checked the way pydantic v2 (behind FastAPI) checked the
//! `app/schemas.py` models, so a bad body gets the same 422 detail list: every
//! field is checked, errors come in field order, and each carries pydantic's
//! type, loc, msg, input and ctx.

use emerald_contracts::sub::{SubError, parse_sub};
use serde_json::{Map, Value, json};

/// The request body as FastAPI handed it to pydantic.
pub enum Body {
    /// No bytes, or JSON `null`.
    Missing,
    Json(Value),
    /// A body whose content type is not JSON (pydantic saw the raw text).
    Raw(String),
}

const KINDS: &[&str] = &["movie", "tv"];
/// The Python list also had 'shown' (no caller; it only touched recently_shown).
const SIGNALS: &[&str] = &["like", "dislike", "reject", "clicked", "added", "watched"];
const CLEAR_SIGNALS: &[&str] = &["like", "dislike", "reject"];
const PROVENANCE: &[&str] = &["personalized", "discover", "trending"];
/// The max_length of ShownEventRequest.tmdb_ids and ImpressionEventRequest.items.
pub const BATCH_MAX: usize = 200;

pub struct Feedback {
    pub sub: String,
    pub kind: &'static str,
    pub tmdb_id: i64,
    pub signal: &'static str,
}

pub struct ClearFeedback {
    pub sub: String,
    pub kind: &'static str,
    pub tmdb_id: i64,
    pub signal: Option<&'static str>,
}

pub struct Shown {
    pub sub: String,
    pub kind: &'static str,
    pub tmdb_ids: Vec<i64>,
}

pub struct Impression {
    pub tmdb_id: i64,
    pub rank: i64,
    pub score: f64,
    pub provenance: &'static str,
    pub model_version: String,
}

pub struct Impressions {
    pub sub: String,
    pub kind: &'static str,
    pub items: Vec<Impression>,
}

pub struct Rejection {
    pub kind: &'static str,
    pub tmdb_id: i64,
}

pub struct LibraryItem {
    pub tmdb_id: Option<i64>,
    pub title: Option<String>,
}

/// ScoreRequest. LibraryItem.source is checked but not kept (it only fed the
/// dead persist_library upsert).
pub struct Score {
    pub sub: String,
    pub kind: &'static str,
    pub n: i64,
    pub exclude_recently_shown: bool,
    pub library: Option<Vec<LibraryItem>>,
    /// (tmdb_id, signal)
    pub feedback: Option<Vec<(i64, &'static str)>>,
    pub household_rejections: Option<Vec<i64>>,
}

/// The max_length of the three ScoreRequest lists.
const SCORE_LIST_MAX: usize = 5000;

pub type Errors = Vec<Value>;

#[derive(Default)]
struct V {
    errors: Errors,
}

fn at(loc: &[Value], k: impl Into<Value>) -> Vec<Value> {
    let mut l = loc.to_vec();
    l.push(k.into());
    l
}

impl V {
    fn push(&mut self, ty: &str, loc: &[Value], msg: impl Into<String>, input: &Value) {
        self.errors
            .push(json!({ "type": ty, "loc": loc, "msg": msg.into(), "input": input }));
    }

    fn push_ctx(
        &mut self,
        ty: &str,
        loc: &[Value],
        msg: impl Into<String>,
        input: &Value,
        ctx: Value,
    ) {
        self.push(ty, loc, msg, input);
        self.errors.last_mut().unwrap()["ctx"] = ctx;
    }

    fn finish<T>(&mut self, out: Option<T>) -> Result<T, Errors> {
        match out {
            Some(t) if self.errors.is_empty() => Ok(t),
            _ => Err(std::mem::take(&mut self.errors)),
        }
    }

    /// The top-level model: the body must be a JSON object.
    fn body<'a>(&mut self, body: &'a Body) -> Option<Obj<'a>> {
        let loc = vec![json!("body")];
        match body {
            Body::Missing => {
                self.push("missing", &loc, "Field required", &Value::Null);
                None
            }
            Body::Raw(s) => {
                self.model_type(&loc, &Value::String(s.clone()));
                None
            }
            Body::Json(v) => self.model(v, loc),
        }
    }

    fn model<'a>(&mut self, v: &'a Value, loc: Vec<Value>) -> Option<Obj<'a>> {
        match v {
            Value::Object(map) => Some(Obj { map, whole: v, loc }),
            _ => {
                self.model_type(&loc, v);
                None
            }
        }
    }

    fn model_type(&mut self, loc: &[Value], input: &Value) {
        self.push(
            "model_attributes_type",
            loc,
            "Input should be a valid dictionary or object to extract fields from",
            input,
        );
    }

    fn string(&mut self, x: &Value, loc: &[Value]) -> Option<String> {
        match x {
            Value::String(s) => Some(s.clone()),
            _ => {
                self.push("string_type", loc, "Input should be a valid string", x);
                None
            }
        }
    }

    /// `str` plus the `validate_sub` field validator (emerald_contracts::parse_sub).
    fn sub(&mut self, x: &Value, loc: &[Value]) -> Option<String> {
        let s = self.string(x, loc)?;
        match parse_sub(&s) {
            Ok(_) => Some(s),
            Err(e) => {
                let why = match e {
                    SubError::Unprefixed => "sub is missing provider prefix",
                    SubError::UnknownProvider => "unknown sub provider",
                    SubError::InvalidFormat => "sub fails provider regex",
                };
                self.push_ctx(
                    "value_error",
                    loc,
                    format!("Value error, {why}"),
                    x,
                    json!({ "error": {} }),
                );
                None
            }
        }
    }

    fn literal(&mut self, x: &Value, loc: &[Value], opts: &[&'static str]) -> Option<&'static str> {
        if let Some(hit) = x.as_str().and_then(|s| opts.iter().find(|o| **o == s)) {
            return Some(hit);
        }
        let quoted: Vec<String> = opts.iter().map(|o| format!("'{o}'")).collect();
        let expected = match quoted.split_last() {
            Some((last, rest)) if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
            _ => quoted.concat(),
        };
        self.push_ctx(
            "literal_error",
            loc,
            format!("Input should be {expected}"),
            x,
            json!({ "expected": expected }),
        );
        None
    }

    /// PositiveStrictInt: a JSON integer above 0; no floats, bools or strings.
    fn positive_strict_int(&mut self, x: &Value, loc: &[Value]) -> Option<i64> {
        // An integer past i64 is int_type here; pydantic took it and the
        // sqlite bind raised (500).
        let Some(n) = x.as_i64() else {
            self.push("int_type", loc, "Input should be a valid integer", x);
            return None;
        };
        if n <= 0 {
            self.push_ctx(
                "greater_than",
                loc,
                "Input should be greater than 0",
                x,
                json!({ "gt": 0 }),
            );
            return None;
        }
        Some(n)
    }

    /// Lax `int`: integral floats, bools and numeric strings coerce.
    fn lax_int(&mut self, x: &Value, loc: &[Value]) -> Option<i64> {
        let n = match x {
            Value::Number(num) => match num.as_i64() {
                Some(n) => Some(n),
                None => {
                    let f = num.as_f64().unwrap_or(f64::NAN);
                    if f.fract() != 0.0 {
                        self.push(
                            "int_from_float",
                            loc,
                            "Input should be a valid integer, got a number with a fractional part",
                            x,
                        );
                        return None;
                    }
                    (f >= i64::MIN as f64 && f < i64::MAX as f64).then_some(f as i64)
                }
            },
            Value::Bool(b) => Some(i64::from(*b)),
            Value::String(s) => match py_int_str(s).and_then(|n| i64::try_from(n).ok()) {
                Some(n) => Some(n),
                None => {
                    self.push(
                        "int_parsing",
                        loc,
                        "Input should be a valid integer, unable to parse string as an integer",
                        x,
                    );
                    return None;
                }
            },
            _ => None,
        };
        if n.is_none() {
            self.push("int_type", loc, "Input should be a valid integer", x);
        }
        n
    }

    /// Lax `int` with ge/le bounds.
    fn lax_int_in(&mut self, x: &Value, loc: &[Value], ge: i64, le: Option<i64>) -> Option<i64> {
        let n = self.lax_int(x, loc)?;
        if n < ge {
            self.push_ctx(
                "greater_than_equal",
                loc,
                format!("Input should be greater than or equal to {ge}"),
                x,
                json!({ "ge": ge }),
            );
            return None;
        }
        if let Some(le) = le
            && n > le
        {
            self.push_ctx(
                "less_than_equal",
                loc,
                format!("Input should be less than or equal to {le}"),
                x,
                json!({ "le": le }),
            );
            return None;
        }
        Some(n)
    }

    fn lax_int_ge0(&mut self, x: &Value, loc: &[Value]) -> Option<i64> {
        self.lax_int_in(x, loc, 0, None)
    }

    /// Lax `bool`: 0/1 numbers and pydantic's yes/no words, any case.
    fn lax_bool(&mut self, x: &Value, loc: &[Value]) -> Option<bool> {
        const TRUE: &[&str] = &["1", "on", "t", "true", "y", "yes"];
        const FALSE: &[&str] = &["0", "off", "f", "false", "n", "no"];
        let parsing = "Input should be a valid boolean, unable to interpret input";
        match x {
            Value::Bool(b) => return Some(*b),
            Value::Number(n) if n.is_i64() || n.is_u64() => match n.as_i64() {
                Some(0) => return Some(false),
                Some(1) => return Some(true),
                _ => self.push("bool_parsing", loc, parsing, x),
            },
            Value::Number(n) if n.as_f64() == Some(0.0) => return Some(false),
            Value::Number(n) if n.as_f64() == Some(1.0) => return Some(true),
            Value::String(s) => {
                let l = s.to_ascii_lowercase();
                if TRUE.contains(&l.as_str()) {
                    return Some(true);
                }
                if FALSE.contains(&l.as_str()) {
                    return Some(false);
                }
                self.push("bool_parsing", loc, parsing, x);
            }
            _ => self.push("bool_type", loc, "Input should be a valid boolean", x),
        }
        None
    }

    /// `str | None`.
    fn opt_string(&mut self, x: &Value, loc: &[Value]) -> Option<Option<String>> {
        match x {
            Value::Null => Some(None),
            _ => self.string(x, loc).map(Some),
        }
    }

    /// Lax `float`: numbers, bools and numeric strings.
    fn lax_float(&mut self, x: &Value, loc: &[Value]) -> Option<f64> {
        match x {
            Value::Number(n) => n.as_f64(),
            Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            Value::String(s) => {
                let f = py_float_str(s);
                if f.is_none() {
                    self.push(
                        "float_parsing",
                        loc,
                        "Input should be a valid number, unable to parse string as a number",
                        x,
                    );
                }
                f
            }
            _ => {
                self.push("float_type", loc, "Input should be a valid number", x);
                None
            }
        }
    }

    /// `list[T]` with max_length: an over-long input is only too_long.
    fn list<T>(
        &mut self,
        x: &Value,
        loc: &[Value],
        max: usize,
        mut item: impl FnMut(&mut Self, &Value, &[Value]) -> Option<T>,
    ) -> Option<Vec<T>> {
        let Value::Array(items) = x else {
            self.push("list_type", loc, "Input should be a valid list", x);
            return None;
        };
        if items.len() > max {
            self.push_ctx(
                "too_long",
                loc,
                format!(
                    "List should have at most {max} items after validation, not {}",
                    items.len()
                ),
                x,
                json!({ "field_type": "List", "max_length": max, "actual_length": items.len() }),
            );
            return None;
        }
        let before = self.errors.len();
        let out: Vec<T> = items
            .iter()
            .enumerate()
            .filter_map(|(i, it)| item(self, it, &at(loc, i)))
            .collect();
        (self.errors.len() == before).then_some(out)
    }
}

struct Obj<'a> {
    map: &'a Map<String, Value>,
    whole: &'a Value,
    loc: Vec<Value>,
}

impl<'a> Obj<'a> {
    /// A required field: `missing` (with the whole object as input) if absent.
    fn req(&self, v: &mut V, key: &str) -> Option<(&'a Value, Vec<Value>)> {
        let loc = at(&self.loc, key);
        match self.map.get(key) {
            Some(x) => Some((x, loc)),
            None => {
                v.push("missing", &loc, "Field required", self.whole);
                None
            }
        }
    }

    fn opt(&self, key: &str) -> Option<(&'a Value, Vec<Value>)> {
        self.map.get(key).map(|x| (x, at(&self.loc, key)))
    }
}

macro_rules! field {
    ($v:ident, $o:ident, $key:literal, $check:ident $(, $arg:expr)*) => {
        $o.req($v, $key).and_then(|(x, loc)| $v.$check(x, &loc $(, $arg)*))
    };
}

pub fn feedback(body: &Body) -> Result<Feedback, Errors> {
    let v = &mut V::default();
    let Some(o) = v.body(body) else {
        return Err(std::mem::take(&mut v.errors));
    };
    let sub = field!(v, o, "sub", sub);
    let kind = field!(v, o, "kind", literal, KINDS);
    let tmdb_id = field!(v, o, "tmdb_id", positive_strict_int);
    let signal = field!(v, o, "signal", literal, SIGNALS);
    let out = (|| {
        Some(Feedback {
            sub: sub?,
            kind: kind?,
            tmdb_id: tmdb_id?,
            signal: signal?,
        })
    })();
    v.finish(out)
}

pub fn clear_feedback(body: &Body) -> Result<ClearFeedback, Errors> {
    let v = &mut V::default();
    let Some(o) = v.body(body) else {
        return Err(std::mem::take(&mut v.errors));
    };
    let sub = field!(v, o, "sub", sub);
    let kind = field!(v, o, "kind", literal, KINDS);
    let tmdb_id = field!(v, o, "tmdb_id", positive_strict_int);
    // Optional: absent and null are both None.
    let signal = match o.opt("signal") {
        None | Some((Value::Null, _)) => Some(None),
        Some((x, loc)) => v.literal(x, &loc, CLEAR_SIGNALS).map(Some),
    };
    let out = (|| {
        Some(ClearFeedback {
            sub: sub?,
            kind: kind?,
            tmdb_id: tmdb_id?,
            signal: signal?,
        })
    })();
    v.finish(out)
}

pub fn shown(body: &Body) -> Result<Shown, Errors> {
    let v = &mut V::default();
    let Some(o) = v.body(body) else {
        return Err(std::mem::take(&mut v.errors));
    };
    let sub = field!(v, o, "sub", sub);
    let kind = field!(v, o, "kind", literal, KINDS);
    let tmdb_ids = match o.opt("tmdb_ids") {
        None => Some(Vec::new()),
        Some((x, loc)) => v.list(x, &loc, BATCH_MAX, V::positive_strict_int),
    };
    let out = (|| {
        Some(Shown {
            sub: sub?,
            kind: kind?,
            tmdb_ids: tmdb_ids?,
        })
    })();
    v.finish(out)
}

fn impression(v: &mut V, x: &Value, loc: &[Value]) -> Option<Impression> {
    let o = v.model(x, loc.to_vec())?;
    let tmdb_id = field!(v, o, "tmdb_id", positive_strict_int);
    let rank = field!(v, o, "rank", lax_int_ge0);
    let score = field!(v, o, "score", lax_float);
    let provenance = field!(v, o, "provenance", literal, PROVENANCE);
    let model_version = field!(v, o, "model_version", string);
    Some(Impression {
        tmdb_id: tmdb_id?,
        rank: rank?,
        score: score?,
        provenance: provenance?,
        model_version: model_version?,
    })
}

pub fn impressions(body: &Body) -> Result<Impressions, Errors> {
    let v = &mut V::default();
    let Some(o) = v.body(body) else {
        return Err(std::mem::take(&mut v.errors));
    };
    let sub = field!(v, o, "sub", sub);
    let kind = field!(v, o, "kind", literal, KINDS);
    let items = match o.opt("items") {
        None => Some(Vec::new()),
        Some((x, loc)) => v.list(x, &loc, BATCH_MAX, impression),
    };
    let out = (|| {
        Some(Impressions {
            sub: sub?,
            kind: kind?,
            items: items?,
        })
    })();
    v.finish(out)
}

pub fn rejection(body: &Body) -> Result<Rejection, Errors> {
    let v = &mut V::default();
    let Some(o) = v.body(body) else {
        return Err(std::mem::take(&mut v.errors));
    };
    let kind = field!(v, o, "kind", literal, KINDS);
    let tmdb_id = field!(v, o, "tmdb_id", positive_strict_int);
    let out = (|| {
        Some(Rejection {
            kind: kind?,
            tmdb_id: tmdb_id?,
        })
    })();
    v.finish(out)
}

fn library_item(v: &mut V, x: &Value, loc: &[Value]) -> Option<LibraryItem> {
    let o = v.model(x, loc.to_vec())?;
    let tmdb_id = match o.opt("tmdb_id") {
        None | Some((Value::Null, _)) => Some(None),
        Some((x, loc)) => v.positive_strict_int(x, &loc).map(Some),
    };
    let mut opt_str = |key| match o.opt(key) {
        None => Some(None),
        Some((x, loc)) => v.opt_string(x, &loc),
    };
    let title = opt_str("title");
    let source = opt_str("source");
    source?;
    Some(LibraryItem {
        tmdb_id: tmdb_id?,
        title: title?,
    })
}

fn feedback_entry(v: &mut V, x: &Value, loc: &[Value]) -> Option<(i64, &'static str)> {
    let o = v.model(x, loc.to_vec())?;
    let tmdb_id = field!(v, o, "tmdb_id", positive_strict_int);
    let signal = field!(v, o, "signal", literal, SIGNALS);
    Some((tmdb_id?, signal?))
}

pub fn score(body: &Body) -> Result<Score, Errors> {
    let v = &mut V::default();
    let Some(o) = v.body(body) else {
        return Err(std::mem::take(&mut v.errors));
    };
    let sub = field!(v, o, "sub", sub);
    let kind = field!(v, o, "kind", literal, KINDS);
    let n = match o.opt("n") {
        None => Some(20),
        Some((x, loc)) => v.lax_int_in(x, &loc, 1, Some(50)),
    };
    let exclude_recently_shown = match o.opt("exclude_recently_shown") {
        None => Some(true),
        Some((x, loc)) => v.lax_bool(x, &loc),
    };
    // Each list: absent or null means "use the stored rows".
    let library = match o.opt("library") {
        None | Some((Value::Null, _)) => Some(None),
        Some((x, loc)) => v.list(x, &loc, SCORE_LIST_MAX, library_item).map(Some),
    };
    let feedback = match o.opt("feedback") {
        None | Some((Value::Null, _)) => Some(None),
        Some((x, loc)) => v.list(x, &loc, SCORE_LIST_MAX, feedback_entry).map(Some),
    };
    let household_rejections = match o.opt("household_rejections") {
        None | Some((Value::Null, _)) => Some(None),
        Some((x, loc)) => v
            .list(x, &loc, SCORE_LIST_MAX, V::positive_strict_int)
            .map(Some),
    };
    let out = (|| {
        Some(Score {
            sub: sub?,
            kind: kind?,
            n: n?,
            exclude_recently_shown: exclude_recently_shown?,
            library: library?,
            feedback: feedback?,
            household_rejections: household_rejections?,
        })
    })();
    v.finish(out)
}

/// pydantic's str -> int: surrounding whitespace, a sign, digits with single
/// underscores between them, and an optional `.0...` tail.
pub fn py_int_str(s: &str) -> Option<i128> {
    let t = s.trim();
    let (neg, rest) = match t.as_bytes().first()? {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    let (int, frac) = rest.split_once('.').unwrap_or((rest, ""));
    if rest.contains('.') && (frac.is_empty() || frac.bytes().any(|b| b != b'0')) {
        return None;
    }
    let b = int.as_bytes();
    let ok = !b.is_empty()
        && b.iter().enumerate().all(|(i, &c)| {
            c.is_ascii_digit()
                || (c == b'_'
                    && i > 0
                    && i + 1 < b.len()
                    && b[i - 1].is_ascii_digit()
                    && b[i + 1].is_ascii_digit())
        });
    if !ok {
        return None;
    }
    let n: i128 = int.replace('_', "").parse().ok()?;
    Some(if neg { -n } else { n })
}

/// Python float() on a string: whitespace, underscores between digits, inf/nan.
pub fn py_float_str(s: &str) -> Option<f64> {
    let t = s.trim();
    let b = t.as_bytes();
    let underscores_ok = b.iter().enumerate().all(|(i, &c)| {
        c != b'_'
            || (i > 0 && i + 1 < b.len() && b[i - 1].is_ascii_digit() && b[i + 1].is_ascii_digit())
    });
    if !underscores_ok {
        return None;
    }
    t.replace('_', "").parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUB: &str = "plex:494190801";

    fn body(v: Value) -> Body {
        Body::Json(v)
    }

    #[test]
    fn py_int_strings() {
        for (s, want) in [
            ("30", Some(30)),
            (" 30 ", Some(30)),
            ("+5", Some(5)),
            ("-3", Some(-3)),
            ("05", Some(5)),
            ("1_000", Some(1000)),
            ("3.0", Some(3)),
            ("3.00", Some(3)),
            ("-3.0", Some(-3)),
            ("\t3\n", Some(3)),
            ("0_0", Some(0)),
            ("1e3", None),
            ("3.5", None),
            ("3.", None),
            (".0", None),
            ("", None),
            (" ", None),
            ("0x10", None),
            ("+-3", None),
            ("1__0", None),
            ("_1", None),
            ("1_", None),
            ("1 0", None),
            ("3.0_0", None),
        ] {
            assert_eq!(py_int_str(s), want, "{s:?}");
        }
    }

    #[test]
    fn py_float_strings() {
        assert_eq!(py_float_str(" 2 "), Some(2.0));
        assert_eq!(py_float_str("1_000.5"), Some(1000.5));
        assert_eq!(py_float_str(".5"), Some(0.5));
        assert_eq!(py_float_str("5."), Some(5.0));
        assert_eq!(py_float_str("1e5"), Some(100000.0));
        assert_eq!(py_float_str("-inf"), Some(f64::NEG_INFINITY));
        assert!(py_float_str("nAn").unwrap().is_nan());
        assert_eq!(py_float_str("0x10"), None);
        assert_eq!(py_float_str("1,5"), None);
    }

    // recommender/tests/test_schema_positive_ids.py: every event schema
    // rejects zero, negative and stringly-typed ids.
    #[test]
    fn every_event_schema_rejects_bad_tmdb_ids() {
        for bad in [json!(0), json!(-1), json!("42")] {
            assert!(
                feedback(&body(
                    json!({"sub": SUB, "kind": "movie", "tmdb_id": bad, "signal": "like"})
                ))
                .is_err()
            );
            assert!(
                clear_feedback(&body(json!({"sub": SUB, "kind": "movie", "tmdb_id": bad})))
                    .is_err()
            );
            assert!(
                shown(&body(
                    json!({"sub": SUB, "kind": "movie", "tmdb_ids": [1, bad]})
                ))
                .is_err()
            );
            let item = json!({"tmdb_id": bad, "rank": 0, "score": 0.5, "provenance": "discover", "model_version": "v0"});
            assert!(
                impressions(&body(json!({"sub": SUB, "kind": "movie", "items": [item]}))).is_err()
            );
            assert!(rejection(&body(json!({"kind": "movie", "tmdb_id": bad}))).is_err());
        }
    }

    #[test]
    fn positive_ids_still_accepted() {
        let f = feedback(&body(
            json!({"sub": SUB, "kind": "movie", "tmdb_id": 1, "signal": "like"}),
        ))
        .ok()
        .unwrap();
        assert_eq!(f.tmdb_id, 1);
        assert_eq!(
            rejection(&body(json!({"kind": "tv", "tmdb_id": 1399})))
                .ok()
                .unwrap()
                .tmdb_id,
            1399
        );
        assert_eq!(
            shown(&body(json!({"sub": SUB, "kind": "tv", "tmdb_ids": [1, 2]})))
                .ok()
                .unwrap()
                .tmdb_ids,
            [1, 2]
        );
    }

    // test_watched_feedback.py: the schemas accept 'watched' and reject an
    // unknown signal; 'shown' is gone (no caller).
    #[test]
    fn feedback_signals() {
        let f = |signal: &str| {
            feedback(&body(
                json!({"sub": SUB, "kind": "movie", "tmdb_id": 1, "signal": signal}),
            ))
        };
        assert_eq!(f("watched").ok().unwrap().signal, "watched");
        assert!(f("bingewatched").is_err());
        let err = f("shown").err().unwrap();
        assert_eq!(err[0]["type"], "literal_error");
        assert_eq!(
            err[0]["msg"],
            "Input should be 'like', 'dislike', 'reject', 'clicked', 'added' or 'watched'"
        );
    }

    // test_sub_validation.py: valid and invalid subs on every sub-carrying model.
    #[test]
    fn subs_are_validated() {
        for sub in [
            "plex:12345",
            "plex:0",
            "local:01HABCDEFGHJKMNPQRSTVWXYZ0",
            "apple:001126.d3c6971f4faa4ccd80027e3654fa404a.1616",
        ] {
            assert!(
                feedback(&body(
                    json!({"sub": sub, "kind": "movie", "tmdb_id": 1, "signal": "like"})
                ))
                .is_ok()
            );
        }
        for sub in [
            "12345",
            "google:abc",
            "plex:007",
            "local:lowercase01HABCDEFGHJKMNPQR",
            "apple:bad-format",
            "",
            "   ",
        ] {
            assert!(
                feedback(&body(
                    json!({"sub": sub, "kind": "movie", "tmdb_id": 1, "signal": "like"})
                ))
                .is_err()
            );
        }
        for sub in ["garbage", "plex:12345"] {
            let ok = sub != "garbage";
            assert_eq!(
                feedback(&body(
                    json!({"sub": sub, "kind": "movie", "tmdb_id": 1, "signal": "like"})
                ))
                .is_ok(),
                ok
            );
            assert_eq!(
                clear_feedback(&body(
                    json!({"sub": sub, "kind": "movie", "tmdb_id": 1, "signal": "like"})
                ))
                .is_ok(),
                ok
            );
            assert_eq!(
                shown(&body(json!({"sub": sub, "kind": "movie", "tmdb_ids": []}))).is_ok(),
                ok
            );
            assert_eq!(
                impressions(&body(json!({"sub": sub, "kind": "movie", "items": []}))).is_ok(),
                ok
            );
        }
    }

    #[test]
    fn over_long_batch_is_only_too_long() {
        let mut ids = vec![json!(0)];
        ids.extend((1..=200).map(|i| json!(i)));
        let err = shown(&body(json!({"sub": SUB, "kind": "tv", "tmdb_ids": ids})))
            .err()
            .unwrap();
        assert_eq!(err.len(), 1);
        assert_eq!(err[0]["type"], "too_long");
        assert_eq!(err[0]["ctx"]["actual_length"], 201);
    }
}
