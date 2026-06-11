# Documentation Map

This directory contains both current planning documents and historical review
records. Treat the files below as the current source of truth unless a newer
commit explicitly says otherwise:

- `TODO.md` at the repo root: active execution queue.
- `DEPLOY.md` at the repo root: NAS deploy pipeline, first boot of the full
  9-service stack, and ongoing-deploy rules.
- `docs/ROADMAP-STATUS.md`: current milestone status and critical path.
- `docs/M4-TRANSCODE-VERIFICATION.md`: the M4 transcoder serving proof
  (2026-06-07). Its "not yet played in a real client" caveat is superseded —
  real-browser playback over the public path was proven 2026-06-08
  (`scripts/media-playback-proof.sh`); see `docs/ROADMAP-STATUS.md` M4.
- `docs/MONETIZATION-AND-PUBLISHING.md`: current monetization and pre-paid
  launch constraints.
- `docs/operations/*`: operational runbooks (Cloudflare tunnel, Glitchtip
  setup, EPG, internal-principal rollout, incident records).

Historical audits and design records are intentionally not rewritten every time
the code changes. They preserve what was true at the reviewed commit, so stale
findings inside them do not automatically mean the current tree is still broken:

- `docs/AUDIT-2026-05-28-honesty-and-best-practice.md`
- `docs/PRODUCTION-READINESS-2026-05-30.md`
- `docs/superpowers/specs/*`
- `docs/superpowers/plans/*`

When a historical finding is still relevant, copy or restate it in `TODO.md` or
`docs/ROADMAP-STATUS.md`; do not use an old audit row directly as current status
without re-verifying it against the present tree.
