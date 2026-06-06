# Third-Party Software Notices and Licenses

The Emerald Exchange's own source code is proprietary; see the [LICENSE](./LICENSE)
file for the terms that govern the first-party code and compiled binaries. This
document records the third-party components that are **distributed with the
server images** and the licenses under which those components are conveyed. The
proprietary licensing in `LICENSE` applies **only to the project's first-party
code** — it does **not** apply to, restrict, or relicense any of the third-party
components listed below, which remain governed by their own upstream licenses.

## FFmpeg and FFprobe (GPL-3.0+)

The distributed server, media-core, and transcoder images each bundle a
statically-linked FFmpeg build copied from the upstream binaries-only image
`mwader/static-ffmpeg:7.1`. These images bring in `ffmpeg` and `ffprobe` via:

```
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /ffprobe /usr/local/bin/
```

That upstream build is compiled with `--enable-gpl` and includes the `libx264`
and `libx265` encoders. Because of those GPL-licensed encoder libraries, the
resulting `ffmpeg` and `ffprobe` binaries are licensed under the **GNU General
Public License, version 3 or later (GPL-3.0+)**. The `GPL-3.0` terms therefore
govern the FFmpeg and FFprobe binaries as distributed in these images.

The project's own software invokes FFmpeg and FFprobe **only as a separate
process** — an arms-length command-line invocation over a child process, with no
linking (neither static nor dynamic) against any FFmpeg, `libx264`, or `libx265`
library. Consequently the GPL obligations attach to the bundled binaries alone
and do **not** extend to the project's first-party source code, which remains
proprietary under `LICENSE`.

## Written Offer for Corresponding Source

The complete **corresponding source** for the bundled FFmpeg, FFprobe,
`libx264`, and `libx265` binaries is publicly available from the upstream
projects:

- static-ffmpeg packaging (pinned tag `7.1`): https://github.com/wader/static-ffmpeg
- FFmpeg project source: https://ffmpeg.org/

In satisfaction of GPL-3.0 section 6, this is a **written offer**: on request,
the project operator will provide the exact **corresponding source** for the
FFmpeg, FFprobe, `libx264`, and `libx265` binaries as actually distributed in
these images. This offer is valid for at least three years and the source will
be provided at no charge beyond the cost of physically performing the
distribution.

```
Source requests: <maintainer contact>
```

## License Texts

The canonical text of the GNU General Public License, version 3 is available at:

- https://www.gnu.org/licenses/gpl-3.0.txt

The full GPL-3.0 license text also accompanies the upstream FFmpeg distribution
(and the `mwader/static-ffmpeg:7.1` image from which these binaries are copied),
so it travels with the corresponding source referenced by the written offer
above.

---

**App Store / iOS note:** This notice covers the **self-hosted server images
only**. GPL-3.0 is incompatible with the Apple Developer Program License
Agreement (DPLA), so this server-side compliance artifact does **not** clear the
path for bundling a GPL FFmpeg inside an iOS application binary. Shipping FFmpeg
in an iOS bundle requires the LGPL rebuild (Path A). See
[`docs/MONETIZATION-AND-PUBLISHING.md`](./docs/MONETIZATION-AND-PUBLISHING.md)
**BLOCKER 1** for the full App Store implications and the distinction between the
self-hosted-server path (Path B, documented here) and the LGPL iOS-bundle path
(Path A).
