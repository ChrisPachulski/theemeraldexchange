# Real-codec HLS playback fixture

A 5-second, 240p, **H.264 (baseline) + AAC-LC stereo** VOD HLS rendition
(~190 KB total) used by the `playback-chrome` Playwright project
(`tests/e2e/playback/msePlayback.spec.ts`). It is served by the stub
transcoder (`tests/e2e/helpers/stubUpstreams.ts`) through the REAL
backend `/api/transcode` proxy and decoded by REAL Chrome via MSE —
the regression gate for the grey-box playback bug class (MSE append
failures that no server-side check can see).

The codecs are deliberately the exact pair the production transcoder
emits (h264 + aac, 2 channels): bundled Chromium cannot decode them
(no proprietary codecs), which is why the consuming spec runs on
`channel: 'chrome'` only.

Generated once and committed (do not regenerate on CI; byte-stability
keeps the gate deterministic):

```sh
ffmpeg -y \
  -f lavfi -i "testsrc2=size=426x240:rate=24:duration=5" \
  -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=5" \
  -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p -g 24 -b:v 200k \
  -c:a aac -b:a 64k -ac 2 \
  -f hls -hls_time 2 -hls_list_size 0 -hls_playlist_type vod \
  -hls_segment_filename "tests/fixtures/hls/seg_%05d.mpegts" \
  tests/fixtures/hls/index.m3u8
```

(ffmpeg 8.1, lavfi synthetic sources only — no third-party content.)

Segments use a `.mpegts` extension instead of the conventional `.ts`
so eslint's TypeScript parser never tries to lint MPEG-TS binaries;
hls.js resolves segment URIs from the manifest and is extension-
agnostic.
