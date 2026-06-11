import { describe, it, expect } from 'vitest'
import {
  pickProfile,
  normalizePath,
  gateRootFolderSpace,
  materializeNonAdminAddBody,
  materializeFailurePayload,
} from './arrAdd.js'
import { createReservationLedger } from './arrGrab.js'
import { env } from '../env.js'

describe('pickProfile (single shared copy)', () => {
  it('prefers the exact configured name over everything', () => {
    const profiles = [
      { id: 1, name: 'Any' },
      { id: 2, name: 'HD-1080p' },
      { id: 3, name: 'Choose Me' },
    ]
    expect(pickProfile(profiles, 'choose me')?.id).toBe(3)
  })

  it('falls back 1080p → HD-prefix → not-Any → first', () => {
    expect(
      pickProfile([{ id: 1, name: 'Any' }, { id: 2, name: 'Ultra-1080p' }], 'choose me')?.id,
    ).toBe(2)
    expect(pickProfile([{ id: 1, name: 'Any' }, { id: 2, name: 'HD - 720p' }], 'choose me')?.id).toBe(2)
    expect(pickProfile([{ id: 1, name: 'Any' }, { id: 2, name: 'SD' }], 'choose me')?.id).toBe(2)
    expect(pickProfile([{ id: 9, name: 'Any' }], 'choose me')?.id).toBe(9)
    expect(pickProfile([], 'choose me')).toBeUndefined()
  })
})

describe('normalizePath', () => {
  it('strips trailing separators and lowercases', () => {
    expect(normalizePath('/Data/TV///')).toBe('/data/tv')
    expect(normalizePath('C:\\Media\\Movies\\')).toBe('c:\\media\\movies')
  })
})

describe('gateRootFolderSpace (shared fail-closed gate)', () => {
  const ledger = createReservationLedger()
  const HUGE = env.minFreeBytes + 500 * 1024 ** 3

  it('400 rootFolderPath_required when no path supplied', () => {
    const r = gateRootFolderSpace({ rootFolderPath: undefined, folders: [], ledger })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure).toMatchObject({ status: 400, body: { error: 'rootFolderPath_required' } })
  })

  it('400 unknown_root_folder when the path matches nothing', () => {
    const r = gateRootFolderSpace({
      rootFolderPath: '/data/none',
      folders: [{ path: '/data/tv', freeSpace: HUGE }],
      ledger,
    })
    if (!r.ok) expect(r.failure.body).toMatchObject({ error: 'unknown_root_folder', path: '/data/none' })
    expect(r.ok).toBe(false)
  })

  it('507 free_space_unknown when freeSpace is missing or non-numeric', () => {
    for (const freeSpace of [undefined, 'lots', NaN]) {
      const r = gateRootFolderSpace({
        rootFolderPath: '/data/tv',
        folders: [{ path: '/data/tv', freeSpace }],
        ledger,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.failure).toMatchObject({ status: 507, body: { error: 'free_space_unknown' } })
    }
  })

  it('507 insufficient_disk_space below the reserve, ok above it', () => {
    const below = gateRootFolderSpace({
      rootFolderPath: '/data/tv',
      folders: [{ path: '/data/tv', freeSpace: env.minFreeBytes - 1 }],
      ledger,
    })
    expect(below.ok).toBe(false)
    const above = gateRootFolderSpace({
      rootFolderPath: '/data/tv',
      folders: [{ path: '/data/tv', freeSpace: HUGE }],
      ledger,
    })
    expect(above.ok).toBe(true)
    if (above.ok) expect(above.folder).toEqual({ path: '/data/tv', freeSpace: HUGE })
  })

  it('subtracts in-flight reservations from availability', () => {
    const folder = { path: '/data/tv-gate-reserved', freeSpace: env.minFreeBytes + 10 * 1024 ** 3 }
    expect(ledger.reserve(folder, 9 * 1024 ** 3)).toBe(true)
    // The gate computes availability MINUS the in-flight reservation, so a
    // second concurrent add sees min + 1 GB, not the raw min + 10 GB.
    const r = gateRootFolderSpace({ rootFolderPath: folder.path, folders: [folder], ledger })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.availableBytes).toBe(env.minFreeBytes + 1 * 1024 ** 3)
    ledger.release(folder, 9 * 1024 ** 3)
  })
})

describe('materializeNonAdminAddBody (shared policy materialization)', () => {
  const baseOpts = {
    app: 'radarr' as const,
    allowKeys: ['title', 'tmdbId'] as const,
    fetchProfiles: async () =>
      new Response(JSON.stringify([{ id: 7, name: 'Choose Me' }]), { status: 200 }),
    configuredFolderPath: null,
    applyPolicy: (
      safe: Record<string, unknown>,
      picked: { folderPath: string; profileId: number },
    ) => {
      safe.rootFolderPath = picked.folderPath
      safe.qualityProfileId = picked.profileId
    },
  }

  it('keeps only allowlisted keys and stamps server policy', async () => {
    const result = await materializeNonAdminAddBody({
      ...baseOpts,
      raw: { title: 'Heat', tmdbId: 949, qualityProfileId: 1, rootFolderPath: '/evil' },
      loadFolders: async () => [{ path: '/data/movies' }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.body).toEqual({
        title: 'Heat',
        tmdbId: 949,
        rootFolderPath: '/data/movies',
        qualityProfileId: 7,
      })
    }
  })

  it('rootfolder_unreachable when the folder loader throws', async () => {
    const result = await materializeNonAdminAddBody({
      ...baseOpts,
      raw: {},
      loadFolders: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(result).toMatchObject({ ok: false, reason: 'rootfolder_unreachable' })
  })

  it('default_root_folder_missing carries expected/available paths', async () => {
    const result = await materializeNonAdminAddBody({
      ...baseOpts,
      configuredFolderPath: '/data/configured',
      raw: {},
      loadFolders: async () => [{ path: '/data/other' }],
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'default_root_folder_missing',
      expected_path: '/data/configured',
      available_paths: ['/data/other'],
    })
    if (!result.ok) {
      expect(materializeFailurePayload(result)).toMatchObject({
        error: 'default_root_folder_missing',
        expected_path: '/data/configured',
      })
    }
  })
})
