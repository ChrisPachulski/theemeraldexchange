//! PyO3 binding for `emerald-contracts`. Recommender (FastAPI) imports this
//! via `import emerald_contracts` and calls the exposed functions instead
//! of re-implementing sub-namespace parsing or PII scrub denylists in
//! Python.
//!
//! Build (in this crate dir): `maturin develop --release`.
//! Output: an `emerald_contracts` extension module on the active venv.
//!
//! Surface mirrors `crates/emerald-contracts-napi/src/lib.rs` so Hono +
//! recommender call byte-identical code paths.

#![deny(clippy::all)]

use pyo3::exceptions::{PyKeyError, PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};
use std::collections::HashMap;

use ec::{
    derive_key as ec_derive_key, internal_principal, parse_sub as ec_parse_sub,
    sub::{Provider, SubError},
    telemetry::{scrub_value, PII_KEYS},
    INFO_DEVICE_TOKEN, INFO_INTERNAL_PRINCIPAL, INFO_SESSION,
};

// ---------------------------------------------------------------------------
// HKDF
// ---------------------------------------------------------------------------

#[pyfunction]
fn hkdf_session<'py>(py: Python<'py>, secret: &[u8]) -> Bound<'py, PyBytes> {
    PyBytes::new(py, &ec_derive_key(secret, INFO_SESSION))
}

#[pyfunction]
fn hkdf_device_token<'py>(py: Python<'py>, secret: &[u8]) -> Bound<'py, PyBytes> {
    PyBytes::new(py, &ec_derive_key(secret, INFO_DEVICE_TOKEN))
}

#[pyfunction]
fn hkdf_internal_principal<'py>(py: Python<'py>, secret: &[u8]) -> Bound<'py, PyBytes> {
    PyBytes::new(py, &ec_derive_key(secret, INFO_INTERNAL_PRINCIPAL))
}

// ---------------------------------------------------------------------------
// Sub-namespace parsing
// ---------------------------------------------------------------------------

/// Parse a namespaced `sub` string. Returns a dict
/// `{provider: 'plex'|'local'|'apple', id: str, raw: str}`.
/// Raises `ValueError` on malformed input.
#[pyfunction]
fn parse_sub<'py>(py: Python<'py>, s: &str) -> PyResult<Bound<'py, PyDict>> {
    let parsed = ec_parse_sub(s).map_err(sub_err_to_py)?;
    let provider = match parsed.provider {
        Provider::Plex => "plex",
        Provider::Local => "local",
        Provider::Apple => "apple",
    };
    let d = PyDict::new(py);
    d.set_item("provider", provider)?;
    d.set_item("id", parsed.id)?;
    d.set_item("raw", parsed.raw)?;
    Ok(d)
}

fn sub_err_to_py(e: SubError) -> PyErr {
    match e {
        SubError::Unprefixed => PyValueError::new_err("sub is missing provider prefix"),
        SubError::UnknownProvider => PyValueError::new_err("unknown sub provider"),
        SubError::InvalidFormat => PyValueError::new_err("sub fails provider regex"),
    }
}

// ---------------------------------------------------------------------------
// Telemetry PII scrub
// ---------------------------------------------------------------------------

#[pyfunction]
fn pii_scrub_keys<'py>(py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for k in PII_KEYS {
        list.append(*k)?;
    }
    Ok(list)
}

/// Scrub a JSON-serializable value (passed as a JSON string) and return
/// the redacted JSON string. Keeps the surface stringly-typed at the
/// boundary so we don't drag pyo3-serde-json into the build.
#[pyfunction]
fn pii_scrub_value(json_str: &str) -> PyResult<String> {
    let mut v: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| PyValueError::new_err(format!("{}", e)))?;
    scrub_value(&mut v);
    serde_json::to_string(&v).map_err(|e| PyRuntimeError::new_err(format!("{}", e)))
}

// ---------------------------------------------------------------------------
// Internal-principal decrypt (M3 prereq: recommender verifies inbound
// principals minted by Hono with INTERNAL_PRINCIPAL_SECRET).
// ---------------------------------------------------------------------------

/// Decrypt an internal-principal JWE using the supplied kid→key map.
/// `keys` is a dict[str, bytes] where each bytes value is exactly 32 bytes
/// (HKDF-derived from INTERNAL_PRINCIPAL_SECRET). Returns a dict of claims.
#[pyfunction]
fn internal_principal_decrypt<'py>(
    py: Python<'py>,
    keys: &Bound<'_, PyDict>,
    token: &str,
) -> PyResult<Bound<'py, PyDict>> {
    let mut map: HashMap<String, [u8; 32]> = HashMap::new();
    for (kid_obj, key_obj) in keys.iter() {
        let kid: String = kid_obj.extract()?;
        let bytes: Vec<u8> = key_obj.extract()?;
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| PyValueError::new_err("each internal-principal key must be 32 bytes"))?;
        map.insert(kid, arr);
    }
    let claims = internal_principal::decrypt(&map, token).map_err(|e| match e {
        internal_principal::InternalPrincipalError::UnknownKid(kid) => {
            PyKeyError::new_err(format!("unknown kid: {}", kid))
        }
        other => PyValueError::new_err(format!("{:?}", other)),
    })?;
    let d = PyDict::new(py);
    d.set_item("iss", claims.iss)?;
    d.set_item("sub", claims.sub)?;
    d.set_item("role", claims.role)?;
    d.set_item("auth_mode", claims.auth_mode)?;
    d.set_item("server_id", claims.server_id)?;
    d.set_item("device_id", claims.device_id)?;
    d.set_item("req_id", claims.req_id)?;
    d.set_item("iat", claims.iat)?;
    d.set_item("exp", claims.exp)?;
    Ok(d)
}

/// Enforce the 60-second TTL window on a previously-decrypted claim set.
/// Raises `ValueError` if `now_secs > exp`. Pure-Python could do this, but
/// keeping it here lets the contract own the comparison.
#[pyfunction]
fn internal_principal_enforce_time_window(exp: i64, now_secs: i64) -> PyResult<()> {
    if now_secs > exp {
        return Err(PyValueError::new_err("internal-principal expired"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------

#[pymodule]
fn emerald_contracts(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(hkdf_session, m)?)?;
    m.add_function(wrap_pyfunction!(hkdf_device_token, m)?)?;
    m.add_function(wrap_pyfunction!(hkdf_internal_principal, m)?)?;
    m.add_function(wrap_pyfunction!(parse_sub, m)?)?;
    m.add_function(wrap_pyfunction!(pii_scrub_keys, m)?)?;
    m.add_function(wrap_pyfunction!(pii_scrub_value, m)?)?;
    m.add_function(wrap_pyfunction!(internal_principal_decrypt, m)?)?;
    m.add_function(wrap_pyfunction!(internal_principal_enforce_time_window, m)?)?;
    Ok(())
}
