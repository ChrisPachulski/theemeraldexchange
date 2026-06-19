# ytresolve — native Rust YouTube extractor

A from-scratch Rust reimplementation of the part of [yt-dlp](https://github.com/yt-dlp/yt-dlp)
we need: resolve a YouTube video id to a directly-playable stream, in-process,
with no Python, no subprocess, and (for the common path) no JavaScript engine.

yt-dlp is [public domain (The Unlicense)](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE),
so its extraction logic, client definitions, and regexes are ported here freely —
no GPL contamination (clean against our `deny.toml` GPL gate). This is meant to
grow into a standalone project; today it lives in-tree so the backend can use it.

## Why this exists

tvOS has no WebKit, so the Apple TV app can't embed the YouTube player — a trailer
needs a *playable URL*. We were shelling out to the Python `yt-dlp` binary for
that. This replaces the common path with native Rust and keeps yt-dlp only as a
long-tail fallback.

## How it works (and why it's tractable)

The **iOS Innertube `player` client** returns stream URLs that are already signed
— no signature cipher, no `n`-throttle param, and for public videos no PoToken.
That's the same client yt-dlp itself defaults to, and it's why the core resolver
is ~250 lines instead of a JavaScript engine. We POST the iOS client context to
`youtubei/v1/player`, read `streamingData`, and return, in preference order:

1. `hlsManifestUrl` — AVPlayer plays it as-is (best; present on some videos).
2. a progressive (muxed) mp4 — single file, AVPlayer-native (rare on modern YT).
3. the best adaptive **video** + **audio** direct URLs — the caller muxes/wraps
   them (e.g. a synthesized multi-rendition HLS manifest).

```
eex-ytresolve <11-char-video-id>   # prints one JSON line of Resolved, or exits 1
```

## The rot, and how we fight it

A YouTube extractor decays as Google ships new builds. The volatile bits — the
iOS client version, user-agent, OS version — live in [`clients.json`](./clients.json),
**not** in source, so keeping current is a data edit, not a code change.

`scripts/yt-canary.mjs` (scheduled weekly via `.github/workflows/yt-canary.yml`)
diffs our `clients.json` against yt-dlp's upstream `INNERTUBE_CLIENTS`, opens a
sync PR on drift, and runs the real binary against live YouTube to catch hard
breakage. This is our scaled-down replacement for yt-dlp's maintainer community.

## Roadmap to fuller yt-dlp parity

Phase 1 (**done**): iOS-client extraction, format model, CLI, weekly canary.

Phase 2: delivery — synthesize a multi-rendition HLS manifest from the adaptive
video+audio URLs so AVPlayer plays *every* video (not just the ~1-in-8 that ship
HLS), and wire it behind the backend `/api/tmdb/trailer` route with the yt-dlp
fallback retained.

Phase 3: the **web/cipher path** — for videos the iOS client can't serve
(age-gated, region/login-locked). This needs YouTube's obfuscated player `base.js`
run in a real JS engine (`boa_engine`, pure Rust) to solve the signature cipher
and the `n` throttle function. Even yt-dlp now delegates this to an external JS
runtime (its `jsc` provider subsystem), which validates the engine approach over
hand-porting an interpreter. The function-name extraction regexes get ported from
yt-dlp's `_video.py`/`jsc` and refreshed by the same weekly canary.

Phase 4: PoToken (botguard) provider, for clients/videos that now require it.

Phase 5: generalize the extractor trait beyond YouTube (the yt-dlp "1800 sites"
ambition) — only as real needs appear.
