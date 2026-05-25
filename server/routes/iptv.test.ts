import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { iptv } from './iptv.js'

vi.mock('../middleware/auth.js', async () => {
  return {
    requireAuth: async (c: any, next: any) => {
      c.set('user', { sub: 'plex:test', role: 'admin', displayName: 'Test' })
      await next()
    },
    requireAdmin: async (c: any, next: any) => {
      c.set('user', { sub: 'plex:test', role: 'admin', displayName: 'Test' })
      await next()
    },
  }
})

vi.mock('../services/xtream.js', () => ({
  getAccountInfo: vi.fn(async () => ({
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    maxConnections: 4,
    status: 'Active',
  })),
  credsFromEnv: vi.fn(() => ({ host: 'https://panel', username: 'u', password: 'p' })),
}))

describe('GET /api/iptv/health', () => {
  it('returns account info shape', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const res = await app.request('/api/iptv/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      expiresAt: string | null
      maxConnections: number
      status: string
    }
    expect(body.maxConnections).toBe(4)
    expect(body.status).toBe('Active')
    expect(typeof body.expiresAt).toBe('string')
  })
})
