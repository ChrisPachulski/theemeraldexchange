import { readFileSync } from 'fs'
import { test, expect, type Page } from '@playwright/test'
import { REGULAR_USER, installBackgroundMocks, mockMe } from './helpers/mockApi'

// Transcoder parity with the Apple app: audio-language switching on a
// transcoded (hls.js) grant, and seek-preview thumbnails on the scrubber.
// Every /api call is mocked. The HLS media is the committed H.264 fixture,
// which the bundled Chromium can't decode, so the audio test asserts what is
// codec-independent: the grant asks for renditions, hls.js lists them from the
// master, the preferred language is selected and its rendition is fetched.
// The thumbnail test plays the open-codec WebM fixture.

const HLS_DIR = 'tests/fixtures/hls'
const WEBM = readFileSync('tests/fixtures/webm/episode-60s.webm')
// 16x9 JPEG: ffmpeg -f lavfi -i color=c=0x1f5f45:s=16x9 -frames:v 1 -q:v 10 -f mjpeg
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACBQUFxQXGxsbGxsbIB4gISEhICAgICEhISQkJCoqKiQkJCEhJCQoKCoqLi8uKysqKy8vMjIyPDw5OUZGSFZWZ//EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAACBRABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAkAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIgAEF//2Q==',
  'base64',
)
// The transcoder's alt_audio master: English in-band, Spanish as a rendition.
const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:4',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="eng",LANGUAGE="eng",AUTOSELECT=YES,DEFAULT=YES',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="spa",LANGUAGE="spa",AUTOSELECT=YES,DEFAULT=NO,URI="audio_1.m3u8?t=tok"',
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO="aud"',
  'index.m3u8?t=tok',
  '',
].join('\n')
const AUDIO_PLAYLIST =
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:2.0,\naudio_1_00000.ts?t=tok\n#EXT-X-ENDLIST\n'
const IFRAMES = [
  '#EXTM3U',
  '#EXT-X-VERSION:4',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-I-FRAMES-ONLY',
  ...[0, 1, 2, 3, 4, 5].flatMap((i) => ['#EXTINF:10.000000,', `thumb_0000${i}.ts?t=tok`]),
  '#EXT-X-ENDLIST',
  '',
].join('\n')

const SHOW = { id: 5, tmdb_id: 900, tvdb_id: 500, title: 'Test Show', year: 2020, added_at: '2026-01-01T00:00:00Z' }
const EPISODES = [{ id: 101, show_id: 5, season: 1, episode: 1, title: 'Chapter 1', air_date: null, file_id: 201 }]
const SERIES = {
  id: 11,
  title: 'Test Show',
  tvdbId: 500,
  tmdbId: 900,
  year: 2020,
  status: 'ended',
  images: [],
  seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 1, totalEpisodeCount: 1, episodeFileCount: 1 } }],
  statistics: { seasonCount: 1, episodeCount: 1, totalEpisodeCount: 1, episodeFileCount: 1, sizeOnDisk: 0 },
  monitored: true,
  qualityProfileId: 1,
  rootFolderPath: '/tv',
  added: '2026-01-01T00:00:00Z',
}

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

/** Mock the library and the transcode surface. `grant` is the playback grant
 *  body; returns every playback request body and every transcode path hit. */
async function mockLibrary(page: Page, grant: Record<string, unknown>) {
  const grants: Record<string, unknown>[] = []
  const fetched: string[] = []
  await installBackgroundMocks(page)
  await mockMe(page, REGULAR_USER)
  await page.route('**/api/limits', (r) => r.fulfill(json({ maxMovieGb: 10, maxSeasonGb: 25, mediaEnabled: true })))
  await page.route('**/api/sonarr/api/v3/series', (r) => r.fulfill(json([SERIES])))
  await page.route('**/api/media/**', async (route) => {
    const p = new URL(route.request().url()).pathname
    if (p.endsWith('/playback/episode/101')) {
      grants.push(route.request().postDataJSON() as Record<string, unknown>)
      return route.fulfill(json(grant))
    }
    if (p.startsWith('/api/media/stream/')) {
      return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'Accept-Ranges': 'bytes' }, body: WEBM })
    }
    if (p.endsWith('/shows/5/episodes')) return route.fulfill(json({ items: EPISODES }))
    if (p.endsWith('/shows')) return route.fulfill(json({ items: [SHOW], total: 1 }))
    if (p.endsWith('/movies')) return route.fulfill(json({ items: [], total: 0 }))
    if (p.endsWith('/markers')) return route.fulfill(json({ items: [] }))
    if (p.endsWith('/watch')) return route.fulfill(json(route.request().method() === 'GET' ? { items: [] } : { ok: true }))
    return route.fulfill(json({}))
  })
  // The API is cross-origin to the SPA here (as in prod), so hls.js's XHRs and
  // the playlist fetch need CORS, like the real backend sends.
  await page.route('**/api/transcode/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? ''
    fetched.push(name)
    const send = (contentType: string, body: string | Buffer) =>
      route.fulfill({ status: 200, contentType, headers: { 'Access-Control-Allow-Origin': '*' }, body })
    const m3u8 = (body: string) => send('application/vnd.apple.mpegurl', body)
    if (name === 'master.m3u8') return m3u8(MASTER)
    if (name === 'index.m3u8') return m3u8(readFileSync(`${HLS_DIR}/index.m3u8`, 'utf-8').replace(/\.mpegts/g, '.mpegts?t=tok'))
    if (name === 'audio_1.m3u8') return m3u8(AUDIO_PLAYLIST)
    if (name === 'iframe.m3u8') return m3u8(IFRAMES)
    if (name.endsWith('.mpegts')) return send('video/mp2t', readFileSync(`${HLS_DIR}/${name}`))
    // The rendition's audio: the fixture's first segment (hls.js takes its AAC).
    if (name.startsWith('audio_1_')) return send('video/mp2t', readFileSync(`${HLS_DIR}/seg_00000.mpegts`))
    if (name.endsWith('.jpg')) return send('image/jpeg', JPEG)
    return send('video/mp2t', Buffer.alloc(0))
  })
  return { grants, fetched }
}

async function openEpisode(page: Page) {
  await page.goto('/#/tv')
  await page.getByRole('tab', { name: /In library/ }).click()
  await page.getByRole('button', { name: /Test Show/ }).first().click()
  await page.getByRole('button', { name: 'Play S1E1' }).click()
  await expect(page.getByRole('group', { name: 'Playback controls' })).toBeVisible()
}

test('a multi-audio transcode opens on the preferred language and lists every track', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('eex.playback', JSON.stringify({ audioLanguage: 'es' })))
  const { grants, fetched } = await mockLibrary(page, {
    delivery: 'hls',
    url: '/api/transcode/session/s1/master.m3u8?t=tok',
    heartbeatUrl: '/api/transcode/session/s1/heartbeat?t=tok',
    stopUrl: '/api/transcode/session/s1/stop?t=tok',
    sessionId: 's1',
    durationSecs: 5,
  })
  await openEpisode(page)

  // The browser plays through hls.js (MSE), so it asks for renditions.
  expect(grants[0]?.alt_audio).toBe(true)
  const audio = page.getByRole('combobox', { name: 'Audio' })
  await expect(audio).toBeVisible()
  await expect(audio.locator('option')).toHaveText(['English', 'Spanish'])
  await expect(audio).toHaveValue('1')
  // Spanish lives in its own rendition, which hls.js now loads.
  await expect.poll(() => fetched.includes('audio_1.m3u8')).toBe(true)
})

test('hovering the scrubber previews the trick-play frame at that time', async ({ page }) => {
  const { fetched } = await mockLibrary(page, {
    delivery: 'progressive',
    url: '/api/media/stream/episode/101?t=tok',
    durationSecs: 60,
    trickplayUrl: '/api/transcode/session/s2/iframe.m3u8?t=tok',
  })
  await openEpisode(page)
  await expect.poll(() => fetched.includes('iframe.m3u8')).toBe(true)

  const scrubber = page.getByRole('slider', { name: 'Seek' })
  const box = await scrubber.boundingBox()
  if (!box) throw new Error('scrubber not laid out')
  const preview = page.locator('.media-controls__preview')
  // Halfway across a 60 s title is 0:30, the fourth 10 s thumbnail. Re-enter
  // until the playlist (fetched above) has been parsed.
  await expect(async () => {
    await page.mouse.move(box.x + box.width / 2, box.y - 200)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect(preview).toContainText('0:30', { timeout: 500 })
  }).toPass()
  await expect(preview.locator('img')).toHaveAttribute('src', /\/session\/s2\/thumb_00003\.jpg\?t=tok$/)
  await expect.poll(() => preview.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(16)

  await page.mouse.move(box.x + box.width / 2, box.y - 200)
  await expect(preview).toHaveCount(0)
})
