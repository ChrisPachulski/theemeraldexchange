/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { pickDefaultProfileId } from './pickDefaultProfileId'

type Profile = { id: number; name: string }
type Case = { name: string; preferred: string; profiles: Profile[]; expected_id: number | null }

// tests/vectors/arr-add-defaults.json is shared with the gateway's pick_profile
// (crates/gateway/src/arr/shared/tests.rs). The Add modals always send
// qualityProfileId, so the server's own fallback never corrects a client-side
// mismatch: both sides must agree on every case.
const { profiles: cases } = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/vectors/arr-add-defaults.json'), 'utf8'),
) as { profiles: Case[] }

describe('pickDefaultProfileId', () => {
  it('returns null for an undefined profile list', () => {
    expect(pickDefaultProfileId(undefined, 'choose me')).toBeNull()
  })

  it('has vectors to run', () => {
    expect(cases.length).toBeGreaterThan(5)
  })

  it.each(cases)('$name', ({ preferred, profiles, expected_id }) => {
    expect(pickDefaultProfileId(profiles, preferred)).toBe(expected_id)
  })
})
