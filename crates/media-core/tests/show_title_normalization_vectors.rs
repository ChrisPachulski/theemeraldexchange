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
//! The implementations now intentionally share one output contract: every
//! vector and equivalence class below must pass in normal CI. This includes
//! diacritic folding, `&` expansion, punctuation splitting, and preserving a
//! title that consists only of a year.

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
}

#[derive(Debug, Deserialize)]
struct EquivClass {
    name: String,
    members: Vec<String>,
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

/// Pins Rust's `normalize_show_name` output to the cross-language contract.
#[test]
fn rust_matches_swift_join_key_contract() {
    let file = load();
    let mut failures = Vec::new();
    for v in &file.vectors {
        let actual = normalize_show_name(&v.input);
        if actual != v.key {
            failures.push(format!(
                "[{}] normalize_show_name({:?}) = {:?}, expected {:?}",
                v.name, v.input, actual, v.key
            ));
        }
    }

    for c in &file.equivalence_classes {
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
