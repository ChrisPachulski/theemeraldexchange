//! Cross-language pin for the last-resort show-title join key.
//!
//! The Swift `MediaLibraryStore.normalizedShowTitle` and the Rust
//! `media_core::filename::normalize_show_name` independently compute the SAME
//! join key that recovers an id-less media-core show's Play button ("The
//! American Experiment" incident). They were coupled only by a doc comment, and
//! the trailing-year strip was fixed independently in BOTH languages on the same
//! day (apple 6368b8d, server dd7a817) because nothing pinned the behaviour.
//!
//! The Swift side is frozen inline in
//! `Tests/EmeraldKitTests/NormalizedShowTitleVectorTests.swift`; this file wires
//! the Rust side to the shared vector set at `tests/vectors/
//! show-title-normalization.json` so a unilateral tweak on either side goes red.
//!
//! KNOWN DRIFT (see the vector file's `_meta.known_drift`): the two normalizers
//! are not byte-identical today. Swift additionally folds diacritics, maps `&`
//! to `and`, and treats every non-alphanumeric (incl. apostrophe) as a token
//! separator. Rust's `clean()` treats only `.`, `_`, `-` and whitespace as
//! separators and does neither folding nor `&` expansion. Vectors that hit those
//! divergences are tagged `swift_only` in the JSON and carry a `rust_expected`
//! value. Two tests split the difference:
//!   * `rust_matches_shared_vectors` (default, GREEN) pins the CURRENT Rust
//!     output — the shared `key` for parity vectors, `rust_expected` for drift.
//!   * `rust_reaches_full_swift_parity` (`#[ignore]`) asserts Rust equals the
//!     Swift `key` for EVERY vector; it stays red until the normalizers are
//!     reconciled, so it documents the gap without a red suite.

use std::path::PathBuf;

use media_core::filename::normalize_show_name;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct VectorFile {
    vectors: Vec<Vector>,
    equivalence_classes: Vec<EquivClass>,
}

#[derive(Debug, Deserialize)]
struct Vector {
    name: String,
    input: String,
    /// The Swift normalized key (the cross-language target).
    key: String,
    /// True when the Swift and Rust normalizers diverge on this input.
    #[serde(default)]
    swift_only: bool,
    /// The value the CURRENT Rust normalizer produces (present only on drift).
    #[serde(default)]
    rust_expected: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EquivClass {
    name: String,
    members: Vec<String>,
    /// True when Swift collapses this class to one key but Rust does not.
    #[serde(default)]
    swift_only: bool,
}

fn load() -> VectorFile {
    // CARGO_MANIFEST_DIR = <repo>/crates/media-core; the shared vectors live at
    // <repo>/tests/vectors, two levels up.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/vectors/show-title-normalization.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read shared vector file {}: {e}", path.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("parse shared vector file {}: {e}", path.display()))
}

/// GREEN: pins the CURRENT Rust `normalize_show_name` output against the shared
/// file. Parity vectors must equal the Swift `key`; documented-drift vectors
/// must equal their `rust_expected`. A drift vector missing `rust_expected` is a
/// spec error and fails loudly.
#[test]
fn rust_matches_shared_vectors() {
    let file = load();
    let mut failures = Vec::new();
    for v in &file.vectors {
        let actual = normalize_show_name(&v.input);
        let expected = if v.swift_only {
            match &v.rust_expected {
                Some(e) => e.clone(),
                None => {
                    failures.push(format!(
                        "[{}] tagged swift_only but has no rust_expected",
                        v.name
                    ));
                    continue;
                }
            }
        } else {
            v.key.clone()
        };
        if actual != expected {
            failures.push(format!(
                "[{}] normalize_show_name({:?}) = {:?}, expected {:?}",
                v.name, v.input, actual, expected
            ));
        }
    }

    // Equivalence classes that are NOT swift_only must collapse to one Rust key.
    for c in &file.equivalence_classes {
        if c.swift_only {
            continue;
        }
        let keys: std::collections::BTreeSet<String> =
            c.members.iter().map(|m| normalize_show_name(m)).collect();
        if keys.len() != 1 {
            failures.push(format!(
                "[equiv:{}] expected one shared Rust key for {:?}, got {:?}",
                c.name, c.members, keys
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "shared-vector drift:\n{}",
        failures.join("\n")
    );
}

/// IGNORED until the Swift and Rust normalizers are reconciled: asserts Rust
/// reaches FULL Swift parity (every vector's Swift `key`, every equivalence
/// class collapsing). Run with `cargo test -p media-core -- --ignored` to see
/// the exact remaining gap. Keeping it as a real test means the day the
/// normalizers converge, dropping `#[ignore]` is the only change needed.
#[test]
#[ignore = "Swift↔Rust normalizer drift (diacritics, '&'→'and', apostrophe split); see vector _meta.known_drift"]
fn rust_reaches_full_swift_parity() {
    let file = load();
    let mut failures = Vec::new();
    for v in &file.vectors {
        let actual = normalize_show_name(&v.input);
        if actual != v.key {
            failures.push(format!(
                "[{}] normalize_show_name({:?}) = {:?}, Swift key {:?}",
                v.name, v.input, actual, v.key
            ));
        }
    }
    for c in &file.equivalence_classes {
        let keys: std::collections::BTreeSet<String> =
            c.members.iter().map(|m| normalize_show_name(m)).collect();
        if keys.len() != 1 {
            failures.push(format!(
                "[equiv:{}] Swift collapses {:?} to one key; Rust got {:?}",
                c.name, c.members, keys
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "Swift↔Rust parity gap:\n{}",
        failures.join("\n")
    );
}
