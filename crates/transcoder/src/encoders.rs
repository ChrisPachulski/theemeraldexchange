//! Boot-time hardware-encoder detection (§4.4 "Detection at boot").
//!
//! At start we run `ffmpeg -hide_banner -encoders` once and parse the output to
//! learn which H.264 hardware encoders the binary was actually built with. The
//! configured [`HwEncoder`](crate::args::HwEncoder) is only honored if the
//! corresponding encoder is present; otherwise we fall back to `libx264` and
//! log a warning. The parsing is pure (operates on the captured stdout string)
//! so it is tested against a fixture, never a live ffmpeg.

use crate::args::HwEncoder;

/// The set of H.264 encoders ffmpeg reported.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AvailableEncoders {
    pub libx264: bool,
    pub videotoolbox: bool,
    pub nvenc: bool,
    pub vaapi: bool,
    pub qsv: bool,
}

impl AvailableEncoders {
    /// Parse the stdout of `ffmpeg -encoders`. Each encoder line looks like:
    /// ` V....D h264_videotoolbox    VideoToolbox H.264 Encoder`.
    /// We match on the encoder NAME token (second whitespace field), so a name
    /// appearing only inside a human description never produces a false match.
    pub fn parse(encoders_stdout: &str) -> Self {
        let mut out = AvailableEncoders::default();
        for line in encoders_stdout.lines() {
            // The capability flags column is 6 chars wide; the encoder name is
            // the first whitespace token after it. Be lenient: just scan tokens.
            let mut tokens = line.split_whitespace();
            // Skip the flags token (e.g. "V....D"); the next token is the name.
            let _flags = tokens.next();
            let Some(name) = tokens.next() else { continue };
            match name {
                "libx264" => out.libx264 = true,
                "h264_videotoolbox" => out.videotoolbox = true,
                "h264_nvenc" => out.nvenc = true,
                "h264_vaapi" => out.vaapi = true,
                "h264_qsv" => out.qsv = true,
                _ => {}
            }
        }
        out
    }

    /// Is the encoder for this family present?
    pub fn supports(&self, enc: HwEncoder) -> bool {
        match enc {
            HwEncoder::Cpu => self.libx264,
            HwEncoder::VideoToolbox => self.videotoolbox,
            HwEncoder::Nvenc => self.nvenc,
            HwEncoder::Vaapi => self.vaapi,
            HwEncoder::Qsv => self.qsv,
        }
    }

    /// Resolve the encoder to actually use: honor `preferred` when present,
    /// otherwise fall back to CPU. Returns `(resolved, fell_back)`.
    pub fn resolve(&self, preferred: HwEncoder) -> (HwEncoder, bool) {
        if self.supports(preferred) {
            (preferred, false)
        } else {
            (HwEncoder::Cpu, preferred != HwEncoder::Cpu)
        }
    }
}

/// Run `ffmpeg -encoders` and parse the result. Best-effort: any failure to
/// launch ffmpeg yields an empty set (caller falls back to CPU and logs).
pub async fn detect(ffmpeg_bin: &str) -> AvailableEncoders {
    let output = tokio::process::Command::new(ffmpeg_bin)
        .args(["-hide_banner", "-encoders"])
        .output()
        .await;
    match output {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout);
            AvailableEncoders::parse(&text)
        }
        Err(e) => {
            tracing::warn!(ffmpeg_bin, error = %e, "ffmpeg -encoders probe failed; assuming CPU only");
            AvailableEncoders::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A trimmed, realistic capture of `ffmpeg -encoders` output.
    const FIXTURE: &str = "\
Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder
 V..... aac                  AAC (Advanced Audio Coding)
 A....D aac                  AAC (Advanced Audio Coding)
";

    const FIXTURE_NVENC_VAAPI: &str = "\
Encoders:
 V....D libx264              libx264 H.264
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder
 V....D h264_vaapi           VAAPI H.264 encoder
 V....D h264_qsv             Intel QSV H.264 encoder
";

    #[test]
    fn parses_videotoolbox_fixture() {
        let e = AvailableEncoders::parse(FIXTURE);
        assert!(e.libx264);
        assert!(e.videotoolbox);
        assert!(!e.nvenc);
        assert!(!e.vaapi);
        assert!(!e.qsv);
    }

    #[test]
    fn parses_nvenc_vaapi_qsv_fixture() {
        let e = AvailableEncoders::parse(FIXTURE_NVENC_VAAPI);
        assert!(e.libx264);
        assert!(e.nvenc);
        assert!(e.vaapi);
        assert!(e.qsv);
        assert!(!e.videotoolbox);
    }

    #[test]
    fn description_only_mention_is_not_a_false_positive() {
        // "h264_nvenc" appears only in a description column, never as a name.
        let txt = " V....D libx264              An encoder that is not h264_nvenc at all\n";
        let e = AvailableEncoders::parse(txt);
        assert!(e.libx264);
        assert!(!e.nvenc, "must match on name token, not description");
    }

    #[test]
    fn resolve_honors_present_encoder() {
        let e = AvailableEncoders::parse(FIXTURE);
        assert_eq!(
            e.resolve(HwEncoder::VideoToolbox),
            (HwEncoder::VideoToolbox, false)
        );
    }

    #[test]
    fn resolve_falls_back_to_cpu_when_absent() {
        let e = AvailableEncoders::parse(FIXTURE);
        // No nvenc in the videotoolbox fixture → fall back to CPU + flag it.
        assert_eq!(e.resolve(HwEncoder::Nvenc), (HwEncoder::Cpu, true));
    }

    #[test]
    fn resolve_cpu_request_never_flags_fallback() {
        let e = AvailableEncoders::parse(FIXTURE);
        assert_eq!(e.resolve(HwEncoder::Cpu), (HwEncoder::Cpu, false));
    }

    #[test]
    fn empty_output_supports_nothing() {
        let e = AvailableEncoders::default();
        assert!(!e.supports(HwEncoder::Cpu));
        assert_eq!(e.resolve(HwEncoder::VideoToolbox), (HwEncoder::Cpu, true));
    }
}
