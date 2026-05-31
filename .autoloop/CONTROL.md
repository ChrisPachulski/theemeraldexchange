# Autoloop Control Panel

You own this file. The governor parses it every tick (~10 min). Change a value
and the next tick obeys it. There are **no billing caps** here — the loop runs on
codex (flat-rate ChatGPT Business) and cannot generate a metered charge; these
knobs are purely *your* overrides.

```control
MASTER: OFF
ALLOWED_HOURS: 00:00-23:59
MAX_TOKENS_PER_WINDOW: 4000000
NOTIFY: osascript
SCOPE: anything
```

- **MASTER** — `ON` arms the loop; `OFF` is an instant kill-switch (the governor
  no-ops on the very next tick). Defaults to `OFF`; nothing runs until you set `ON`.
- **ALLOWED_HOURS** — local-time window the loop may run (e.g. `01:00-08:00` to
  keep it to your off-hours). `00:00-23:59` = always.
- **MAX_TOKENS_PER_WINDOW** — codex token sanity-stop per window (visibility/safety,
  not billing). The loop backs off when a window's cumulative codex tokens exceed this.
- **NOTIFY** — comma list: `osascript` (desktop), `telegram`, `email`.
- **SCOPE** — which discovered goals the loop may pull from (`anything` = full
  discovered backlog).

## Kill switches (fastest → slowest)
1. `touch .autoloop/STOP` — every running node aborts on its next self-check (seconds).
2. Set `MASTER: OFF` here — no new tick starts.
3. `launchctl unload ~/Library/LaunchAgents/com.eex.autoloop.plist` — stop scheduling.

<!-- STATUS is mirrored to .autoloop/STATUS.json (gitignored), not here. -->
