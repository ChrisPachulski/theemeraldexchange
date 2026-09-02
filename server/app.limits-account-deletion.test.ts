import { describe, it, expect } from 'vitest'

// The Apple app offers "Delete Account" on the server only when /api/limits
// says accountDeletionEnabled; the route is mounted unconditionally, so the
// flag must be a public true for anonymous callers.
describe('/api/limits accountDeletionEnabled', () => {
  it('advertises self-service account deletion to anonymous callers', async () => {
    const { app } = await import('./app.js')
    const r = await app.request('/api/limits')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { accountDeletionEnabled?: unknown }
    expect(body.accountDeletionEnabled).toBe(true)
  })
})
