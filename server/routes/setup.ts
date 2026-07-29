// First-owner claim status (plan 006 Phase 1). Public and auth-free —
// the SPA's walkthrough asks this once to decide whether to show the
// "claim this server" panel instead of the normal sign-in. Deliberately
// a single boolean: claimable is not a secret (an unclaimed server
// already advertises itself by rejecting every login), and the claim
// itself is gated by the setup token + source-address check in the
// passkey registration path.

import { Hono } from 'hono'
import { isClaimable } from '../services/setupState.js'

export const setup = new Hono()

setup.get('/status', (c) => c.json({ claimable: isClaimable() }))
