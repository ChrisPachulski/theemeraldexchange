# Third-Party Software Notices and Licenses

The Emerald Exchange's own source code is proprietary; see the [LICENSE](./LICENSE)
file for the terms that govern the first-party code and compiled binaries. This
document records the third-party components that are **distributed with the
server images** and the licenses under which those components are conveyed. The
proprietary licensing in `LICENSE` applies **only to the project's first-party
code** — it does **not** apply to, restrict, or relicense any of the third-party
components listed below, which remain governed by their own upstream licenses.

## FFmpeg and FFprobe

The distributed images do **not** all provision FFmpeg the same way. The table
below is the authoritative per-image record; it is guard-tested against the
actual Dockerfiles by `tests/contracts/licensing.test.ts`, so it cannot silently drift.

| Image | Dockerfile | FFmpeg provisioning | Binary license |
| --- | --- | --- | --- |
| backend (Rust gateway) | `Dockerfile` | Static build copied from `mwader/static-ffmpeg:7.1` | GPL-3.0-or-later |
| media-core | `crates/media-core/Dockerfile` | Static build copied from `mwader/static-ffmpeg:7.1` | GPL-3.0-or-later |
| transcoder | `crates/transcoder/Dockerfile` | Debian bookworm `ffmpeg` package (dynamically linked, installed via apt) | GPL-2.0-or-later |
| iptv | `crates/iptv/Dockerfile` | Debian bookworm `ffmpeg` package (dynamically linked, installed via apt) | GPL-2.0-or-later |

### Backend and media-core images — static FFmpeg (GPL-3.0-or-later)

The backend image (root `Dockerfile`, the Rust gateway) and the media-core image
(`crates/media-core/Dockerfile`) each bundle a statically-linked FFmpeg build
copied from the upstream binaries-only image `mwader/static-ffmpeg:7.1`, pinned
by digest
`sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4`.
These images bring in `ffmpeg` and `ffprobe` via:

```
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /ffprobe /usr/local/bin/
```

That upstream build is compiled with `--enable-gpl --enable-version3` and
includes the `libx264` and `libx265` encoders. Because of those GPL-licensed
encoder libraries (and the `--enable-version3` upgrade of the GPL-2.0 baseline),
the resulting `ffmpeg` and `ffprobe` binaries are licensed under the **GNU
General Public License, version 3 or later (GPL-3.0-or-later)**. The GPL-3.0
terms therefore govern the FFmpeg and FFprobe binaries as distributed in these
two images.

### Transcoder and iptv images — Debian's dynamically-linked FFmpeg (GPL-2.0-or-later)

The iptv image (`crates/iptv/Dockerfile`) installs the same Debian bookworm
`ffmpeg` package (CPU only: no VAAPI or Vulkan packages), so everything below
about the Debian build, its GPL-2.0-or-later license and its corresponding
source applies to it as well.

The transcoder image (`crates/transcoder/Dockerfile`) switched away from the
static build on 2026-06-08 and does **not** contain `mwader/static-ffmpeg`
binaries. Intel VAAPI hardware encode requires a dynamically-linked FFmpeg that
can `dlopen` the Intel iHD VA driver — something a fully static binary cannot
do — so the image instead installs **Debian bookworm's own packages** from the
official Debian repositories via `apt-get install`:

- `ffmpeg` (Debian source package `ffmpeg`, `7:5.1.x` line) — Debian's stock
  build, **dynamically linked** against Debian's shared FFmpeg libraries
  (`libavcodec`, `libavformat`, …), built with Debian's standard configure
  flags. Debian's default build enables GPL-licensed components and links
  against GPL libraries including `libx264` and `libx265`, so — per the Debian
  package's copyright file — the resulting binaries are licensed
  **GPL-2.0-or-later (GPL v2+)**.
- `intel-media-va-driver` (the Intel iHD VAAPI driver) — **MIT** licensed.
- `libva2` / `libva-drm2` (the VAAPI userspace library) — **MIT** licensed.
- `mesa-vulkan-drivers` / `libvulkan1` — installed unconditionally into the same
  runtime image (`crates/transcoder/Dockerfile:87`) so the shipped ffmpeg's
  `libplacebo` filter (the Dolby Vision path) can run. Their licenses are not
  recorded in this repository; see each package's own
  `/usr/share/doc/<package>/copyright` inside the image.

Because the transcoder image redistributes **unmodified Debian binary
packages**, the corresponding-source obligation is satisfied differently than
for the static build: Debian publishes the complete corresponding source for
every binary package it ships. The exact source for the package versions in any
given image build is retrievable via `apt-get source ffmpeg` (with the matching
`deb-src` entry) and permanently archived at https://snapshot.debian.org/ keyed
by package version. The written offer below covers these binaries as well.

### Process isolation (all images)

The project's own software invokes FFmpeg and FFprobe **only as a separate
process** — an arms-length command-line invocation over a child process, with no
linking (neither static nor dynamic) against any FFmpeg, `libx264`, or `libx265`
library. This is true in every image, including the transcoder (it spawns
`/usr/bin/ffmpeg` per session) and iptv (it spawns `/usr/bin/ffmpeg` per live
remux, feed check and recording). Consequently the GPL obligations attach to the
distributed FFmpeg binaries and libraries alone and do **not** extend to the
project's first-party source code, which remains proprietary under `LICENSE`.

## yt-dlp (backend image)

The backend image also bundles **`yt-dlp`**, a third-party executable used to
resolve a YouTube trailer/extra id to a directly-playable progressive URL. The
gateway's trailer path (`crates/gateway/src/trailer.rs`) runs it as a separate
process (`yt-dlp -g`); there is no linking of any kind against it.

Its license is **not recorded in this repository** and must be taken from the
upstream project's own notices before relying on this section for compliance;
the same applies to the transitive Python packages pip resolves alongside it.

**Supply-chain note.** Unlike the digest-pinned FFmpeg images, `yt-dlp` is
installed **unpinned and unhashed** at image build time
(`Dockerfile:78` — `pip3 install --no-cache-dir --break-system-packages -U
yt-dlp`), so the exact version conveyed in any given image is whatever PyPI
served at build time and is not recorded in this repository. It is upgraded
deliberately (`-U`) because extractor breakage tracks upstream site changes.

## all-MiniLM-L6-v2 (recommender image)

The recommender image bakes in the **sentence-transformers/all-MiniLM-L6-v2**
model files (`config.json`, `tokenizer.json`, `model.safetensors`) at the pinned
Hugging Face revision `c9745ed1d9f207416be6d2e6f8de32d1f16199bf`, each
sha256-checked at build time (`crates/recommender/Dockerfile`). The model card at
that revision declares the **Apache-2.0** license. They are data loaded by
`crates/recommender/src/embed.rs`; no model code is linked.

## libwebp (media-core image)

The media-core binary statically links **libwebp** to encode its resized
artwork as lossy WebP (`crates/media-core/src/artwork.rs`, through the `webp`
and `libwebp-sys` crates). The C sources are the copy vendored by
`libwebp-sys` 0.9.6 (libwebp 1.3.1 per its `configure.ac`, carrying the
CVE-2023-4863 Huffman-table fix), compiled into the binary at build time. Only
the encoder is called; WebP input is decoded by the pure-Rust `image-webp`.
libwebp is licensed under the **BSD-3-Clause** license, whose binary
redistribution condition is met by reproducing its notice here:

```
Copyright (c) 2010, Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

libwebp also ships Google's additional patent grant for the WebM codecs
(`PATENTS` in its source tree). The other Rust crates in the artwork path
(`image`, `fast_image_resize`, `blurhash`, `lofty` and their dependencies) are
permissively licensed (MIT, Apache-2.0, BSD-3-Clause, Zlib or Unlicense),
within the allow list that `deny.toml` enforces on every linked dependency.

## Written Offer for Corresponding Source

The complete **corresponding source** for the distributed FFmpeg, FFprobe,
`libx264`, and `libx265` binaries is publicly available from the upstream
projects:

- static-ffmpeg packaging (pinned tag `7.1`, server + media-core images):
  https://github.com/wader/static-ffmpeg
- FFmpeg project source: https://ffmpeg.org/
- Debian source packages (transcoder and iptv images): `apt-get source ffmpeg` /
  https://snapshot.debian.org/ (permanent, per-version archive of every Debian
  package, including `ffmpeg`, `x264`, `x265`, `intel-media-driver`, and
  `libva`)

In satisfaction of GPL-3.0 section 6 (and GPL-2.0 section 3 for the Debian
build), this is a **written offer**: on request, the project operator will
provide the exact **corresponding source** for the FFmpeg, FFprobe, `libx264`,
and `libx265` binaries as actually distributed in these images. This offer is
valid for at least three years and the source will be provided at no charge
beyond the cost of physically performing the distribution.

```
Source requests: https://github.com/ChrisPachulski/theemeraldexchange/issues
```

## License Texts

The canonical texts of the licenses referenced above are available at:

- GNU General Public License, version 3: https://www.gnu.org/licenses/gpl-3.0.txt
- GNU General Public License, version 2: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt

The full GPL license texts also accompany the upstream distributions: the
`mwader/static-ffmpeg:7.1` image carries the FFmpeg source tree's license files,
and the Debian packages in the transcoder image ship their full license and
copyright statements at `/usr/share/doc/<package>/copyright` inside the image,
so the texts travel with the corresponding source referenced by the written
offer above.

## Web Application Supply-Chain Note

Every package in `package-lock.json` resolves from the npm registry with an
`integrity` hash. `tests/contracts/licensing.test.ts` fails if a non-registry (git URL)
dependency ever appears without being documented in this section; the last such
entry, `webworkify-webpack` via `mpegts.js`, left the tree with mpegts.js 1.8.

---

**App Store / iOS note:** This notice covers the **self-hosted server images
only**. GPL (v2 and v3) is incompatible with the Apple Developer Program License
Agreement (DPLA), so this server-side compliance artifact does **not** clear the
path for bundling a GPL FFmpeg inside an iOS application binary. Shipping FFmpeg
in an iOS bundle requires the LGPL rebuild (Path A). Two distinct paths follow
from that: **Path B**, the self-hosted-server distribution documented in this
file, where the GPL binaries are conveyed with the server images and the source
offer below applies; and **Path A**, an LGPL rebuild of FFmpeg without
`--enable-gpl`, which is the only form that could ship inside an iOS application
bundle. This document covers Path B only.
