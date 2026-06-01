import { describe, it, expect, afterEach, vi } from 'vitest'
import { iptvDb, closeIptvDb } from './iptvDbSingleton.js'

vi.mock('./iptvDb.js', async () => {
  const actual = await vi.importActual<typeof import('./iptvDb.js')>('./iptvDb.js')
  return {
    ...actual,
  }
})

describe('iptvDbSingleton', () => {
  afterEach(() => {
    // Reset the cache before each test.
    closeIptvDb()
  })

  it('returns the same instance on repeated calls (cached)', () => {
    const first = iptvDb()
    const second = iptvDb()
    expect(first).toBe(second)
  })

  it('opens the database on first call', () => {
    const db = iptvDb()
    expect(db).toBeDefined()
    expect(db.raw).toBeDefined()
    expect(db.stmts).toBeDefined()
  })

  it('closes the database and clears the cache when closeIptvDb() is called', () => {
    const first = iptvDb()
    closeIptvDb()
    const second = iptvDb()
    // After close + reopen, they should be different instances.
    expect(first).not.toBe(second)
  })

  it('handles closeIptvDb() when no database has been opened', () => {
    // Should not throw
    expect(() => closeIptvDb()).not.toThrow()
  })

  it('can reopen after closing', () => {
    const first = iptvDb()
    expect(first).toBeDefined()
    closeIptvDb()
    const second = iptvDb()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
  })
})
