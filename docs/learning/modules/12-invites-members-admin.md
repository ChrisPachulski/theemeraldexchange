
# Teaching Dossier: Invite / Members Allowlist & Admin Surface

---

## 1. WHAT

The Emerald Exchange controls who can use the app through a single "members allowlist" — a database table called `members`. Every user, whether they logged in via Apple ("Sign in with Apple"), Plex, or a local passkey, gets one row in that table, and access is granted only if that row exists and has not been revoked. Administrators grow the allowlist by issuing "invite codes": short random strings they hand to trusted people. When someone signs in for the first time and presents a valid invite code, the system creates their members row and burns one use of the code — all in a single database transaction so two people can't exploit the same single-use code at the exact same moment. The owner (the person who runs the server) is special: their sub is listed in the `ADMIN_SUBS` environment variable and is always allowed, no invite needed, no database row required. Admin routes under `/api/admin/invites` and `/api/admin/members` let an admin list, issue, and revoke invites, and list or revoke members; all of those routes are gated so only sessions with `role === 'admin'` can reach them.

---

## 2. WHY

### Why one allowlist regardless of provider?

Authentication ("authN") answers "who are you?" — Apple and Plex each independently prove the user's identity using their own signature or PIN mechanisms. Authorization ("authZ") answers "are you allowed in here?" — and that question has nothing to do with which company verified your identity. Whether you proved you are Alice via Apple's JWT or via a Plex PIN, the question "is Alice on the list?" is answered the same way: look up Alice's `sub` in the `members` table. Having two separate allowlists (one per provider) would mean the admin has to maintain two lists, and a user who switches login methods would lose access. One table, keyed by namespaced sub (`apple:…`, `plex:…`, `local:…`), collapses both providers onto one decision. `memberStatus()` in `server/services/membership.ts` is the single function both login paths call — neither Apple nor Plex has its own authZ logic.

### Why atomic redemption matters (race explained simply)

Imagine an invite code allows exactly 1 use. Alice and Bob both receive the code (say, the owner shared a screenshot). They both tap "Sign in" at exactly the same millisecond. Without locking, the server could check "has this code been used?" for both at the same time, see `used_count = 0` for both, and admit both — burning only 1 use but creating 2 members. That's the race condition.

The fix: `redeemInvite` opens an **IMMEDIATE transaction** in SQLite — this means it takes the write lock *before* reading, so the second caller is blocked until the first finishes. The final `UPDATE invites SET used_count = used_count + 1 WHERE code_hash = ? AND used_count < max_uses` is a conditional update: if the count is already at the cap, `changes` comes back 0, and the code throws `ExhaustedRace`, rolling the whole transaction back. The loser gets `{ ok: false, reason: 'exhausted' }` and is denied. One code use = at most one new member, guaranteed.

---

## 3. MAP

### Key files

| File | What it does | Key lines |
|------|-------------|-----------|
| `server/migrations/server/0003_members_invites.sql` | Schema: `members` and `invites` tables. All columns, constraints, indexes. | Lines 18–47 |
| `server/services/membership.ts` | The authZ **facade**. `memberStatus()` is the single provider-agnostic verdict. | Lines 46–79 |
| `server/services/members.ts` | CRUD on the `members` table: `isMember`, `addMember`, `revokeMember`, `recordMemberLogin`. | Lines 41–173 |
| `server/services/invites.ts` | Invite lifecycle: `issueInvite`, `redeemInvite`, `listInvites`, `revokeInvite`. | Lines 91–296 |
| `server/routes/adminInvites.ts` | HTTP routes: `GET/POST/DELETE /api/admin/invites` and `GET/DELETE /api/admin/members`. | Lines 33–155 |
| `server/middleware/auth.ts` | `requireAuth` and `requireAdmin` middleware. `requireAdmin` checks `role === 'admin'`. | Lines 65–101 |
| `server/auth.ts` | Login orchestration. `authorizeOrRedeem()` calls `memberStatus` then optionally `redeemInvite`. | Lines 308–320 |

### Invite redemption walkthrough (step by step)

1. **Owner creates invite** — Admin calls `POST /api/admin/invites`. Route calls `issueInvite(session.sub, opts)`. Service generates 16 random bytes → base64url string (the "code"). Stores only `sha256(code)` as `code_hash` in the `invites` table. Returns the plaintext code to the admin **once** in the HTTP response — never again.

2. **Owner shares the code** — Out-of-band (text message, email). The code is a short URL-safe string like `abc123XYZ_...`.

3. **New user signs in** — They open the app, log in via Apple or Plex, and paste the invite code. The SPA sends it with the login request body.

4. **Identity verified first** — `server/auth.ts` validates Apple JWT signature (JWKS) or polls Plex PIN. This proves "who are you" and produces a validated namespaced `sub`.

5. **`authorizeOrRedeem()` is called** — `server/auth.ts` line 314: `memberStatus(sub)` checks if they're already allowed. If not, and an `inviteCode` was provided, `redeemInvite(inviteCode, sub, displayName, authMode)` is called.

6. **Inside `redeemInvite`** (the atomic part):
   - Hash the code: `sha256(code)`.
   - Open IMMEDIATE transaction (write lock acquired).
   - Fetch the invite row by `code_hash` PK.
   - Check: not revoked, not expired, `used_count < max_uses`.
   - Check member row: if already active, return `{ ok: true, created: false }` without burning a use.
   - If new or previously revoked: INSERT or UPDATE the `members` row, then `UPDATE invites SET used_count = used_count + 1 WHERE used_count < max_uses`. If that UPDATE changes 0 rows, throw `ExhaustedRace` → rolls back entire transaction → caller gets `exhausted`.

7. **Session issued** — `{ ok: true }` → the server writes an encrypted session cookie. The user is in.

---

## 4. PREREQUISITES

Before this material makes full sense, a beginner needs:

- **SQL basics**: what a table, row, primary key, index, and transaction are. What `NULL` vs a value means in a column (the `revoked_at IS NULL` pattern is everywhere).
- **HTTP verbs**: GET (read), POST (create), DELETE (remove), and that a 403 vs 401 difference (unauthenticated vs forbidden).
- **Hono basics**: what a router is, what middleware is, and that `.use('*', requireAdmin)` runs before every handler on that router.
- **Environment variables**: what `env.adminSubs` means as "values injected at deploy time, not in code".
- **Hashing**: that SHA-256 turns any input into a fixed-length fingerprint, and that you can't reverse it to get the original string.
- **What a session/cookie is**: the server writes an encrypted blob to the browser; the browser sends it back on every request to prove identity.

---

## 5. GOTCHAS & WAR STORIES

**"Jane is proven but uninvited = bounced."** Jane has a valid Plex account that is a share member on the home server. The Plex authN flow succeeds — Plex confirms her identity. But `memberStatus('plex:54321')` returns `'not_member'` because she has no row in the `members` table and is not in `ADMIN_SUBS`. She is refused with 403 `no_invite`. Proven identity ≠ authorization. She needs either the owner to `addMember` her directly via the admin API, or an invite code to redeem.

**Owner bootstrap sub must be set before first deploy.** The owner's Plex or Apple sub (e.g., `plex:494190801`) goes in `ADMIN_SUBS` in the compose environment. `memberStatus()` checks this list *before* touching the database. If the owner forgot to set it, they cannot log in — their own app bounces them with `not_member`. Recovery: add the sub to `ADMIN_SUBS` and redeploy (no database change needed). The `ADMIN_SUBS` check in `adminMembers.get('/')` also synthesizes a fake member row for the owner if they have no real row yet, so they appear in their own admin panel.

**Revoking a member cascades their playlist tokens.** `adminMembers.delete('/:sub')` doesn't just set `revoked_at` — it also runs `revokePlaylistTokensBySub` against the IPTV database. A revoked member's active IPTV session keys are invalidated immediately. If that cascade fails (DB error), it logs a warning but still returns 200 — the member row revocation is the critical part.

**You cannot revoke an ADMIN_SUBS sub via the API.** `adminMembers.delete('/:sub')` explicitly returns 409 `cannot_revoke_owner` if the sub is in `env.adminSubs`. This prevents an admin from locking out the owner through the UI. Because `ADMIN_SUBS` is authoritative at the env level, even if a members row were somehow revoked, `memberStatus` would still return `'allowed'`.

**Un-bootstrapped fall-through is a one-way door.** On a fresh install with NO `ADMIN_SUBS`, NO `PLEX_SERVER_ID`, NO Apple config, and NO members rows, every verified identity is admitted (the "un-bootstrapped" path in `membership.ts` lines 67–78). The moment ANY gate is configured — even adding a single member — this fall-through stops. This is intentional: the operator can set up the server without immediately locking themselves out. But once they seed any gate, the allowlist is strictly enforced.

**The plaintext code is shown once.** `issueInvite()` returns `{ code: '...', ... }`. The route returns it as JSON in the HTTP response. It is never stored, never logged. If the admin dismisses the SPA dialog without copying it, the code is gone — the only recovery is to revoke the code by prefix and issue a new one.

**`recordMemberLogin` never creates a membership.** It only updates `display_name` for an existing active member. A returning user re-logging-in will NOT trigger `redeemInvite` if they are already in `members` with `revoked_at IS NULL` — `authorizeOrRedeem` short-circuits at `memberStatus(sub) === 'allowed'`, and the code is NOT burned. This idempotency is intentional and tested.

---

## 6. QUIZ BANK

**Q1.** Alice logged in three months ago via Plex and has a members row. Today she logs in again, and her login request includes an invite code (she copy-pasted the URL she used last time). What happens to the invite's `used_count`? Why?

**A1.** `used_count` is NOT incremented. `redeemInvite` checks `SELECT revoked_at FROM members WHERE sub = ?` and finds an active (non-revoked) row. It returns `{ ok: true, created: false }` immediately, before the `used_count < max_uses` guard or the UPDATE. The code is only burned when a new or re-granted membership is actually written.

---

**Q2.** Bob has `role = 'user'` in his members row. He calls `DELETE /api/admin/members/plex:12345`. What HTTP status does he get, and at what layer is the decision made?

**A2.** He gets 401 or 403. `requireAdmin` middleware runs before the handler. `loadReconciledSession` reads Bob's session, sees `role !== 'admin'`, and returns 403 `forbidden / admin_only`. The handler code never runs. The decision is made in `server/middleware/auth.ts` line 96.

---

**Q3.** The owner wants to admit Carol without making her redeem an invite — she's a technical user and the owner wants to skip the code-sharing step. What API call achieves this, and which service function handles it?

**A3.** `POST /api/admin/members` (if that route is wired), which would call `addMember()` in `server/services/members.ts`. `addMember` writes a members row directly, with no invite row required. `invited_by` would be `null` for this bootstrap path. (The owner could also just use `redeemInvite` internally by having Carol present a code, but `addMember` skips that entirely.)

---

**Q4.** Two people both try to redeem the same single-use invite code within 50ms of each other. Walk through exactly what prevents both from becoming members.

**A4.** Both hash the code to the same `code_hash` and call `redeemInvite`. SQLite's IMMEDIATE transaction means only one can hold the write lock at a time. The first caller finds `used_count = 0 < max_uses = 1`, creates the member row, runs `UPDATE invites SET used_count = used_count + 1 WHERE used_count < max_uses` — this succeeds (changes = 1), txn commits. The second caller gets the lock, reads the invite row, finds `used_count = 1 >= max_uses = 1`, and returns `{ ok: false, reason: 'exhausted' }`. (Even if the second caller somehow got past the initial check, the final conditional UPDATE would return changes = 0, throwing `ExhaustedRace` and rolling back the whole transaction.)

---

**Q5.** An invite has `expires_at = '2020-01-01T00:00:00.000Z'` and `revoked_at = NULL`. What `InviteStatus` does `statusOf()` return? If someone tries to redeem it, what `RedeemResult` reason comes back?

**A5.** `statusOf` returns `'expired'` (checked before `exhausted`). `redeemInvite` returns `{ ok: false, reason: 'expired' }` — the check at line 179 compares `invite.expires_at < nowIso` as ISO string comparison, which works correctly for UTC ISO-8601 strings.

---

**Q6.** The owner accidentally has no `ADMIN_SUBS` set, but the server has 50 active members in the database. A brand-new user with no invite tries to log in. What verdict does `memberStatus` return for them, and why?

**A6.** `'not_member'`. `isAuthzBootstrapped()` returns `true` because `SELECT 1 FROM members LIMIT 1` finds a row. So the un-bootstrapped fall-through (`return 'allowed'`) at line 78 is NOT reached. The new user has no members row, so the function returns `'not_member'`. The bootstrapped fall-through is a one-way door: once ANY members row exists, the allowlist is strictly enforced.

---

## 7. CODE-READING EXERCISE

### Guided walk: `redeemInvite` in `server/services/invites.ts`

Open the file at `/Users/cujo253/Documents/theemeraldexchange/server/services/invites.ts`.

**Step 1 — Find the transaction boundary (lines 159–233).**
Look for `const tx = db.raw.transaction((): RedeemResult => {`. This wraps everything inside as an atomic unit. Notice the keyword `IMMEDIATE` is NOT in the TypeScript — SQLite's `db.raw.transaction()` from better-sqlite3 handles the `BEGIN IMMEDIATE` for you. The important thing is that NOTHING inside this lambda is visible to other connections until it commits.

**Step 2 — Find the hash comparison (lines 163–174).**
The code hashes the user-provided plaintext with `hashCode(code)` before the DB lookup. The `WHERE code_hash = ?` uses the hash as the PK lookup — the plaintext never touches the database. The `constantTimeEqualHex` call on line 174 is belt-and-suspenders: it re-confirms the match in constant time to prevent timing attacks if a future code path were to do a non-PK lookup.

**Step 3 — Trace the four rejection reasons (lines 178–195).**
Read each `if` block in order:
- Line 170: no row found → `'invalid'`
- Line 178: `revoked_at !== null` → `'revoked'`
- Line 179: `expires_at < nowIso` → `'expired'`
- Line 193: `used_count >= max_uses` → `'exhausted'` (only reached after confirming the sub is not already a member)

**Step 4 — Spot the idempotency branch (lines 187–189).**
If the member row already exists with `revoked_at === null`, return `{ ok: true, created: false }` without touching `used_count`. A returning member re-logging-in never burns a code use. Ask yourself: why is this check BEFORE the `used_count >= max_uses` check? (Answer: if the person is already a member, we don't care about the code's remaining uses — we just let them in without consuming anything.)

**Step 5 — Find the race guard (lines 219–230).**
The `UPDATE invites SET used_count = used_count + 1 WHERE code_hash = ? AND used_count < max_uses` is the critical line. If `spent.changes === 0`, the concurrent update won the race and this transaction has already inserted a member row. Throwing `ExhaustedRace` causes SQLite to roll back the entire transaction (including the member INSERT). The `try/catch` at lines 235–239 converts that sentinel exception back to `{ ok: false, reason: 'exhausted' }`.

**Question to answer after the walk:** What would happen if someone removed the `throw new ExhaustedRace()` and replaced it with `return { ok: false, reason: 'exhausted' }`? (Hint: think about what has already happened to the `members` table inside this transaction before that line is reached.)
