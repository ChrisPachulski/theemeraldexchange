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

    /// Smoke-test each *detected* hardware encoder with a tiny null transcode and
    /// clear any that fails to actually run on this host (§audit 1-13).
    ///
    /// Presence in `ffmpeg -encoders` only proves an encoder was compiled in, not
    /// that the GPU/driver is present and functional. Without this, a GPU-less
    /// host where ffmpeg still lists `h264_nvenc`/`h264_vaapi` would have
    /// [`resolve`](Self::resolve) hand back a hardware family that then dies on
    /// the first real transcode (device-open failure) — a per-session crash-loop
    /// surfacing as a 503 to the user. Here we open the device once at boot via a
    /// 64x64 black-frame encode to `-f null`; anything that exits non-zero is
    /// cleared so `resolve` falls back to libx264/CPU. `libx264` is always CPU
    /// and never smoke-tested.
    pub async fn validate(mut self, ffmpeg_bin: &str) -> Self {
        if self.videotoolbox && !smoke_test(ffmpeg_bin, "h264_videotoolbox").await {
            tracing::warn!("h264_videotoolbox detected but failed smoke test; demoting to CPU");
            self.videotoolbox = false;
        }
        if self.nvenc && !smoke_test(ffmpeg_bin, "h264_nvenc").await {
            tracing::warn!("h264_nvenc detected but failed smoke test; demoting to CPU");
            self.nvenc = false;
        }
        if self.vaapi && !smoke_test(ffmpeg_bin, "h264_vaapi").await {
            tracing::warn!("h264_vaapi detected but failed smoke test; demoting to CPU");
            self.vaapi = false;
        }
        if self.qsv && !smoke_test(ffmpeg_bin, "h264_qsv").await {
            tracing::warn!("h264_qsv detected but failed smoke test; demoting to CPU");
            self.qsv = false;
        }
        self
    }
}

/// Run a throwaway encode to confirm `encoder` actually initializes on this
/// host: encode one 64x64 black frame and discard the output via
/// `ffmpeg -hide_banner -f lavfi -i color=c=black:s=64x64:d=0.1 -c:v <enc> -f null -`.
/// Returns `false` if ffmpeg is missing or the encoder fails to open its device.
///
/// The VAAPI and QSV families are special-cased to mirror the REAL session
/// invocation (see [`crate::args::ffmpeg_args`]): a bare `-c:v h264_qsv`/
/// `h264_vaapi` can auto-init a device and succeed even where the production
/// `hwupload` path fails — which would let [`AvailableEncoders::resolve`] hand
/// back a HW family only for every real transcode to die on a device/upload
/// error (a per-session crash-loop → 503). So for those families we open the
/// device and upload the synthetic frames exactly as production does (VAAPI also
/// pins `-low_power 1`), making a passing smoke test genuinely imply a working
/// encode.
async fn smoke_test(ffmpeg_bin: &str, encoder: &str) -> bool {
    let mut args: Vec<&str> = vec!["-hide_banner", "-loglevel", "error"];
    match encoder {
        "h264_qsv" => args.extend(["-init_hw_device", "qsv=hw", "-filter_hw_device", "hw"]),
        "h264_vaapi" => args.extend(["-vaapi_device", crate::args::VAAPI_RENDER_NODE]),
        _ => {}
    }
    args.extend(["-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.1"]);
    match encoder {
        "h264_qsv" => args.extend(["-vf", "format=nv12,hwupload=extra_hw_frames=64"]),
        "h264_vaapi" => args.extend(["-vf", "format=nv12,hwupload"]),
        _ => {}
    }
    args.extend(["-c:v", encoder]);
    if encoder == "h264_vaapi" {
        args.extend(["-low_power", "1"]);
    }
    args.extend(["-f", "null", "-"]);
    let result = tokio::process::Command::new(ffmpeg_bin)
        .args(&args)
        .output()
        .await;
    matches!(result, Ok(out) if out.status.success())
}

/// Probe whether the FULL-hardware VAAPI pipeline (decode → VPP → encode entirely
/// on the iGPU) is usable on this host.
///
/// `tonemap_vaapi` cannot be exercised synthetically — it reads the input's HDR
/// mastering-display metadata and errors on a generated SDR source ("No mastering
/// display data from input") — so we validate the representative VPP+encode chain
/// instead: upload an NV12 surface, run it through `scale_vaapi`, and encode with
/// `h264_vaapi -low_power 1`, exactly as a non-HDR full-HW session does. A working
/// VAAPI VPP scale on Intel iHD implies a working `tonemap_vaapi` (same VPP
/// engine, shipped in the same ffmpeg build), so HDR sessions ride this flag too.
/// Returns `false` on any failure so the session manager keeps the proven
/// software-decode path (and `false` is also returned on a GPU-less host where
/// the `-vaapi_device` open fails).
pub async fn vaapi_full_hw_supported(ffmpeg_bin: &str) -> bool {
    let args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-vaapi_device",
        crate::args::VAAPI_RENDER_NODE,
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=128x128:d=0.2",
        "-vf",
        "format=nv12,hwupload,scale_vaapi=w=64:h=64:format=nv12",
        "-c:v",
        "h264_vaapi",
        "-low_power",
        "1",
        "-f",
        "null",
        "-",
    ];
    let result = tokio::process::Command::new(ffmpeg_bin)
        .args(args)
        .output()
        .await;
    matches!(result, Ok(out) if out.status.success())
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

    #[tokio::test]
    async fn validate_demotes_hw_when_smoke_test_fails() {
        // Point the smoke test at a binary that always exits non-zero (`false`),
        // standing in for an ffmpeg that lists h264_nvenc but cannot open the
        // (absent) GPU. validate() must clear every HW flag so resolve() falls
        // back to CPU — the GPU-less-NAS crash-loop the fix prevents.
        let detected = AvailableEncoders {
            libx264: true,
            videotoolbox: true,
            nvenc: true,
            vaapi: true,
            qsv: true,
        };
        let validated = detected.validate("false").await;
        assert!(!validated.nvenc);
        assert!(!validated.vaapi);
        assert!(!validated.qsv);
        assert!(!validated.videotoolbox);
        // libx264 is CPU and never smoke-tested, so it survives.
        assert!(validated.libx264);
        assert_eq!(validated.resolve(HwEncoder::Nvenc), (HwEncoder::Cpu, true));
    }

    #[tokio::test]
    async fn validate_leaves_undetected_families_off() {
        // validate() only ever clears flags, never sets them: a family that was
        // not detected stays off regardless of the smoke test.
        let detected = AvailableEncoders {
            libx264: true,
            ..Default::default()
        };
        // `true` exits 0, so any smoke test it ran would "pass" — proving we
        // never probe an undetected family.
        let validated = detected.validate("true").await;
        assert!(!validated.nvenc);
        assert!(!validated.videotoolbox);
        assert!(validated.libx264);
    }
}
