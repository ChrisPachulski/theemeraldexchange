//! Integration tests that load `tests/vectors/*.json` from the repo
//! root and verify the Rust crate produces byte-identical output. This
//! is the cross-language interop gate — any divergence between Rust
//! and TS will surface as a vector mismatch here.

use emerald_contracts::stream_token::{StreamClaims, StreamKind, canonical_bytes, sign};
use emerald_contracts::{INFO_DEVICE_TOKEN, INFO_INTERNAL_PRINCIPAL, INFO_SESSION, derive_key};
use serde_json::Value;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    // tests/ is two levels up from CARGO_MANIFEST_DIR.
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // crates/
    p.pop(); // repo root
    p
}

fn load_vector(name: &str) -> Value {
    let path = repo_root().join("tests/vectors").join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    serde_json::from_slice(&bytes).expect("valid JSON")
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[test]
fn stream_token_canonical_vector_parity() {
    let v = load_vector("stream-token-canonical.json");
    let test_key = v["test_key"].as_str().expect("test_key").to_string();
    let vectors = v["vectors"].as_array().expect("vectors");
    for vec in vectors {
        let name = vec["name"].as_str().unwrap();
        let c = &vec["claims_input"];
        let claims = StreamClaims {
            exp: c["exp"].as_i64().unwrap(),
            iat: c["iat"].as_i64().unwrap(),
            jti: c["jti"].as_str().unwrap().to_string(),
            k: StreamKind::from_wire(c["k"].as_str().unwrap())
                .unwrap_or_else(|| panic!("unknown kind in vector {}: {}", name, c["k"])),
            nbf: c["nbf"].as_i64().unwrap(),
            rid: c["rid"].as_str().unwrap().to_string(),
            sub: c["sub"].as_str().unwrap().to_string(),
            v: c["v"].as_u64().unwrap() as u32,
        };

        let got_canonical = canonical_bytes(&claims);
        let want_canonical = hex_decode(vec["canonical_bytes_hex"].as_str().unwrap());
        assert_eq!(
            got_canonical, want_canonical,
            "vector {}: canonical bytes diverged",
            name,
        );

        let token = sign(test_key.as_bytes(), &claims);
        let (_, sig_b64) = token.split_once('.').unwrap();
        let sig =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, sig_b64)
                .expect("sig b64u");
        let want_sig = hex_decode(vec["hmac_hex_with_test_key"].as_str().unwrap());
        assert_eq!(sig, want_sig, "vector {}: HMAC diverged from TS", name);
    }
}

#[test]
fn hkdf_parity_vector() {
    let v = load_vector("hkdf-parity.json");
    let vectors = v["vectors"].as_array().expect("vectors");
    for vec in vectors {
        let name = vec["name"].as_str().unwrap();
        let ikm = vec["ikm_utf8"].as_str().unwrap().as_bytes();
        for (label, info) in [
            ("session", INFO_SESSION),
            ("device_token", INFO_DEVICE_TOKEN),
            ("internal_principal", INFO_INTERNAL_PRINCIPAL),
        ] {
            let want_hex = vec["derivations"][label]["okm_hex"].as_str().unwrap();
            let got = derive_key(ikm, info);
            assert_eq!(
                hex_encode(&got),
                want_hex,
                "vector {}: HKDF derivation {} diverged",
                name,
                label,
            );
        }
    }
}
