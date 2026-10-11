import type { YoutubeVideo } from './api/media'

// Pure helpers for the YouTube and Music library tabs (kept out of the .tsx
// files so the node-env unit tests can exercise them without a renderer).

export type YoutubeShelf = { id: string; title: string; videos: YoutubeVideo[] }

/** The YouTube tab's rows, as Apple's YouTubeScreen builds them: "Latest"
 *  first, then one row per channel in the server's newest-upload order.
 *  Empty rows are dropped. `perChannel[i]` holds `channels[i]`'s videos. */
export function youtubeShelves(
  latest: YoutubeVideo[],
  channels: string[],
  perChannel: YoutubeVideo[][],
): YoutubeShelf[] {
  const out: YoutubeShelf[] = []
  if (latest.length > 0) out.push({ id: 'latest', title: 'Latest', videos: latest })
  channels.forEach((name, i) => {
    const videos = perChannel[i] ?? []
    if (videos.length > 0) out.push({ id: `channel:${name}`, title: name, videos })
  })
  return out
}

/** `2026-10-01` -> "Oct 1, 2026". Formatted in UTC: the value is a calendar
 *  date, so a local-midnight parse would show the day before west of UTC. */
export function formatUploadDate(ymd: string | null): string | null {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
  const date = new Date(`${ymd}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** "1 album", "3 albums". */
export function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** Join the known meta pieces with the app's " · " separator. */
export function metaLine(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(' · ')
}
