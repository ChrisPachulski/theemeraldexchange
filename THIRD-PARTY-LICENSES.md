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
actual Dockerfiles by `server/licensing.test.ts`, so it cannot silently drift.

| Image | Dockerfile | FFmpeg provisioning | Binary license |
| --- | --- | --- | --- |
| backend server | `Dockerfile` | Static build copied from `mwader/static-ffmpeg:7.1` | GPL-3.0-or-later |
| media-core | `crates/media-core/Dockerfile` | Static build copied from `mwader/static-ffmpeg:7.1` | GPL-3.0-or-later |
| transcoder | `crates/transcoder/Dockerfile` | Debian bookworm `ffmpeg` package (dynamically linked, installed via apt) | GPL-2.0-or-later |

### Server and media-core images — static FFmpeg (GPL-3.0-or-later)

The backend server image (root `Dockerfile`) and the media-core image
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

### Transcoder image — Debian's dynamically-linked FFmpeg (GPL-2.0-or-later)

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
library. This is true in all three images, including the transcoder (it spawns
`/usr/bin/ffmpeg` per session). Consequently the GPL obligations attach to the
distributed FFmpeg binaries and libraries alone and do **not** extend to the
project's first-party source code, which remains proprietary under `LICENSE`.

## Written Offer for Corresponding Source

The complete **corresponding source** for the distributed FFmpeg, FFprobe,
`libx264`, and `libx265` binaries is publicly available from the upstream
projects:

- static-ffmpeg packaging (pinned tag `7.1`, server + media-core images):
  https://github.com/wader/static-ffmpeg
- FFmpeg project source: https://ffmpeg.org/
- Debian source packages (transcoder image): `apt-get source ffmpeg` /
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

## Web Application Supply-Chain Note: webworkify-webpack

The web SPA depends on `mpegts.js`, which pulls in **`webworkify-webpack`**
(MIT) — the **single non-registry package** in `package-lock.json`. It resolves
from a git URL rather than the npm registry:

```
git+ssh://git@github.com/xqq/webworkify-webpack.git#24d1e719b4a6cac37a518b2bb10fe124527ef4ef
```

npm does not record an `integrity` hash for git-resolved dependencies, so this
entry lacks the SRI guarantee every registry package has. The risk is bounded:
the lockfile pins the dependency to an exact **commit hash**
(`24d1e719b4a6cac37a518b2bb10fe124527ef4ef`), which git content-addresses, so
the fetched tree cannot be silently substituted without changing the lockfile.
This is tracked here as a known supply-chain deviation; `server/licensing.test.ts`
fails if any non-registry package appears in the lockfile without being
documented in this file.

---

**App Store / iOS note:** This notice covers the **self-hosted server images
only**. GPL (v2 and v3) is incompatible with the Apple Developer Program License
Agreement (DPLA), so this server-side compliance artifact does **not** clear the
path for bundling a GPL FFmpeg inside an iOS application binary. Shipping FFmpeg
in an iOS bundle requires the LGPL rebuild (Path A). See
[`docs/MONETIZATION-AND-PUBLISHING.md`](./docs/MONETIZATION-AND-PUBLISHING.md)
**BLOCKER 1** for the full App Store implications and the distinction between the
self-hosted-server path (Path B, documented here) and the LGPL iOS-bundle path
(Path A).
