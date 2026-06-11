//! Integration tests that load `tests/vectors/*.json` from the repo
//! root and verify the Rust crate produces byte-identical output. This
//! is the cross-language interop gate — any divergence between Rust
//! and TS will surface as a vector mismatch here.

use emerald_contracts::stream_token::{StreamClaims, StreamKind, canonical_bytes, sign};
use emerald_contracts::{
    DeviceClaims, DeviceTokenError, INFO_DEVICE_TOKEN, INFO_INTERNAL_PRINCIPAL, INFO_SESSION,
    InternalClaims, InternalPrincipalError, derive_key, device_token, internal_principal,
    jwe::JweError, telemetry,
};
use serde_json::Value;
use std::collections::HashMap;
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
fn sub_namespace_vector() {
    let v = load_vector("sub-namespace.json");
    let cases = v.as_array().expect("top-level array");
    assert!(cases.len() >= 13, "vector file lost cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        if case["valid"].as_bool().unwrap() {
            let got = emerald_contracts::parse_sub(input)
                .unwrap_or_else(|e| panic!("vector {}: parse failed: {:?}", name, e));
            let provider = match got.provider {
                emerald_contracts::Provider::Plex => "plex",
                emerald_contracts::Provider::Local => "local",
                emerald_contracts::Provider::Apple => "apple",
            };
            assert_eq!(provider, case["provider"].as_str().unwrap(), "vector {}", name);
            assert_eq!(got.id, case["id"].as_str().unwrap(), "vector {}", name);
            assert_eq!(got.raw, input, "vector {}", name);
        } else {
            assert!(
                emerald_contracts::parse_sub(input).is_err(),
                "vector {}: invalid input was accepted",
                name,
            );
        }
    }
}

#[test]
fn telemetry_pii_scrub_vector() {
    let v = load_vector("telemetry-pii-scrub.json");
    let cases = v["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "vector file has no cases");
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let mut input = case["input"].clone();
        telemetry::scrub_value(&mut input);
        assert_eq!(
            input, case["expected"],
            "case {}: scrubbed output diverged from vector",
            id,
        );
    }
}

#[test]
fn device_token_kid_rotation_vector() {
    let v = load_vector("device-token-kid-rotation.json");

    // Key map: assert HKDF(testSecretUtf8, hkdfInfo) reproduces every
    // pinned derivedKeyHex, then collect kid → key for the verifier.
    let mut keys: HashMap<String, [u8; 32]> = HashMap::new();
    for (kid, entry) in v["keyMap"].as_object().expect("keyMap") {
        let secret = entry["testSecretUtf8"].as_str().unwrap();
        assert_eq!(
            hex_encode(secret.as_bytes()),
            entry["testSecretHex"].as_str().unwrap(),
            "kid {}: testSecretHex does not match testSecretUtf8",
            kid,
        );
        let info = entry["hkdfInfo"].as_str().unwrap();
        let derived = derive_key(secret.as_bytes(), info.as_bytes());
        assert_eq!(
            hex_encode(&derived),
            entry["derivedKeyHex"].as_str().unwrap(),
            "kid {}: HKDF derivation diverged from vector",
            kid,
        );
        keys.insert(kid.clone(), derived);
    }

    for case in v["vectors"].as_array().expect("vectors") {
        let name = case["name"].as_str().unwrap();
        match case["expectedResult"].as_str().unwrap() {
            "accepted" => {
                let claims: DeviceClaims =
                    serde_json::from_value(case["expectedClaims"].clone())
                        .unwrap_or_else(|e| panic!("vector {}: bad expectedClaims: {}", name, e));
                let kid = case["kid"].as_str().unwrap();
                let key = keys.get(kid).expect("kid present in keyMap");

                // Fresh mint round-trips through the multi-key verifier.
                let token = device_token::encrypt(key, kid, &claims);
                let got = device_token::decrypt(&keys, &token)
                    .unwrap_or_else(|e| panic!("vector {}: decrypt failed: {:?}", name, e));
                assert_eq!(got, claims, "vector {}: claims diverged", name);

                // The pinned cross-language sampleToken must also decrypt
                // to the same claims (tokens are non-deterministic; claims
                // comparison is the contract).
                let sample = case["sampleToken"].as_str().unwrap();
                let got_sample = device_token::decrypt(&keys, sample)
                    .unwrap_or_else(|e| panic!("vector {}: sampleToken failed: {:?}", name, e));
                assert_eq!(got_sample, claims, "vector {}: sampleToken claims", name);
            }
            "rejected" => {
                let token = case["syntheticToken"].as_str().unwrap();
                let err = device_token::decrypt(&keys, token)
                    .expect_err("synthetic token must be rejected");
                match case["expectedErrorCode"].as_str().unwrap() {
                    "kid_unknown" => match err {
                        DeviceTokenError::UnknownKid(kid) => {
                            assert_eq!(kid, case["kid"].as_str().unwrap(), "vector {}", name)
                        }
                        e => panic!("vector {}: expected UnknownKid, got {:?}", name, e),
                    },
                    "header_invalid" => match err {
                        DeviceTokenError::Jwe(JweError::BadHeader) => {}
                        e => panic!("vector {}: expected Jwe(BadHeader), got {:?}", name, e),
                    },
                    code => panic!("vector {}: unhandled expectedErrorCode {}", name, code),
                }
            }
            other => panic!("vector {}: unknown expectedResult {}", name, other),
        }
    }
}

#[test]
fn internal_principal_round_trip_vector() {
    let v = load_vector("internal-principal.json");
    let rt = &v["round_trip_vector"];

    let secret = rt["secret_hex_utf8"].as_str().expect("secret");
    let key = derive_key(secret.as_bytes(), INFO_INTERNAL_PRINCIPAL);
    assert_eq!(
        hex_encode(&key),
        rt["derived_key_hex"].as_str().unwrap(),
        "HKDF internal-principal derivation diverged from vector",
    );

    let claims: InternalClaims =
        serde_json::from_value(rt["claims_input"].clone()).expect("claims_input parses");
    let kid = v["jwe_shape"]["protected_header"]["kid"]
        .as_str()
        .expect("kid");

    let token = internal_principal::encrypt(&key, kid, &claims);
    let mut keys = HashMap::new();
    keys.insert(kid.to_string(), key);
    let got = internal_principal::decrypt(&keys, &token).expect("round trip decrypts");
    assert_eq!(got, claims, "round-trip claims diverged");

    // Header shape: alg/enc/kid exactly as pinned (negative checks for
    // other alg/enc live in the jwe module's own tests).
    let header_b64 = token.split('.').next().unwrap();
    let header: Value = serde_json::from_slice(
        &base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, header_b64)
            .expect("header b64u"),
    )
    .expect("header JSON");
    assert_eq!(header, v["jwe_shape"]["protected_header"]);

    // negative_checks: nonce-uniqueness — same claims+key must yield a
    // different compact string every encrypt (random IV).
    let token2 = internal_principal::encrypt(keys.get(kid).unwrap(), kid, &claims);
    assert_ne!(token, token2, "nonce reuse: two encrypts produced identical JWE");

    // negative_checks: expired-rejected — enforce_time_window fires past exp.
    assert!(matches!(
        internal_principal::enforce_time_window(&claims, claims.exp + 1).unwrap_err(),
        InternalPrincipalError::Expired,
    ));
    internal_principal::enforce_time_window(&claims, claims.exp).expect("at exp is still valid");

    // negative_checks: unknown-kid-rejects — never brute-force the map.
    let stranger = internal_principal::encrypt(keys.get(kid).unwrap(), "internal-v99", &claims);
    match internal_principal::decrypt(&keys, &stranger).unwrap_err() {
        InternalPrincipalError::UnknownKid(k) => assert_eq!(k, "internal-v99"),
        e => panic!("expected UnknownKid, got {:?}", e),
    }

    // negative_checks: tampered-aad-rejects — header is AAD; flipping it
    // invalidates the tag.
    let tampered_header = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        format!(r#"{{"alg":"dir","enc":"A256GCM","kid":"{}","x":1}}"#, kid),
    );
    let rest: Vec<&str> = token.split('.').skip(1).collect();
    let tampered = format!("{}.{}", tampered_header, rest.join("."));
    match internal_principal::decrypt(&keys, &tampered).unwrap_err() {
        InternalPrincipalError::Jwe(JweError::DecryptFailed) => {}
        e => panic!("expected Jwe(DecryptFailed), got {:?}", e),
    }

    // negative_checks: wrong-iss-rejected.
    let mut bad_iss = claims.clone();
    bad_iss.iss = "evil".to_string();
    let bad_token = internal_principal::encrypt(keys.get(kid).unwrap(), kid, &bad_iss);
    assert!(matches!(
        internal_principal::decrypt(&keys, &bad_token).unwrap_err(),
        InternalPrincipalError::UnsupportedIss,
    ));
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
