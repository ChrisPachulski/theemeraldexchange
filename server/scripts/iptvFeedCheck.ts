// One-off feed check of a live stream, from the backend container:
//
//   npx tsx server/scripts/iptvFeedCheck.ts <streamId>
//
// Captures the stream and each candidate side by side (two provider
// connections), records the verdict like the server's own checks, and prints the
// outcome. This process's connections are invisible to the running server's
// upstream cap, so run it only while nobody is watching or recording.

import { channelIsDeadFeed, spawnAuxUpstream, UPSTREAM_USER_AGENT } from '../services/iptvRemux.js'
import { iptvDb } from '../services/iptvDbSingleton.js'
import { credsFromEnv } from '../services/xtream.js'
import { getFeedCheck } from '../services/iptvFeedChecks.js'
import { checkFeedStandalone, feedCheckIo } from '../services/iptvFeedVerify.js'

const arg = process.argv[2] ?? ''
if (!/^\d+$/.test(arg)) {
  console.error('usage: npx tsx server/scripts/iptvFeedCheck.ts <streamId>')
  process.exit(2)
}
const streamId = Number(arg)
const db = iptvDb().raw
const creds = credsFromEnv()
const upstreamUrlFor = (sid: string): string =>
  `${creds.host}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${sid}.ts`
const io = feedCheckIo(db, upstreamUrlFor, {
  spawnUpstream: spawnAuxUpstream,
  isDead: channelIsDeadFeed,
  userAgent: UPSTREAM_USER_AGENT,
})
const outcome = await checkFeedStandalone(io, streamId)
console.log(JSON.stringify({ streamId, outcome, recorded: getFeedCheck(db, streamId) ?? null }, null, 2))
process.exit(0)
