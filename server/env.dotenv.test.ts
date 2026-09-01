import { describe, it, expect, vi } from 'vitest'

// Under vitest the developer's real .env.local must never leak into the suite:
// env.test.ts deletes vars and re-imports env.ts per case, and a dotenv load at
// import time silently put them back (suite red on any machine with a
// .env.local, green in CI). dotenv is mocked because the alternative is writing
// to the developer's real dotfiles.
vi.mock('dotenv', () => ({ config: vi.fn() }))

describe('env — dotenv under vitest', () => {
  it('does not read .env.local or .env when running under vitest', async () => {
    const dotenv = await import('dotenv')
    await import('./env.js')
    expect(vi.mocked(dotenv.config)).not.toHaveBeenCalled()
  })
})
