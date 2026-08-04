import { describe, it, expect } from 'vitest'
import { pickDefaultRootFolder } from './pickDefaultRootFolder'
import { normalizePath } from '../../server/services/arrAdd'

type Folder = { id: number; path: string }

describe('pickDefaultRootFolder', () => {
  it('returns null for an undefined or empty folder list', () => {
    expect(pickDefaultRootFolder(undefined, '/data/media/movies')).toBeNull()
    expect(pickDefaultRootFolder([], '/data/media/movies')).toBeNull()
  })

  it('picks the operator-curated path over the first folder (the reported bug)', () => {
    const folders: Folder[] = [
      { id: 1, path: '/mnt/scratch/downloads' },
      { id: 2, path: '/data/media/movies' },
    ]
    // The naive `folders[0].path` default silently ignored the curated path;
    // the server would then honour the client's submitted rootFolderPath and
    // file the add under the WRONG root.
    expect(pickDefaultRootFolder(folders, '/data/media/movies')).toBe('/data/media/movies')
  })

  it('matches a trailing-slash or case variant, returning the LIVE folder path verbatim', () => {
    const folders: Folder[] = [
      { id: 1, path: '/mnt/scratch/downloads' },
      { id: 2, path: '/data/Media/TV' },
    ]
    // Normalization is match-only: what we submit must be the exact string
    // Sonarr/Radarr reported, or the server's unknown_root_folder check rejects it.
    expect(pickDefaultRootFolder(folders, '/data/media/tv/')).toBe('/data/Media/TV')
    expect(pickDefaultRootFolder(folders, '/DATA/MEDIA/TV')).toBe('/data/Media/TV')
    expect(pickDefaultRootFolder(folders, '/data/media/tv///')).toBe('/data/Media/TV')
    // Backslash separators normalize too (Windows-style upstream roots).
    expect(pickDefaultRootFolder([{ id: 3, path: 'D:\\Media\\TV' }], 'd:\\media\\tv\\')).toBe('D:\\Media\\TV')
  })

  it('falls back to the first folder when the curated path is absent from the live list', () => {
    const folders: Folder[] = [
      { id: 1, path: '/mnt/scratch/downloads' },
      { id: 2, path: '/data/media/movies' },
    ]
    // A stale/typo'd DEFAULT_*_ROOT_FOLDER_PATH must not blank the picker —
    // an add with rootFolderPath:null is rejected 400 rootFolderPath_required.
    expect(pickDefaultRootFolder(folders, '/data/media/gone')).toBe('/mnt/scratch/downloads')
  })

  it('falls back to the first folder when nothing is configured', () => {
    const folders: Folder[] = [{ id: 1, path: '/movies' }, { id: 2, path: '/other' }]
    expect(pickDefaultRootFolder(folders, null)).toBe('/movies')
    expect(pickDefaultRootFolder(folders, undefined)).toBe('/movies')
    // Empty string is "unset", not "match the folder whose path is ''".
    expect(pickDefaultRootFolder(folders, '')).toBe('/movies')
  })

  it('normalizes exactly like the server arrAdd.normalizePath it duplicates', () => {
    // The Add modals ALWAYS submit rootFolderPath, so the server's own
    // configuredFolderPath fallback never runs to correct a client-side
    // mismatch — these two normalizers MUST stay in lockstep.
    const cases = ['/data/media/tv/', '/DATA/MEDIA/TV', '/data/media/tv///', 'D:\\Media\\TV\\', '/x']
    for (const raw of cases) {
      const folders: Folder[] = [{ id: 1, path: '/decoy' }, { id: 2, path: raw }]
      // Any spelling that normalizePath collapses onto the same key must select it.
      const variant = raw.toUpperCase() + '/'
      const expected = normalizePath(variant) === normalizePath(raw) ? raw : '/decoy'
      expect(pickDefaultRootFolder(folders, variant)).toBe(expected)
    }
  })
})
