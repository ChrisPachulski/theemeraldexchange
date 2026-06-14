// Real-Chrome cue-paint proof for the sidecar subtitle. Bundled chromium lacks
// H.264/AAC, so drive the system Chrome (channel:'chrome') against the live prod
// SPA (allowlisted origin) authenticated with an owner cookie. Proves what only
// a real browser can: the cross-origin token-wrapped sidecar .vtt actually
// PAINTS cues over the MSE/hls.js <video> — a forced track auto-shows, and a
// non-forced track paints after the MediaControls CC button toggles it on and
// hides on toggle off.
//
//   EEX_COOKIE='eex.session=...' node scripts/sidecar-subtitle-browser-proof.mjs <mode> [title]
//     mode  = movies | forced | toggle
//     title = movie title to open (default per mode)
import { chromium } from 'playwright'

const COOKIE = process.env.EEX_COOKIE
const MODE = process.argv[2] || 'movies'
const TITLE = process.argv[3] || (MODE === 'toggle' ? 'Pirates of the Caribbean' : 'A Quiet Place')
if (!COOKIE) { console.error('need EEX_COOKIE'); process.exit(2) }
const token = COOKIE.replace(/^eex\.session=/, '')
const log = (...a) => console.log(...a)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await ctx.addCookies([{
  name: 'eex.session', value: token, domain: '.theemeraldexchange.com', path: '/',
  httpOnly: true, secure: true, sameSite: 'None',
}])
const page = await ctx.newPage()
const vttReqs = []
page.on('response', (r) => { if (/subtitles\.vtt/.test(r.url())) vttReqs.push(`${r.status()}`) })

// ── textTracks / activeCues inspection (the actual paint signal) ──────
// Pick the video that actually carries a subtitle <track> (there can be other
// <video> elements on the page); fall back to the last one (the modal player).
async function trackState() {
  return page.evaluate(() => {
    const vids = Array.from(document.querySelectorAll('video'))
    const withSub = vids.find((v) => v.textTracks && Array.from(v.textTracks).some((t) => t.kind === 'subtitles' || t.kind === 'captions'))
    const v = withSub || vids[vids.length - 1]
    if (!v || !v.textTracks) return { tracks: [], videos: vids.length }
    const out = []
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i]
      out.push({
        kind: t.kind, mode: t.mode,
        cues: t.cues ? t.cues.length : null,
        firstCueStart: t.cues && t.cues[0] ? t.cues[0].startTime : null,
        active: t.activeCues ? t.activeCues.length : 0,
        activeText: t.activeCues && t.activeCues[0] ? (t.activeCues[0].text || '').slice(0, 60) : null,
      })
    }
    return { tracks: out, videos: vids.length, currentTime: v.currentTime, paused: v.paused, dur: v.duration }
  })
}

// Seek the subtitle-bearing video to a time where a cue is on screen.
async function seekTo(secs) {
  await page.evaluate((s) => {
    const vids = Array.from(document.querySelectorAll('video'))
    const v = vids.find((x) => x.textTracks && Array.from(x.textTracks).some((t) => t.kind === 'subtitles')) || vids[vids.length - 1]
    if (v) v.currentTime = s
  }, secs)
}

async function openTitleAndPlay(title) {
  await page.goto('https://theemeraldexchange.com/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: 'Movies', exact: true }).first().click()
  await page.waitForTimeout(3000)
  // Search for the title.
  const search = page.locator('input[type=search], input[placeholder*=earch], input[aria-label*=earch]').first()
  if (await search.count()) {
    await search.click(); await search.fill(title); await page.waitForTimeout(2500)
  }
  // Open the first matching card by its title text.
  const card = page.getByText(title, { exact: false }).first()
  await card.scrollIntoViewIfNeeded().catch(() => {})
  await card.click()
  await page.waitForTimeout(2000)
  // Click the direct-play button in the detail modal.
  const playBtn = page.getByRole('button', { name: /Play Direct|Watch episodes/i }).first()
  await playBtn.click()
  await page.waitForTimeout(1500)
  // A previously-watched title shows a resume prompt; take a FRESH session from
  // the top so the sidecar extracts from 0 (and the forced cues line up).
  const startOver = page.getByRole('button', { name: /Start from beginning/i })
  if (await startOver.count()) { log('resume prompt → Start from beginning'); await startOver.first().click() }
  log('clicked play; waiting for the player <video> …')
  // Wait for a video that actually takes a sidecar <track> (the modal player),
  // not the card-preview videos behind the modal.
  await page.waitForFunction(() => {
    const vids = Array.from(document.querySelectorAll('video'))
    return vids.some((v) => v.querySelector('track') || (v.currentSrc && v.currentSrc.startsWith('blob:')))
  }, { timeout: 35000 }).catch(() => log('  (no track-bearing video detected yet; continuing to poll)'))
}

if (MODE === 'movies') {
  await page.goto('https://theemeraldexchange.com/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: 'Movies', exact: true }).first().click()
  await page.waitForTimeout(3500)
  const dom = await page.evaluate(() => {
    const txt = (els) => [...new Set(Array.from(els).map((e) => (e.textContent || '').trim()).filter(Boolean))]
    return {
      inputs: Array.from(document.querySelectorAll('input')).map((i) => ({ ph: i.placeholder, type: i.type, aria: i.getAttribute('aria-label') })),
      buttons: txt(document.querySelectorAll('button')).slice(0, 30),
      titles: txt(document.querySelectorAll('h3,h4,[class*=title],[class*=Title],[class*=name]')).slice(0, 25),
    }
  })
  log('MOVIES DOM:', JSON.stringify(dom, null, 2))
  await page.screenshot({ path: '/tmp/eex-movies.png' })
  log('screenshot: /tmp/eex-movies.png')
  await browser.close(); process.exit(0)
}

// forced / toggle: open + play, then watch the tracks paint.
await openTitleAndPlay(TITLE)
log('video present. polling textTracks for cue paint (up to ~110s for the slow extract + retry)…')

let painted = false, lastSeen = null
for (let i = 0; i < 70; i++) {
  const st = await trackState()
  const sub = (st.tracks || []).find((t) => t.kind === 'subtitles' || t.kind === 'captions')
  if (i % 4 === 0) log(`  i=${i} videos=${st.videos} t=${(st.currentTime ?? 0).toFixed(0)}s ${sub ? `mode=${sub.mode} cues=${sub.cues} active=${sub.active}` : 'no-sub-track'} vtt404/200=${vttReqs.filter(x=>x==='404').length}/${vttReqs.filter(x=>x==='200').length}`)
  if (sub) {
    lastSeen = sub
    if (MODE === 'forced') {
      // The .vtt is published once cues populate; then seek onto the first cue
      // and confirm it actually becomes an ACTIVE (painted) cue.
      if (sub.cues > 0 && sub.firstCueStart != null) {
        await seekTo(sub.firstCueStart + 0.4)
        await page.waitForTimeout(1200)
        const after = (await trackState()).tracks.find((t) => t.kind === 'subtitles' || t.kind === 'captions')
        log(`  seeked to first cue @${sub.firstCueStart.toFixed(1)}s → mode=${after?.mode} active=${after?.active} "${after?.activeText ?? ''}"`)
        if (after && after.active > 0) { painted = true; lastSeen = after; break }
      }
    }
    if (MODE === 'toggle') {
      // A non-forced track ships mode=disabled, and a DISABLED <track> never
      // fetches its cues — so assert the CC button ON every iteration to drive
      // it to 'showing' (which triggers the fetch + retry) until the slow .vtt
      // finally publishes and the cues load.
      const ccOn = page.getByRole('button', { name: 'Turn on subtitles' })
      if (await ccOn.count()) { await ccOn.click(); log('  clicked: Turn on subtitles'); await page.waitForTimeout(800) }
      const cur = (await trackState()).tracks.find((t) => t.kind === 'subtitles' || t.kind === 'captions')
      if (cur && cur.cues > 0) {
        await seekTo((cur.firstCueStart ?? 0) + 0.4)
        await page.waitForTimeout(1200)
        const after = (await trackState()).tracks.find((t) => t.kind === 'subtitles' || t.kind === 'captions')
        log(`  toggled on; mode=${after?.mode} active=${after?.active} "${after?.activeText ?? ''}"`)
        if (after && after.mode === 'showing' && after.active > 0) { painted = true; lastSeen = after; break }
      }
    }
  }
  await page.waitForTimeout(2000)
}

await page.screenshot({ path: `/tmp/eex-${MODE}-cue.png` })
log(`screenshot: /tmp/eex-${MODE}-cue.png`)
log('final track:', JSON.stringify(lastSeen))
log('vtt request statuses:', vttReqs)

if (MODE === 'toggle' && painted) {
  // Toggle OFF and confirm cues hide.
  const ccOff = page.getByRole('button', { name: 'Turn off subtitles' })
  if (await ccOff.count()) {
    await ccOff.click(); await page.waitForTimeout(1200)
    const off = (await trackState()).tracks.find((t) => t.kind === 'subtitles')
    log('after toggle OFF:', JSON.stringify(off))
    if (off && off.mode !== 'showing' && off.active === 0) log('PASS: cues hidden on toggle off')
    else log('WARN: cues did not hide on toggle off')
  }
}

await browser.close()
log(painted ? `\nPASS — ${MODE} cues painted in real Chrome` : `\nFAIL — ${MODE} cues never painted`)
process.exit(painted ? 0 : 1)
