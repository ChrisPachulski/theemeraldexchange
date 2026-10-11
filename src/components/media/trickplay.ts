// Seek-preview thumbnails from the transcode session's trick-play rendition.
// The grant's trickplayUrl is an I-frames-only playlist whose entries are
// single-frame `thumb_NNNNN.ts` segments (AVPlayer decodes those natively); the
// transcoder serves each as `thumb_NNNNN.jpg` for an <img>. Copy-remux and
// direct-play grants have no trickplayUrl, so they show no preview (as on Apple).

/** One thumbnail and the title-time span it previews. */
export type TrickplayThumb = { startSecs: number; endSecs: number; url: string }

/** The playlist's thumbnails in order, each pointed at its JPEG twin (resolved
 *  against the playlist URL; the proxy's per-line `?t=` token rides along). */
export function parseTrickplayPlaylist(text: string, playlistUrl: string): TrickplayThumb[] {
  const thumbs: TrickplayThumb[] = []
  let startSecs = 0
  let duration: number | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice('#EXTINF:'.length))
    } else if (line && !line.startsWith('#') && duration != null && Number.isFinite(duration)) {
      const url = new URL(line.replace(/\.ts(?=\?|$)/, '.jpg'), playlistUrl).toString()
      thumbs.push({ startSecs, endSecs: startSecs + duration, url })
      startSecs += duration
      duration = null
    }
  }
  return thumbs
}

/** The thumbnail covering title time `secs` (the last one past the end). */
export function thumbAt(thumbs: ReadonlyArray<TrickplayThumb>, secs: number): TrickplayThumb | null {
  if (thumbs.length === 0 || secs < 0) return null
  return thumbs.find((t) => secs < t.endSecs) ?? thumbs[thumbs.length - 1]
}
