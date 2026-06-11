// Admin catalog-sync job tracker. Extracted from routes/iptv.ts.
//
// POST /admin/sync returns 202 + a jobId immediately and runs syncOnce
// in the background; the admin panel polls GET /admin/sync/:id. This
// module owns the in-memory job table and its eviction policy. State is
// process-local and intentionally NOT persisted — a restart forgets
// finished jobs, which is fine for a poll-within-minutes admin surface.

import { randomUUID } from 'node:crypto'
import { iptvDb } from './iptvDbSingleton.js'
import { syncOnce, type SyncResult } from './iptvSync.js'

export type SyncJob = {
  id: string
  // 'rejected' = the sync runner refused to start (another sync already in
  // flight — syncOnce returned busy). Distinct from 'done' so the admin
  // poller is never told a skipped run completed.
  state: 'running' | 'done' | 'rejected' | 'error'
  startedAt: string
  finishedAt?: string
  result?: SyncResult
  error?: string
}

const jobs = new Map<string, SyncJob>()
const MAX_REMEMBERED_JOBS = 20

/** Test seam: drop all remembered jobs. */
export function _resetSyncJobsForTests(): void {
  jobs.clear()
}

function rememberJob(job: SyncJob): void {
  jobs.set(job.id, job)
  if (jobs.size > MAX_REMEMBERED_JOBS) {
    // Evict the oldest FINISHED job. A running job's status must survive the
    // cap — evicting it would 404 the admin poller mid-run and orphan the
    // job's eventual result. If every remembered job is somehow still
    // running, nothing is evicted; the map shrinks again as they settle.
    for (const [id, j] of jobs) {
      if (j.state !== 'running') {
        jobs.delete(id)
        break
      }
    }
  }
}

/** Start a background sync and return its job id immediately. */
export function startSyncJob(): string {
  const id = randomUUID()
  const job: SyncJob = { id, state: 'running', startedAt: new Date().toISOString() }
  rememberJob(job)
  void (async () => {
    try {
      const result = await syncOnce(iptvDb())
      // A busy refusal (another sync already running) is NOT a completed
      // sync — surface it as 'rejected' so the poller doesn't read stale
      // "done with no stats" as success.
      job.state = result.busy ? 'rejected' : 'done'
      job.result = result
      job.finishedAt = new Date().toISOString()
    } catch (err) {
      job.state = 'error'
      job.error = err instanceof Error ? err.message : String(err)
      job.finishedAt = new Date().toISOString()
    }
  })()
  return id
}

export function getSyncJob(id: string): SyncJob | undefined {
  return jobs.get(id)
}
