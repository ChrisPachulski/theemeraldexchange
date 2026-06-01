import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiUrl } from './base'

beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('apiUrl', () => {
  it('returns a same-origin URL when VITE_API_BASE_URL is empty', () => {
    expect(apiUrl('/api/grabs/recent')).toBe('http://localhost/api/grabs/recent')
  })

  it('appends and stringifies number/boolean/string params', () => {
    const result = apiUrl('/api/x', { limit: 20, flag: true, name: 'a' })
    const params = new URL(result).searchParams
    expect(params.get('limit')).toBe('20')
    expect(params.get('flag')).toBe('true')
    expect(params.get('name')).toBe('a')
  })

  it('omits the query string entirely when no params are given', () => {
    expect(apiUrl('/api/x')).not.toContain('?')
  })

  it('uses the absolute VITE_API_BASE_URL and strips its trailing slash', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/')
    const { apiUrl: freshApiUrl } = await import('./base')
    const result = freshApiUrl('/api/grabs/recent')
    expect(result).toBe('https://api.example.com/api/grabs/recent')
    // Sanity: the trailing slash on the base was stripped (no double slash).
    expect(result).not.toContain('.com//')
    vi.resetModules()
  })
})
