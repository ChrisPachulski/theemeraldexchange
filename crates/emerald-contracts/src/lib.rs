//! emerald-contracts — canonical cross-language contracts for The Emerald Exchange.
//!
//! Source of truth for tokens, HKDF derivation, sub-namespace parsing,
//! and PII scrub keys. The Rust services (gateway, auth, iptv, media-core,
//! transcoder, recommender) link it directly; Apple uses a Swift port.
//!
//! Test vectors at `tests/vectors/*.json` are the cross-language interop
//! oracle. `cargo test` runs every vector against this crate's
//! implementation.

pub mod canonical;
pub mod device_token;
pub mod hkdf;
pub mod internal_principal;
pub mod jwe;
pub mod stream_token;
pub mod sub;
pub mod telemetry;

// Top-level re-exports for ergonomic FFI binding code.
pub use device_token::{DeviceClaims, DeviceTokenError};
pub use hkdf::{
    INFO_DEVICE_TOKEN, INFO_INTERNAL_PRINCIPAL, INFO_SESSION, INFO_STREAM_TOKEN_RESERVED,
    derive_key,
};
pub use internal_principal::{InternalClaims, InternalPrincipalError};
pub use stream_token::{EXP_SKEW_SECS, NBF_SKEW_SECS, StreamClaims, StreamKind, TokenError};
pub use sub::{Provider, Sub, SubError, parse_sub};
