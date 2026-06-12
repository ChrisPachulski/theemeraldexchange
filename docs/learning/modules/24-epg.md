
# EPG (Electronic Programme Guide) — Teaching Dossier

---

## 1. WHAT

An EPG is the TV-guide grid on any set-top box or streaming app — it tells you what is playing right now on channel 47, what comes on next, and what the show is about. The data lives in a standard open format called **XMLTV**: a big XML file that lists every channel with its aliases, then every programme timeslot with a start time, stop time, title, and description. The Xtream IPTV provider this app uses exposes its own XMLTV feed at `/xmltv.php` (roughly 151 MB uncompressed). The app fetches that feed every 6 hours, parses it, and stores the schedules in a local SQLite database (`iptv.db`). The front-end then calls `/epg/grid` to get a time-windowed slice — what is on in the next 4 hours — and renders the horizontal programme grid on the Live tab. When there is no schedule for a channel (the majority of the 50,592-channel catalog) the guide row still shows the channel as tunable; it just has no programme blocks.

---

## 2. WHY

**Why stream instead of loading the whole file?**
The provider feed is ~151 MB uncompressed. Loading that entirely into memory as a JavaScript string or DOM would consume gigabytes (JSON.parse / DOMParser inflate XML 3-5×) and block Node's event loop for tens of seconds, stalling every other request. Instead the app uses a **SAX parser** (`sax` npm package), which is a streaming event-based parser: it reads the file in small chunks and fires callbacks (`opentag`, `text`, `closetag`) as each tag opens and closes. The app never holds more than one programme element in memory at a time, writing each row straight to SQLite via a prepared statement.

**Why gzip?**
Two layers, two directions:

1. **Ingest direction (fetch):** The third-party supplement feed (`epgshare01`, ~196 MB) arrives gzip-compressed. `streamXmltv` auto-detects gzip by reading the first 2 bytes (`0x1F 0x8B` is the gzip magic number), then pipes through Node's `zlib.createGunzip()` before the SAX parser ever sees the bytes. The provider's own `/xmltv.php` is uncompressed so the same code path works for both.

2. **Serve direction (response):** The `/epg/grid` response is ~28 MB of JSON for a full has-EPG window (roughly 14k channels × 7 programmes each). The route gzip-compresses the response inline when the client sends `Accept-Encoding: gzip` and the body exceeds 64 KB — reducing it ~12× to ~2 MB. This is done per-endpoint rather than as global middleware so the video-proxy streaming endpoints (`/stream/*`) are never accidentally wrapped in compression.

**Why are coverage numbers tricky?**
The feed has **6,024** distinct channel ids that carry at least one programme. The provider catalog has **50,592** channels. Only ~806 of those have a `tvg-id` that exactly matches a feed channel id. The name-resolver (see §3) extends this to ~14,309 by matching channel display-name aliases — but the denominator is always the 6,024 feed channels that have EPG, not the 50k catalog. ~36k catalog channels genuinely have no schedule in any source.

---

## 3. MAP

### Key files

| File | Role |
|---|---|
| `server/services/iptvEpg.ts` | Core ingest: `fetchAndStreamEpg` + `streamXmltv` (SAX + regex sniffer) |
| `server/services/iptvEpgResolve.ts` | Name-matching resolver: `buildEpgNameIndex` + `resolveEpgId` |
| `server/services/iptvEpgQuery.ts` | Query layer: `epgGrid`, `epgNow`, `epgChannelWindow` |
| `server/services/iptvEpgExternal.ts` | Third-party supplement ingest (epgshare01, ~196 MB gz) |
| `server/routes/iptv.ts:339` | `GET /epg/grid` HTTP handler (gzip response) |
| `server/services/iptvEpg.test.ts` | Tests including the regression guard on the sniffer wire-up |
| `docs/operations/epg.md` | Operational runbook: coverage numbers, known bugs, probe recipe |

### Ingest → Grid walkthrough

```
Every 6 hours (node-cron in iptvSync.ts):
  ├─ fetchAndStreamEpg()           [iptvEpg.ts:258]
  │    ├─ fetch provider /xmltv.php (streaming, idle+wall timeouts)
  │    ├─ streamXmltv(nodeStream, onProgramme, signal, onChannelDef)
  │    │    ├─ peek 2 bytes → detect gzip, pipe through gunzip if so
  │    │    ├─ SAX parser fires: onProgramme callback → upsert to epg_programs
  │    │    └─ regex sniffer on same stream → fires onChannelDef for each <channel>
  │    └─ onChannelDef collects XmltvChannelDef[] (id + display-name aliases)
  │
  ├─ resolveEpgChannels()          [iptvEpgResolve.ts]
  │    ├─ buildEpgNameIndex(defs, feedWithEpg) → nameToFeedId Map
  │    └─ for each catalog channel: resolveEpgId() → write epg_resolved_id to DB
  │         pass 1: exact tvg-id in feedWithEpg? → use it
  │         pass 2: normalizeChannelName(catalog.name) in nameToFeedId? → use that
  │
  └─ ingestAllExternalEpg()        [iptvEpgExternal.ts] (best-effort supplement, not yet live)

Client requests GET /epg/grid?from=<ISO>&to=<ISO>&hasEpg=1:
  └─ iptv.ts:339 → epgGrid(db, from, to, opts)  [iptvEpgQuery.ts:108]
       ├─ one SQL pass: SELECT all epg_programs overlapping [from,to]
       │    grouped into Map<channel_id, programme[]>
       ├─ one SQL pass: SELECT channels WHERE hasEpgOnly = epg_resolved_id IN (ids)
       └─ map channels → programmes → return JSON (gzip if >64KB + client accepts)
```

**The join column:** channels store their raw `epg_channel_id` (the provider tvg-id) plus, after resolve, `epg_resolved_id` (the feed channel id the name-resolver found). The query layer uses `COALESCE(epg_resolved_id, epg_channel_id)` as the join key so the grid works before the first resync too.

---

## 4. PREREQUISITES

Before reading this code, a student should understand:

1. **What XML is** (eli5): A text format where data is wrapped in opening tags `<programme>` and closing tags `</programme>`. Attributes live on the opening tag: `<programme start="20260101120000 +0000" channel="cnn.us">`. Text content sits between tags: `<title>Morning News</title>`.

2. **DOM vs SAX parsing:** A DOM parser reads the entire file, builds a tree in memory, and then lets you query it. A SAX parser is event-driven: it reads chunks and fires callbacks as it encounters each opening tag, text node, and closing tag — the whole file never lives in RAM at once. DOM is convenient; SAX is the only practical choice for files above ~10 MB.

3. **Node.js streams:** Data in Node can flow as a `Readable` stream — chunks arrive via `'data'` events and you process them incrementally. `pipe()` connects a source stream to a destination (e.g., the SAX parser). Multiple listeners on a stream each see every chunk independently.

4. **Gzip:** A lossless compression algorithm. Files start with the magic bytes `0x1F 0x8B`. Node's `zlib.createGunzip()` is a Transform stream: gzip bytes in, plain bytes out.

5. **SQLite prepared statements:** A parameterized query compiled once, re-run many times with different values. Critical for high-volume inserts (521k programme rows) — each call is a single fast binding, not a fresh SQL parse.

6. **XMLTV time format:** Not ISO 8601. It looks like `20260524103000 +0000` — yyyyMMddHHmmss + UTC offset. The function `xmltvTimeToIso()` (`iptvEpg.ts:38`) converts it.

---

## 5. GOTCHAS & WAR STORIES

### The fragile line that was race-swept twice

`iptvEpg.ts:252`:
```ts
if (sniffEnabled) xmlStream.on('data', onSniffData)
```

This single line is the wire that connects the regex sniffer to the decompressed XML stream. Without it, the `onChannelDef` callback never fires, `channelDefs` stays empty, `resolveEpgChannels` has nothing to index, and name-based matching silently degrades from ~14k resolved channels to ~820 (only the exact tvg-id matches). The guide still appears to work — programmes load for 820 channels — and there is no error logged. You would only notice by checking the resolved-channel count in the DB.

This line was accidentally deleted **twice** during concurrent-session work where two agents shared the same working tree (`m3-media-core`). When the second agent committed its own changes it silently dropped the first agent's line. Coverage fell to ~820, but the symptom was invisible to anyone not watching the DB. A regression test (`iptvEpg.test.ts:24`) now guards it — the test passes `onChannelDef` and asserts the array has 2 entries; with the line deleted the array is empty and the test fails with a clear message.

**Lesson:** silent degradation is harder to catch than a crash. When a feature reduces a count from 14k to 820 with no error, the only guard is an assertion on that count.

### Why SAX can't read the channel definitions

The provider's live feed has unescaped `&` characters inside `<display-name>` tags in the channel section. SAX strict mode chokes on those and silently skips every `<channel>` open-tag event — yet it parses every `<programme>` just fine, because the programme section is well-formed. The verified result on the live 151 MB feed: `tv:1, programme:507973, channel:0`. So the channel aliases that drive name-matching are extracted by a **separate regex sniffer** running on the raw byte stream in parallel with SAX, bypassing the malformed-entity problem entirely.

### The phantom-numbers lesson

During a production investigation, EPG coverage was reported as 18,547 channels resolved, 22,397 programmes in DB, and 957k total rows — none of which matched reality. These numbers came from a probe run against a stale, misidentified database file. The actual prod numbers (verified 2026-05-30): 14,309 resolved channels, 521,630 programme rows, 6,024 distinct EPG channel ids in the feed. The lesson: always confirm which database file and which instance you are querying. On this stack there are two databases (`iptv.db` and `media.db`), a read-only container restriction, and a WAL mode that requires `{ readonly: true }` or `immutable=1` to open safely for probing. Assume numbers are wrong until you have reproduced them from a known-good source.

### The external supplement partial-crash poison

`resolveAgainstExternal` (iptvEpgExternal.ts) first sets `epg_resolved_id` for matched channels, then streams programmes. If the stream crashes after the resolve commit but before storing any programmes, those channels are left "resolved-but-empty." A re-run skips them because they no longer look unresolved. A crashed run in May 2026 left 3,172 channels in this poisoned state — resolved jump 14,293→17,481 with zero new programmes. Fix: only commit `epg_resolved_id` for channels that actually received ≥1 programme row.

---

## 6. QUIZ BANK

**Q1.** The SAX parser fires `channel:0` events on the live provider feed even though there are 6,024 channels. Your colleague says "the channel section must be missing from the feed." Is this right? If not, what is actually happening and how does the code work around it?

**A1.** Wrong. The `<channel>` blocks are present but contain unescaped `&` characters in `<display-name>` tags. SAX strict mode treats those as malformed XML and silently skips the open-tag event for those elements, emitting zero `channel` events even though `<programme>` elements (which are well-formed) parse fine. The workaround is the regex sniffer: `xmlStream.on('data', onSniffData)` attaches a separate listener to the raw decompressed stream and extracts `<channel>` blocks by regex, bypassing SAX's entity validation entirely.

**Q2.** You delete the line `if (sniffEnabled) xmlStream.on('data', onSniffData)` by accident. The app still starts, no errors are logged, and the EPG guide still shows programme data. How would you detect that something is wrong?

**A2.** You would need to check the database: `SELECT COUNT(*) FROM channels WHERE epg_resolved_id IS NOT NULL` or count distinct `channel_id` values in `epg_programs` and compare to the expected ~14k. Alternatively, run the unit test in `iptvEpg.test.ts` — the regression test at line 24 asserts `defs.length === 2` and would fail with `expect(0).toBe(2)`. Silent degradation from 14k to 820 resolved channels produces no runtime error.

**Q3.** The `/epg/grid` response is gzip-compressed inline in the route handler rather than in a global middleware. Why? What would break if you moved the compression to a global `compress()` middleware that wrapped every route?

**A3.** The video-proxy endpoints (`/stream/*`) stream raw video bytes back to the client. Wrapping those in a gzip transform would corrupt the video stream — compressed video data run through gzip again produces garbage. Compression must be opt-in per route, not global. The inline approach lets only the large JSON endpoints opt in while the streaming proxy passes bytes through untouched.

**Q4.** After a sync run you observe `epg_resolved_id` is set on 17,000 channels but `epg_programs` has entries for only 14,000 of them. What likely happened and how do you fix the poisoned rows?

**A4.** The external supplement ingestion (`resolveAgainstExternal`) probably crashed mid-stream — after committing the resolve IDs but before storing the programme rows. The fix is: `UPDATE channels SET epg_resolved_id = NULL WHERE epg_resolved_id IS NOT NULL AND stream_id NOT IN (SELECT DISTINCT channel_id FROM epg_programs)`. Then re-run the sync so those channels are re-matched on the next pass.

**Q5.** `normalizeChannelName("US: ESPN FHD")` and `normalizeChannelName("ESPN")` both return `"espn"`. Why does the name index drop a name that maps to two different feed channel ids, rather than picking the most common one?

**A5.** Precision over recall: if "espn" maps to both `espn.us` and `espn.uk` in the feed, attaching the wrong one silently shows the wrong country's schedule — wrong listings are worse than no listings. The resolver only emits a match when exactly one feed id owns a normalized name. Ambiguous names are dropped from the index; the channel falls back to no EPG rather than wrong EPG.

---

## 7. CODE-READING EXERCISE

**File:** `server/services/iptvEpg.ts`

Open the file and work through these questions in order:

1. **Lines 104–124 (gzip detection):** The function reads bytes manually before handing off to SAX. Why can't it just check the HTTP `Content-Encoding: gzip` response header instead? (Hint: `streamXmltv` also handles the third-party feed that you download from a URL — what format might that arrive in, and does it always set the right header?)

2. **Lines 179–212 (the sniffer):** Trace through `extractChannelDefs()`. The function resets `CHANNEL_RE.lastIndex = 0` at the start of every call. What happens to `lastIndex` after a `RegExp.exec()` loop finishes? Why must it be reset?

3. **Line 197:** `sniffBuf = sniffBuf.slice(lastEnd)` — after extracting complete `<channel>` blocks, the function discards everything before the last matched end position. Then lines 199–201 find the last `<channel` open and keep only from there. Walk through what happens when a `<channel>` tag is split across two consecutive network chunks. Would the sniffer miss it? What does "keeping the carry" mean here?

4. **Lines 214–255 (the promise):** The function wraps SAX in a `new Promise`. Both `parser.on('end', done)` and `xmlStream.on('error', fail)` eventually call `cleanup()`. Why is the `settled` flag necessary? What happens without it if both the parser end-event and an error event fire at nearly the same time?

5. **Line 252:** This is the fragile line. Confirm for yourself: if you comment it out and run `iptvEpg.test.ts`, exactly which test fails and with what assertion message? (You don't have to run it — trace through the code: with the line absent, `onSniffData` is never registered, so `sniffBuf` is never populated, so `extractChannelDefs` never emits anything, so the `defs` array in the test remains empty. What does `expect(defs).toHaveLength(2)` output when `defs` is `[]`?)

---

