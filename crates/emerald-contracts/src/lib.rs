//! emerald-contracts — canonical cross-language contracts for The Emerald Exchange.
//!
//! Source of truth for tokens, HKDF derivation, sub-namespace parsing,
//! and PII scrub keys. Hono consumes via N-API (`emerald-contracts-napi`),
//! recommender via PyO3 (future), Apple via Swift port.
//!
//! Test vectors at `tests/vectors/*.json` are the cross-language interop
//! oracle. `cargo test` runs every vector against this crate's
//! implementation; CI gates Hono's `npm test` against the same vectors
//! via the N-API binding.

pub mod canonical;
pub mod device_token;
pub mod hkdf;
pub mod internal_principal;
pub mod jwe;
pub mod stream_token;
pub mod sub;
pub mod telemetry;

// Top-level re-exports for ergonomic FFI binding code.
pub use device_token::{DeviceClaims, DeviceTokenError, DEFAULT_KID as DEVICE_KID_DEFAULT, DEFAULT_TTL_SECS as DEVICE_TTL_DEFAULT};
pub use hkdf::{derive_key, INFO_DEVICE_TOKEN, INFO_INTERNAL_PRINCIPAL, INFO_SESSION, INFO_STREAM_TOKEN_RESERVED};
pub use internal_principal::{InternalClaims, InternalPrincipalError};
pub use stream_token::{StreamClaims, StreamKind, TokenError, EXP_SKEW_SECS, NBF_SKEW_SECS};
pub use sub::{parse_sub, Provider, Sub, SubError};
