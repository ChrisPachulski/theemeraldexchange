# Flag Report: §19 Missing Ratifications (§3.4 revocation surface, §3.6 multi-kid verifier)

> Source agent: r19-missing-ratifications
> Date: 2026-05-25

## What was checked

Whether the existing §19 Ratifications block covers the load-bearing normative claims in §3.4 (device-token revocation surface) and §3.6 (`jose` multi-kid symmetric verifier pattern). Both sections specify implementation behavior that must be ratified before the verifier and admin-surface code lands, but no §19 entries exist for them.

## Verdict

**FAIL.** Two normative subsections (§3.4 and §3.6) carry implementation requirements that must be ratified by the user before code lands. Both are missing from §19. Additionally, three nearby §3.x items were noticed during the read that may also warrant ratification.

## Findings

### §3.4 revocation surface — not ratified

§3.4 specifies multiple load-bearing implementation choices that lock implementation downstream:
- Two `server.db` tables: `device_tokens` and `device_token_revocations`
- 5-step verifier check order with discrete 401 error codes per failure mode (`token_revoked`, `token_expired`, `server_mismatch`)
- In-process `Set<string>` revocation cache (explicit replacement of any bloom-filter language)
- Synchronous post-write rebuild of the cache after every revocation
- Operator "Devices" admin surface endpoints (`POST /api/admin/devices/:jti/revoke`, `PATCH /api/admin/devices/:jti`, `DELETE /api/devices`) and self-revoke (`DELETE /api/devices/self`)
- Mandatory `reconcileDeviceToken(jti, sub)` as a separate function from `reconcileSession` (`reconcileSession` cannot be reused for Plex cascade revocation)

### §3.6 `jose` multi-kid verifier — not ratified

§3.6 specifies that `jwtDecrypt` cannot accept multiple symmetric keys for rotation (unlike `jwtVerify` with a JWK Set), so:
- Verifier MUST use `decodeProtectedHeader(token).kid` to extract the key ID *before* decryption
- `kid` resolved from a `Map<string, Uint8Array>`
- An absent or unknown `kid` MUST hard-reject; key iteration is forbidden (would enable enumeration attacks)
- `device-token-kid-rotation.json` test vector must be authored in the §13.1 vector set
- A new D-row must be added to §16 deltas for the device-token verifier

### Three additional items noticed during the read

Listed for the user's consideration, max three per scope of this flag report:

1. **§3.1 boot-time secret-distinctness guard** — `server/env.ts` must verify at startup that `DEVICE_TOKEN_SECRET`, `SESSION_SECRET`, and `STREAM_TOKEN_SECRET` are all pairwise distinct, emitting a fatal log and refusing to start on collision. New required startup behavior with specific error message template; no §19 entry exists.
2. **§3.3 HKDF derivation co-deploy constraint** — Converting session-cookie key derivation from plain SHA-256 to HKDF must land in the same release as the `DEVICE_TOKEN_SECRET` rotation. Old tokens under raw-SHA-256 key are incompatible with the new HKDF-derived key. Co-deploy constraint is easy to get wrong; no §19 ratification or §16 D-row exists.
3. **§3.4 external-write operator caveat** — External writes to `device_token_revocations` (operator `sqlite3` shell, incident recovery) take effect only after a server restart because the in-process cache is not externally signaled. Documented operator-safety property that should be ratified alongside §3.4 (and noted in the operator-guide D-row).

## Required fixes

Insert two new ratification entries in §19 between the existing §3.2 entry and the existing §3.5 entry, since §3.4 and §3.6 fall between those sub-sections numerically.

## Drop-in text

Paste the following two entries verbatim into §19. Insertion point: after the existing `§3.2: ratify the revised device-token claim shape ...` entry, before the existing `§3.5: ratify 180-day TTL ...` entry.

```
- [ ] §3.4 revocation surface ratified: two `server.db` tables (`device_tokens` + `device_token_revocations`); 5-step verifier check order with error codes `token_revoked` / `token_expired` / `server_mismatch`; in-process `Set<string>` cache (no bloom filter) rebuilt synchronously after every revocation write; `reconcileDeviceToken(jti, sub)` implemented as a separate function from `reconcileSession` (required for Plex cascade); operator admin surface endpoints (`POST /api/admin/devices/:jti/revoke`, `PATCH /api/admin/devices/:jti`, `DELETE /api/devices`) and self-revoke (`DELETE /api/devices/self`) all specified.
- [ ] §3.6 `jose` multi-kid symmetric verifier pattern ratified: `decodeProtectedHeader(token).kid` called before `jwtDecrypt`; `kid` resolved from `Map<string, Uint8Array>`; absent or unknown `kid` hard-rejects (key iteration forbidden); reference implementation lands as a new D-row in §16 deltas; `device-token-kid-rotation.json` test vector added to §13.1 vector set.
```

Final §19 ordering after insertion:

```
- [ ] §3.2: ratify the revised device-token claim shape ...   ← existing
- [ ] §3.4 revocation surface ratified: ...                   ← NEW (insert)
- [ ] §3.6 `jose` multi-kid symmetric verifier ...            ← NEW (insert)
- [ ] §3.5: ratify 180-day TTL ...                            ← existing
- [ ] §3.7: ratify Keychain attribute lock ...                ← existing
```

Optional: also draft §19 entries for §3.1 (boot-time secret distinctness), §3.3 (HKDF co-deploy constraint), and the §3.4 external-write operator caveat, if the user wants the three additional items captured.
