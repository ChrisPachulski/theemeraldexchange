# Autoloop Control Panel

You own this file. The loop re-reads it every iteration. Change a value and the next
iteration obeys it. The loop is **100% Claude, in-session, never `claude -p`** — it spends
your interactive Max 5h/7d window, so the knobs below govern pacing and the never-over-bill
guard.

```control
MASTER: ON
CADENCE_SECONDS: 120
FIVE_HOUR_CEILING: 85
SEVEN_DAY_CEILING: 90
ALLOWED_HOURS: 00:00-23:59
NOTIFY: osascript
SCOPE: anything
```

- **MASTER** — `ON` arms the loop; `OFF` is an instant kill-switch (the guard returns
  `stop` on the very next iteration). Defaults to `OFF`; nothing runs until you set `ON`.
- **FIVE_HOUR_CEILING / SEVEN_DAY_CEILING** — `%` of each Max window the loop may consume
  before it **idles until the window resets** (never pushes into paid overage). Defaults
  85 / 90. The guard ALSO hard-stops on any rise in paid `extra_usage` regardless.
- **ALLOWED_HOURS** — local-time window the loop may run (e.g. `01:00-08:00` for off-hours).
- **NOTIFY** — comma list: `osascript` (desktop), `telegram`, `email`. Errors always email.
  The email recipient comes from the `AUTOLOOP_NOTIFY_TO` env var (export it in your shell
  profile or the launchd plist); if unset it falls back to `git config user.email`, and if
  that's empty the email channel is skipped. No address is hardcoded in source.
- **SCOPE** — which discovered goals the loop may pull from (`anything` = full backlog).

> **Strongest no-bill setting:** disable "extra usage" billing in your Anthropic account.
> Then hitting the window just *blocks* (zero charge) and the ceilings only govern pacing.

## Kill switches (fastest → slowest)
1. `touch .autoloop/STOP` — the guard stops the loop on its next check (seconds).
2. Set `MASTER: OFF` here — no new iteration runs.
3. `bash scripts/autoloop/stop-loop.sh` — trips STOP, disarms, kills the tmux session.

## Arm + run
1. Set `MASTER: ON` above.
2. `bash scripts/autoloop/start-loop.sh` — launches a Claude session in tmux running `/loop`.
   It self-gates on your window (idles when 5h/7d is tight; you're currently near the 7d ceiling).

<!-- STATUS mirrored to .autoloop/STATUS.json (gitignored). Engine: in-session Claude
     subagents via the Workflow tool (scripts/autoloop/mesh.workflow.mjs). -->
