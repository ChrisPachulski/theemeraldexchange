# DECISION NEEDED — grant-time source precedence (audit finding 10-2)

Status: **deferred to M3 (engineering-sound default applied: no code change in M1.5).**

## What the code does today (M1.5)

`server/services/sourcePrecedence.ts` `buildCandidates()` only ever returns an
IPTV candidate (or none). The media-core slot is a documented placeholder
(`media-core (M3+): not wired, always absent in M1.5`), and `probePlex()` is
used solely to populate `available_alternatives` for the
`source_unavailable` payload — never as an auto-fallback, because we cannot
construct a Plex/media-core play URL for an IPTV `stream_id` in M1.5.

So the grant endpoint's source resolver is **IPTV-only selectable** right now.

## Why this is a DECISION, not a bug

The local-first contract (Resolution A: media-core and Plex ranked **above**
IPTV at the grant endpoint) is a recorded product decision, but its
implementation depends on media-core (M3+) landing the
`media_title_link` / `getRatingKey(tmdb_id)` lookup that turns a title into a
real local `ResolvedSource`. There is nothing to patch in M1.5 — the gap is a
planned future feature, consistent with the recorded memory note
`project_recommender_data_model_contradiction` (Resolution A + local-first
precedence at the grant endpoint, an M3+ deliverable).

## Engineering-sound default applied in this pass

- **No change to `buildCandidates`.** Keep M1.5 IPTV-only-selectable.

## The human decision

If local-first playback must ship **before** M3, that pulls media-core forward
on the roadmap — a sequencing call for the repo owner, not a code fix. When
media-core lands:

1. Implement `media_title_link` / `getRatingKey(tmdb_id)` so media-core and
   Plex become real `ResolvedSource` candidates.
2. Rank them above IPTV per Resolution A in `buildCandidates`.
3. Add a grant step in front of `server/routes/media.ts` streaming so local
   playback is authorized by the precedence result.

Until that decision is made, the resolver stays as-is.
