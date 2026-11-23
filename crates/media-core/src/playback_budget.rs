//! Time budgets shared by the services on a native player's start path. The
//! transcoder and the gateway both read them, so one cannot be retuned without
//! the other: a gateway cut shorter than the transcoder's own wait turns an
//! asset that is about to arrive into a 504.

use std::time::Duration;

/// Longest the transcoder holds a native player's request for an asset that is
/// still being produced (a frontier segment, `init.mp4`, the sidecar
/// subtitle) before answering 404.
pub const NATIVE_ASSET_WAIT: Duration = Duration::from_secs(20);

/// The gateway's time-to-first-byte for requests proxied to the transcoder:
/// the asset wait plus headroom for the poll interval and the LAN hop.
/// It used to be the generic 15 s media budget, below the 20 s wait, so the
/// gateway answered 504 for a segment or subtitle the transcoder would still
/// have delivered (found replaying The Polar Express, 2026-11-22).
pub const TRANSCODE_TTFB: Duration = Duration::from_secs(NATIVE_ASSET_WAIT.as_secs() + 5);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_outwaits_the_transcoder() {
        assert!(TRANSCODE_TTFB > NATIVE_ASSET_WAIT);
        assert_eq!(TRANSCODE_TTFB, Duration::from_secs(25));
    }
}
