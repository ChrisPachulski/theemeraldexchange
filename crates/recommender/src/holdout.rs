//! The optimizer's holdout (`workers/optimizer.py` load_holdout and
//! holdout_status): RECOMMENDER_HOLDOUT_PATH when that file exists, otherwise
//! the vetted seed compiled into the binary.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use serde_json::{Value, json};

/// Fewer valid rows than this and the optimizer only records candidates.
pub const MIN_HOLDOUT_SIZE: usize = 30;

const SEED: &str = include_str!("../../../recommender/eval/holdout.seed.jsonl");

#[derive(Debug, Clone, PartialEq)]
pub struct HoldoutEntry {
    pub sub: String,
    pub kind: String,
    pub library: Vec<i64>,
    pub positives: Vec<i64>,
    pub negatives: Vec<i64>,
}

/// The file the holdout comes from, or None for the seed.
fn resolve(path: Option<&Path>) -> Option<&Path> {
    path.filter(|p| p.exists())
}

pub fn load_holdout(path: Option<&Path>) -> std::io::Result<Vec<HoldoutEntry>> {
    Ok(match resolve(path) {
        Some(p) => parse(&std::fs::read_to_string(p)?, &p.display().to_string()),
        None => parse(SEED, "holdout.seed.jsonl"),
    })
}

/// One entry per valid line; a malformed line is skipped with a warning so it
/// cannot take the rest of the holdout down with it.
fn parse(text: &str, name: &str) -> Vec<HoldoutEntry> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match entry(line) {
            Ok(e) => out.push(e),
            Err(why) => tracing::warn!("holdout {name}:{} skipped ({why})", i + 1),
        }
    }
    out
}

fn entry(line: &str) -> Result<HoldoutEntry, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("invalid JSON: {e}"))?;
    let Value::Object(o) = &v else {
        return Err("expected JSON object".into());
    };
    let sub = match o.get("sub") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Err("missing/empty sub".into()),
    };
    let kind = match o.get("kind").and_then(Value::as_str) {
        Some(k @ ("movie" | "tv")) => k.to_string(),
        other => return Err(format!("kind not in {{movie,tv}}: {other:?}")),
    };
    let ints = |field: &str| -> Result<Vec<i64>, String> {
        match o.get(field) {
            None => Ok(Vec::new()),
            Some(Value::Array(a)) => a
                .iter()
                .map(|x| {
                    x.as_i64()
                        .ok_or_else(|| format!("{field} must contain only ints"))
                })
                .collect(),
            Some(_) => Err(format!("{field} must be a list")),
        }
    };
    let (library, positives, negatives) =
        (ints("library")?, ints("positives")?, ints("negatives")?);
    if positives.is_empty() {
        return Err("positives list is empty — no recall signal".into());
    }
    Ok(HoldoutEntry {
        sub,
        kind,
        library,
        positives,
        negatives,
    })
}

/// (mtime, size) of the holdout file; None for the seed.
type Stamp = Option<(SystemTime, u64)>;
/// Keyed by the resolved file (None: the seed). One entry in production.
type StatusCache = HashMap<Option<PathBuf>, (Stamp, Value)>;
static STATUS_CACHE: LazyLock<Mutex<StatusCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The /health summary. Cached by (path, mtime, size), so a probe does not
/// re-parse the file but a swap or rewrite shows up at once. Any read error is
/// `{"mode": "unknown"}`: /health never fails on this.
pub fn holdout_status(path: Option<&Path>) -> Value {
    let file = resolve(path).map(Path::to_path_buf);
    let stamp: Option<Stamp> = match &file {
        Some(p) => std::fs::metadata(p)
            .and_then(|m| Ok((m.modified()?, m.len())))
            .ok()
            .map(Some), // None: racing deletion, parse afresh and cache nothing
        None => Some(None),
    };
    let mut cache = STATUS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(st) = &stamp
        && let Some((cached, status)) = cache.get(&file)
        && cached == st
    {
        return status.clone();
    }
    let Ok(rows) = load_holdout(path) else {
        return json!({ "mode": "unknown" });
    };
    let status = json!({
        "mode": if rows.len() >= MIN_HOLDOUT_SIZE { "active" } else { "record-only" },
        "holdout_size": rows.len(),
        "min_holdout_size": MIN_HOLDOUT_SIZE,
    });
    if let Some(st) = stamp {
        cache.insert(file, (st, status.clone()));
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, n: usize) {
        let rows: Vec<String> = (0..n)
            .map(|i| {
                json!({"sub": format!("plex:u{i}"), "kind": "movie", "library": [10, 11],
                       "positives": [157336], "negatives": []})
                .to_string()
            })
            .collect();
        std::fs::write(path, rows.join("\n") + "\n").unwrap();
    }

    // recommender/tests/test_holdout_status_cache.py and test_optimizer_holdout.py.
    #[test]
    fn status_cache_and_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("absent.jsonl");

        // Seed fallback: active.
        let s = holdout_status(Some(&missing));
        assert_eq!(s["mode"], "active");
        assert!(s["holdout_size"].as_u64().unwrap() >= MIN_HOLDOUT_SIZE as u64);
        assert_eq!(s["min_holdout_size"], MIN_HOLDOUT_SIZE);
        assert_eq!(holdout_status(None), s);

        // Too small: record-only.
        let tiny = dir.path().join("tiny.jsonl");
        write(&tiny, MIN_HOLDOUT_SIZE - 1);
        let s = holdout_status(Some(&tiny));
        assert_eq!(s["mode"], "record-only");
        assert_eq!(s["holdout_size"], MIN_HOLDOUT_SIZE - 1);

        // A cache hit does not re-read: corrupt the bytes, keep size and mtime.
        let p = dir.path().join("holdout.jsonl");
        write(&p, 3);
        let meta = std::fs::metadata(&p).unwrap();
        assert_eq!(holdout_status(Some(&p))["holdout_size"], 3);
        let same_len = "x".repeat(meta.len() as usize);
        std::fs::write(&p, same_len).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(meta.modified().unwrap())
            .unwrap();
        assert_eq!(
            holdout_status(Some(&p))["holdout_size"],
            3,
            "served from the cache"
        );

        // An mtime change invalidates.
        write(&p, MIN_HOLDOUT_SIZE);
        std::fs::File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(meta.modified().unwrap() + std::time::Duration::from_secs(1))
            .unwrap();
        let s = holdout_status(Some(&p));
        assert_eq!(
            (s["holdout_size"].as_u64(), s["mode"].as_str()),
            (Some(30), Some("active"))
        );

        // A path change invalidates.
        let (a, b) = (dir.path().join("a.jsonl"), dir.path().join("b.jsonl"));
        write(&a, 1);
        write(&b, 4);
        assert_eq!(holdout_status(Some(&a))["holdout_size"], 1);
        assert_eq!(holdout_status(Some(&b))["holdout_size"], 4);

        // Unreadable: unknown, never an error.
        std::fs::write(&a, [0xff, 0xfe]).unwrap();
        assert_eq!(holdout_status(Some(&a)), json!({"mode": "unknown"}));
    }

    #[test]
    fn explicit_path_wins() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("holdout.jsonl");
        let row = json!({"sub": "plex:u1", "kind": "movie", "library": (10..25).collect::<Vec<_>>(),
                         "positives": [157336], "negatives": [603534]});
        std::fs::write(&p, format!("{row}\n")).unwrap();
        assert_eq!(
            load_holdout(Some(&p)).unwrap(),
            [HoldoutEntry {
                sub: "plex:u1".into(),
                kind: "movie".into(),
                library: (10..25).collect(),
                positives: vec![157336],
                negatives: vec![603534],
            }]
        );
    }

    #[test]
    fn malformed_lines_are_skipped_alone() {
        let rows = parse(
            concat!(
                "{bad\n",
                "[1]\n",
                "{\"sub\": \"\", \"kind\": \"movie\", \"positives\": [1]}\n",
                "{\"sub\": \"a\", \"kind\": \"show\", \"positives\": [1]}\n",
                "{\"sub\": \"a\", \"kind\": \"tv\", \"library\": 5, \"positives\": [1]}\n",
                "{\"sub\": \"a\", \"kind\": \"tv\", \"library\": [true], \"positives\": [1]}\n",
                "{\"sub\": \"a\", \"kind\": \"tv\", \"positives\": [1.5]}\n",
                "{\"sub\": \"a\", \"kind\": \"tv\", \"positives\": []}\n",
                "\n",
                "{\"sub\": \"a\", \"kind\": \"tv\", \"positives\": [7]}\n",
            ),
            "t",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (rows[0].positives.as_slice(), rows[0].library.len()),
            (&[7][..], 0)
        );
    }

    // test_seed_holdout_is_committed_and_well_formed.
    #[test]
    fn seed_is_well_formed() {
        let raw: Vec<Value> = SEED
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert!(raw.len() >= MIN_HOLDOUT_SIZE);
        for row in &raw {
            let mut keys: Vec<&String> = row.as_object().unwrap().keys().collect();
            keys.sort();
            assert_eq!(keys, ["kind", "library", "negatives", "positives", "sub"]);
        }
        let rows = parse(SEED, "seed");
        assert_eq!(rows.len(), raw.len());
        for r in rows {
            assert!(r.kind == "movie" || r.kind == "tv");
            assert!(!r.positives.is_empty());
            assert!(r.positives.iter().all(|p| !r.library.contains(p)));
        }
    }
}
