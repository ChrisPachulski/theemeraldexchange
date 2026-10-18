/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { pickDefaultRootFolder } from './pickDefaultRootFolder'

type Folder = { id: number; path: string }
type Case = { name: string; configured: string | null; folders: Folder[]; expected_path: string | null }

// tests/vectors/arr-add-defaults.json is shared with the gateway's
// normalize_path / default_folder (crates/gateway/src/arr/shared/tests.rs). The
// Add modals always submit rootFolderPath, so the server's own default never
// corrects a client-side mismatch: both normalizers must agree.
const { root_folders: cases } = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/vectors/arr-add-defaults.json'), 'utf8'),
) as { root_folders: Case[] }

describe('pickDefaultRootFolder', () => {
  it('returns null for an undefined folder list and treats undefined as unset', () => {
    expect(pickDefaultRootFolder(undefined, '/data/media/movies')).toBeNull()
    expect(pickDefaultRootFolder([{ id: 1, path: '/movies' }], undefined)).toBe('/movies')
  })

  it('has vectors to run', () => {
    expect(cases.length).toBeGreaterThan(5)
  })

  it.each(cases)('$name', ({ configured, folders, expected_path }) => {
    expect(pickDefaultRootFolder(folders, configured)).toBe(expected_path)
  })
})
