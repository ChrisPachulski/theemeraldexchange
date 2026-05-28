//! Vector value generator. Run with: `cargo run --example gen_vectors`.
//!
//! Prints the Rust-computed expected outputs (HKDF OKM, JWE shapes) so
//! the JSON vectors can be authored with hand-checked values that the TS
//! port MUST reproduce.

use emerald_contracts::{INFO_DEVICE_TOKEN, INFO_INTERNAL_PRINCIPAL, INFO_SESSION, derive_key};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn main() {
    let secret = b"TEST_SECRET_32_CHARS_FIXED_VALUE_X";
    println!(
        "HKDF parity (secret = {:?}, len={})",
        std::str::from_utf8(secret).unwrap(),
        secret.len()
    );
    println!(
        "  INFO_SESSION              = {}",
        hex(&derive_key(secret, INFO_SESSION))
    );
    println!(
        "  INFO_DEVICE_TOKEN         = {}",
        hex(&derive_key(secret, INFO_DEVICE_TOKEN))
    );
    println!(
        "  INFO_INTERNAL_PRINCIPAL   = {}",
        hex(&derive_key(secret, INFO_INTERNAL_PRINCIPAL))
    );

    let alt_secret = b"alternate-secret-32-chars-fixed-X";
    println!(
        "\nHKDF parity (secret = {:?}, len={})",
        std::str::from_utf8(alt_secret).unwrap(),
        alt_secret.len()
    );
    println!(
        "  INFO_SESSION              = {}",
        hex(&derive_key(alt_secret, INFO_SESSION))
    );
    println!(
        "  INFO_DEVICE_TOKEN         = {}",
        hex(&derive_key(alt_secret, INFO_DEVICE_TOKEN))
    );
    println!(
        "  INFO_INTERNAL_PRINCIPAL   = {}",
        hex(&derive_key(alt_secret, INFO_INTERNAL_PRINCIPAL))
    );
}
