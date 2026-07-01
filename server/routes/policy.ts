// Per-user policy routes (parental controls + section scoping).
//
//   GET  /api/policy                — the CALLER's own policy (any member).
//                                     Default-open when unset. The client
//                                     reads this to enforce rating caps and
//                                     hide blocked sections.
//   GET  /api/users/policies        — every stored policy (admin only).
//   PUT  /api/users/:sub/policy     — set one user's policy (admin only).
//
// The admin routes live under /api/users to sit beside the admin user
// listing; both are mounted on that prefix in app.ts (the same dual-mount
// pattern plexLinks/plexAdmin use). Enforcement of the section gates
// happens in the iptv/sab/*arr routers via requireSection — this router
// only manages the policy documents.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { parseLimitedJson } from '../services/parseLimitedJson.js'
import {
  getPolicy,
  getAllPolicies,
  setPolicy,
  isContentRating,
  type Policy,
} from '../services/userPolicies.js'

// A policy document is tiny; bound the body read like settings.ts.
const MAX_BODY_BYTES = 4 * 1024

const ALLOWED_TOP_KEYS = new Set(['maxContentRating', 'allowedSections', 'kid'])
const ALLOWED_SECTION_KEYS = new Set(['live', 'downloads', 'arr'])

// Strict parse: reject unknown keys and wrong types with a 400 so a
// malformed admin write can't persist a policy the enforcement layer
// would misread. Returns the normalized Policy or an error tag.
function parsePolicy(raw: unknown): { ok: true; policy: Policy } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_body' }
  }
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) {
    if (!ALLOWED_TOP_KEYS.has(k)) return { ok: false, error: 'unknown_key' }
  }

  // PUT is a full replace: an omitted key takes its open default. The
  // Swift client omits maxContentRating when unrestricted rather than
  // sending null, so absent MUST mean null — and because this replaces
  // the whole document, that clears any previously-set cap.
  const maxContentRating = 'maxContentRating' in o ? o.maxContentRating : null
  const allowedSections = 'allowedSections' in o ? o.allowedSections : null
  const kid = 'kid' in o ? o.kid : false

  if (maxContentRating !== null && !isContentRating(maxContentRating)) {
    return { ok: false, error: 'invalid_maxContentRating' }
  }
  if (typeof kid !== 'boolean') return { ok: false, error: 'invalid_kid' }

  let sections: Policy['allowedSections'] = null
  if (allowedSections !== null) {
    if (typeof allowedSections !== 'object' || Array.isArray(allowedSections)) {
      return { ok: false, error: 'invalid_allowedSections' }
    }
    const s = allowedSections as Record<string, unknown>
    for (const k of Object.keys(s)) {
      if (!ALLOWED_SECTION_KEYS.has(k)) return { ok: false, error: 'unknown_section_key' }
    }
    if (typeof s.live !== 'boolean' || typeof s.downloads !== 'boolean' || typeof s.arr !== 'boolean') {
      return { ok: false, error: 'invalid_allowedSections' }
    }
    sections = { live: s.live, downloads: s.downloads, arr: s.arr }
  }

  return {
    ok: true,
    policy: { maxContentRating: maxContentRating as string | null, allowedSections: sections, kid },
  }
}

// Caller-facing router: own policy only.
export const policy = new Hono<Env>()
policy.use('*', requireAuth)
policy.get('/', async (c) => {
  const session = c.get('session')
  return c.json(await getPolicy(session.sub))
})

// Admin router, mounted at /api/users.
export const adminPolicy = new Hono<Env>()
adminPolicy.use('*', requireAdmin)

adminPolicy.get('/policies', async (c) => {
  return c.json({ policies: await getAllPolicies() })
})

adminPolicy.put('/:sub/policy', async (c) => {
  const sub = c.req.param('sub')
  if (!sub) return c.json({ error: 'invalid_sub' }, 400)
  const parsed = await parseLimitedJson(c, MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  const result = parsePolicy(parsed.body)
  if (!result.ok) return c.json({ error: result.error }, 400)
  await setPolicy(sub, result.policy)
  return c.json(await getPolicy(sub))
})
