// Per-user policy store (parental controls + section scoping). Each
// household member can be given a max content rating and/or a set of
// allowed app sections (live TV, downloads, *arr add/manage). The client
// reads its OWN policy to enforce rating caps and hide sections; the
// server enforces the section gates for real (see `requireSection`) so a
// tampered client can't bypass them.
//
// Storage: JSON file at env.userPoliciesPath, shape
//   { [sub]: Policy }
// where Policy = {
//   maxContentRating: string | null,          // null = unrestricted
//   allowedSections: { live, downloads, arr } | null,  // null = all allowed
//   kid: boolean,
// }
//
// Default-open: an absent sub resolves to a policy that restricts
// nothing, so adding a user never silently locks them out. Writes
// serialize through a single in-flight promise (same pattern as
// userFeedback/rejections) and persist atomically via temp+rename.

import type { MiddlewareHandler } from 'hono'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { env } from '../env.js'
import type { Env } from '../middleware/auth.js'

export type PolicySection = 'live' | 'downloads' | 'arr'

export type AllowedSections = {
  live: boolean
  downloads: boolean
  arr: boolean
}

export type Policy = {
  maxContentRating: string | null
  allowedSections: AllowedSections | null
  kid: boolean
}

type PoliciesFile = Record<string, Policy>

// The full set of content ratings the app understands (US MPAA + US TV).
// A policy's maxContentRating must be one of these or null; the route
// layer rejects anything else with a 400.
export const CONTENT_RATINGS = [
  'G',
  'PG',
  'PG-13',
  'R',
  'NC-17',
  'TV-Y',
  'TV-Y7',
  'TV-G',
  'TV-PG',
  'TV-14',
  'TV-MA',
] as const

export function isContentRating(v: unknown): v is (typeof CONTENT_RATINGS)[number] {
  return typeof v === 'string' && (CONTENT_RATINGS as readonly string[]).includes(v)
}

export function defaultPolicy(): Policy {
  return { maxContentRating: null, allowedSections: null, kid: false }
}

// Coerce a persisted value into a valid Policy, discarding anything
// malformed. Defends against hand-edited files; the route validates
// stricter shapes (unknown-key rejection) before ever calling setPolicy.
function normalizePolicy(raw: unknown): Policy {
  const o = (raw ?? {}) as Partial<Policy>
  const maxContentRating = isContentRating(o.maxContentRating) ? o.maxContentRating : null
  let allowedSections: AllowedSections | null = null
  if (o.allowedSections && typeof o.allowedSections === 'object') {
    const s = o.allowedSections as Partial<AllowedSections>
    allowedSections = {
      live: s.live !== false,
      downloads: s.downloads !== false,
      arr: s.arr !== false,
    }
  }
  return { maxContentRating, allowedSections, kid: o.kid === true }
}

let filePath = env.userPoliciesPath
let cached: PoliciesFile | null = null
let writeQueue: Promise<void> = Promise.resolve()

export function _setUserPoliciesPathForTests(p: string): void {
  filePath = p
  cached = null
}

async function load(): Promise<PoliciesFile> {
  if (cached) return cached
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cached = {}
      return cached
    }
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: PoliciesFile = {}
    for (const [sub, policy] of Object.entries(parsed)) {
      if (typeof sub === 'string' && sub.length > 0) out[sub] = normalizePolicy(policy)
    }
    cached = out
  } catch (parseErr) {
    // Fail closed on a corrupted file rather than wiping every member's
    // policy — the same posture as the other per-user JSON stores.
    throw new Error(
      `[userPolicies] cannot parse ${filePath} (corrupted?): ${(parseErr as Error).message}`,
      { cause: parseErr },
    )
  }
  return cached
}

async function persistSnapshot(file: PoliciesFile): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

// Caller's own policy, default-open when unset.
export async function getPolicy(sub: string): Promise<Policy> {
  const file = await load()
  return file[sub] ? normalizePolicy(file[sub]) : defaultPolicy()
}

// Every stored policy, for the admin listing.
export async function getAllPolicies(): Promise<PoliciesFile> {
  const file = await load()
  const out: PoliciesFile = {}
  for (const [sub, policy] of Object.entries(file)) out[sub] = normalizePolicy(policy)
  return out
}

export function setPolicy(sub: string, policy: Policy): Promise<void> {
  const normalized = normalizePolicy(policy)
  const op = writeQueue.then(async () => {
    const file = await load()
    const snapshot: PoliciesFile = { ...file, [sub]: normalized }
    await persistSnapshot(snapshot)
    cached = snapshot
  })
  writeQueue = op.catch((err) => {
    console.error('[userPolicies] write failed:', err)
  })
  return op
}

// Middleware factory that fails a request with 403 { error: 'section_blocked' }
// when the caller's policy explicitly denies `section`. Admins are NEVER
// blocked. `mutationsOnly` skips safe methods (GET/HEAD/OPTIONS) so it can
// be mounted app-wide on the *arr routers where reads stay open but
// add/manage mutations are gated. MUST run after requireAuth so the
// session is populated.
export function requireSection(
  section: PolicySection,
  opts: { mutationsOnly?: boolean } = {},
): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (opts.mutationsOnly) {
      const m = c.req.method
      if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next()
    }
    const session = c.get('session')
    if (session.role === 'admin') return next()
    const policy = await getPolicy(session.sub)
    if (policy.allowedSections && !policy.allowedSections[section]) {
      return c.json({ error: 'section_blocked' }, 403)
    }
    return next()
  }
}
