# autoloop — autonomous, convergent, self-healing codex mesh

A generic engine that improves this project while you're away. Runs on **codex**
(flat-rate ChatGPT Business — *cannot* generate a metered charge), **never
`claude -p`**. Plan: `~/.claude/plans/how-can-i-set-piped-aurora.md`.

## Status
- **P0 (done):** `codex.mjs` engine wrapper · `guard.mjs` real-time self-monitor ·
  `node-state.mjs` combination-lock node contract.
- **P1 (done):** `control.mjs` + `CONTROL.md` · `governor.mjs` law-enforcing gate ·
  `supervisor.mjs` top node running guarded codex ticks · launchd template + installer.
- **P2–P5 (pending):** orchestrator + team mesh, rotation/handoff at every tier,
  goal-classifier (generic discovery) + researcher + auto-immune, propagation +
  final-synthesis + notifications + convergence (`EEX-GOALS-MET`).

## Arm / disarm / kill
```sh
bash scripts/autoloop/install.sh            # schedule supervisor every 10 min (does nothing yet)
# edit .autoloop/CONTROL.md → MASTER: ON    # ARM
touch .autoloop/STOP                        # fastest kill — all nodes abort next self-check
# edit .autoloop/CONTROL.md → MASTER: OFF   # no new tick starts
bash scripts/autoloop/install.sh uninstall  # stop scheduling entirely
```

## The laws (enforced by governor + every node)
1. Never over-bill — structural (codex flat-rate; loop never touches `claude -p`/metered).
2. Limits discovered live, never static (codex rollout telemetry per call).
3. Judgment → escalate, never ask (`gpt-5.5 --effort xhigh` + web).
4. Self-communicating mesh, not one agent.
5. Every node self-monitors usage in real time (never outsourced; accepted sunk cost).
6. Real stopping point = discovered goal → converge + hand off human-only items.
7. Human active → re-discover resources, trim footprint, notify.
8. Ruthless efficiency + self-healing rotation.

## Files
| file | role |
|---|---|
| `codex.mjs` | codex `task --json` wrapper; threadId→rollout telemetry |
| `guard.mjs` | STOP flag · Claude over-bill tripwire · codex rate-limit · human presence |
| `node-state.mjs` | uniform Node contract: state + handoff + upward rollup + resume |
| `control.mjs` / `.autoloop/CONTROL.md` | user knobs (MASTER, hours, token cap, notify) |
| `governor.mjs` | GO/NO-GO gate; posture (concurrency trim under human/throttle) |
| `supervisor.mjs` | top Node; guarded codex tick; STATUS.json mirror |
| `install.sh` / `*.plist.template` | launchd scheduling (paths kept out of git) |

Live status: `.autoloop/STATUS.json` (gitignored).
