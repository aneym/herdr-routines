# herdr-routines — Phase 0 spec (closed)

Automation ("routines") for herdr as an **external daemon + plugin**, per the approved
design: `~/repos/herdr/docs/automation/index.html` (read it first; §2–§5 are the model).
Codebase facts about herdr's API/CLI: `~/repos/herdr/docs/automation/research/herdr-internals.md`.
Plugin authoring rules (manifest schema, portability, test loop): `~/.claude/rules/herdr-plugins.md`.

Runtime: Node ≥ 26, plain JS (ESM), **no native modules** (node-gyp breaks on Node 26).
Allowed deps: `croner` (pure-JS cron with IANA tz), `smol-toml` (TOML parse/stringify).
Nothing else without a written reason in README. Style: 2-space, single quotes, no
semicolons, camelCase, named exports, early returns, errors explicit (no silent catch).
**No `/Users/<name>` paths anywhere** — resolve via `$HOME`/env. No secrets in repo.

## Repo layout

```
herdr-routines/
  herdr-plugin.toml        # manifest: [[startup]] daemon, [[panes]] manager (milestone B)
  bin/herdr-routines       # CLI (node shebang)
  src/daemon.js            # entry: scheduler + executor + control socket
  src/lib/*.js             # schedule, routines (TOML store), herdr (socket client), runstore, outcome, notify
  src/ui.js                # milestone B manager pane
  tests/                   # node:test unit tests
  scripts/e2e.sh           # sandbox-session end-to-end (see Testing)
  scripts/sandbox-*.sh|py  # sandbox helpers (model on ~/repos/personal/herdr-voice/scripts/sandbox.py)
  README.md
```

## Directories & env

- Routine definitions: `$HERDR_ROUTINES_CONFIG_DIR` default `~/.config/herdr/routines/`
  — one `<id>.toml` per routine. `_daemon.toml` (underscore prefix) is reserved for
  daemon config, never a routine.
- State: `$HERDR_ROUTINES_STATE_DIR` default `~/.local/state/herdr-routines/<session>/`:
  `state.json` (per-routine runtime state), `runs/<id>.jsonl` (history, append-only,
  cap 2000 lines), `notes/<id>.md` (routine memory), `ctl.sock` (control socket),
  `daemon.log`.
- herdr session: `$HERDR_SESSION` default `default`. Socket discovery: use
  `herdr --session <name> api '<json>'` CLI passthrough for requests (one request per
  connection; simplest correct transport). If measured too slow for the manager UI,
  a direct unix-socket client speaking the same JSON protocol to the session's API
  socket path is permitted — but `herdr api` is the reference transport and MUST work.

## Routine TOML schema (v1)

```toml
name   = "lunch order"            # required, display name; id = filename stem
agent  = "claude"                 # required; row label in the spawn roster (see Execution)
prompt = """..."""                # required; the saved task
enabled = true                    # default true

[trigger]                         # exactly one of the kinds
kind = "cron"                     # cron | interval | at | watch | manual
expr = "30 11 * * 1-5"            # cron: 5-field, per-routine tz
tz   = "America/New_York"         # default: host tz
# interval: every = "6h"          # 30s min
# at: when = "2026-08-02T09:00:00-04:00"   # one-shot; auto-disables after firing
# watch: every = "1h"             # = interval + noop-quiet defaults; diffing is
#                                 #   AGENT-side via the memory file (see preamble)

[run]
target    = "isolated"            # v1: isolated | pane:<agent-or-pane-target>
workspace = "⚡ routines"         # isolated only; created on demand
cwd       = "~"                   # tilde-expanded
overlap   = "skip"                # skip (record status=skipped_overlap) | queue is OUT of v1
timeout_minutes = 30
keep_runs = 3                     # retention: live run tabs kept per routine

[delivery]
notify     = "always"             # always | failure | never
ok_token   = "ROUTINE_OK"         # scanned in the final agent output tail
noop_token = "ROUTINE_NOOP"

[failure]
notify_after   = 3                # consecutive failures before notification (badge state is milestone B)
renotify_hours = 8
auto_pause_after_days = 7         # 100% failure for this long → paused=auto, notify once

[fire]                            # optional; enables external fire for this routine
token = "..."                     # required if [fire] present; constant-time compare
```

Unknown keys → load error for that routine (surface in `list` + daemon.log; never crash
the daemon; other routines keep running). `session:<key>` target: reject with a clear
"not in v1" error.

## Daemon behavior

**Load & watch.** Load all `*.toml` at start; re-scan on fs change (watch + 5s mtime
poll fallback). Bad TOML → routine marked `invalid`, visible in CLI list.

**Scheduling.** Wall-clock via croner with per-routine tz. Persist `next_run_at` in
state.json. On start/wake, any routine whose `next_run_at` is > 5 min past: append a
`{status:"missed"}` run record (ONE per gap, with `missed_count`), then schedule the
next FUTURE fire — never replay. Jitter: ±0–120s deterministic per routine id for
top-of-hour crons. Concurrency cap: max 2 simultaneous runs daemon-wide (excess →
`skipped_overlap`-style record with status `skipped_busy`).

**Fire pipeline (isolated).** Via herdr API, exactly per the design doc §3:
1. Resolve workspace by label from `workspace.list`, else `workspace.create`
   (focus:false). Cache the id; re-resolve if stale.
2. `tab.create` {workspace_id, cwd, focus:false, label:`<name> #<n>`, env:{
   HERDR_ROUTINE_ID, HERDR_ROUTINE_RUN, HERDR_ROUTINE_NOTES}}. Discover the tab's
   root pane id from the response (or `tab.get`) — **verify exact response shapes
   against `herdr api` live in the sandbox; do not guess field names.**
3. Start the agent the way `herdr-agent-spawn` does (proven pattern): look up
   `agent` in the roster `~/.config/herdr/spawn-agents.conf` (`label|kind|command`);
   non-empty command → send it into the pane's interactive shell (`herdr pane run`),
   then poll agent detection until the pane reports that agent kind + interactive
   readiness; empty command → `agent.start` {kind, pane_id}. 60s detection timeout.
4. `agent.prompt` {target: pane, text: PREAMBLE + prompt, wait:{until:["idle","blocked"],
   timeout_ms: timeout_minutes}}. (Prompt-effect phase is ~5s internally; the wait
   timeout governs the run.)
5. Outcome: wait result + `agent.get` status + tail of `agent.read`/`pane.read`:
   - status blocked → `blocked`
   - wait timeout → `timeout` (leave the pane alive — surfacing beats killing)
   - ok_token in tail → `ok` · noop_token → `noop`
   - agent idle, no token → `ok_untagged` (counts as ok; distinct in records)
   - agent/pane died or prompt failed → `fail` with error summary
6. Append run record: `{ts, run_id, routine_id, trigger:"cron|interval|at|watch|manual|fire",
   status, duration_ms, summary(≤200ch last meaningful output line), workspace_id,
   tab_id, pane_id, next_run_at}`.
7. `notification.show` per delivery policy + failure streak rules (§ failure). Titles
   like "routine lunch order: ok (34s)"; sound "done" for ok, "request" for
   fail/blocked. noop → never notify.
8. Retention: after a terminal run, if live run tabs for this routine > keep_runs,
   `tab.close` the oldest (records persist).

**`pane:<target>` runs**: skip steps 1–3; require the target agent `idle` first
(`agent.get`); if busy: per-routine `busy = "skip"|"wait"` (default skip, records
`skipped_busy`). Prompt + outcome identical.

**Preamble** (assembled per run, before the user prompt):
run number, last run {status, ts, summary}, notes-file path with "read it first;
update it before finishing", token protocol instructions (ok/noop/failure summary),
and for `watch` routines: "compare findings against your notes; if nothing meaningful
changed, update notes and end with ROUTINE_NOOP." For `fire` runs with payload:
`Trigger payload:\n<pretty JSON>` block.

**Failure policy.** Consecutive-failure counter per routine (fail/timeout count;
noop/ok reset; skipped/missed don't touch it). Notify at `notify_after`-th consecutive,
re-notify every `renotify_hours` while failing, auto-pause per config (state
`paused:"auto"`, one notification). Manual pause: `paused:"manual"`.

**Control socket.** `ctl.sock`, JSON-lines, one request per connection (herdr's own
convention): `{cmd:"status"|"list"|"run",id|"fire",id,payload,token|"pause",id|"resume",id
|"reload"|"stop"}` → `{ok,...}` or `{ok:false,error}`. `fire` validates the routine's
`[fire].token`. CLI verbs that only edit TOML (create/enable/disable/delete) work with
the daemon down; run/fire/status need it.

**HTTP ingress (minimal).** Only if `_daemon.toml` sets `[http] port = N`:
`node:http` on 127.0.0.1 only. `POST /fire/<id>` with `Authorization: Bearer <token>`
(the routine's fire token) + optional JSON body → same path as ctl fire. 404 otherwise.
Off by default.

**Logging.** daemon.log: single-line timestamped entries for every fire/skip/miss/
error; errors always carry the routine id and the failing API call.

## CLI (`bin/herdr-routines`)

`list` (table: id, name, state incl. invalid/paused/auto-paused, last status+when,
next run) · `get <id>` (full detail + last 10 runs) · `create` (flags: --name --agent
--prompt|--prompt-file --cron|--every|--at|--watch --tz --workspace --cwd --target
--notify --enabled; writes TOML; refuses existing id without --force) · `edit <id>`
($EDITOR) · `enable|disable <id>` · `pause|resume <id>` (via ctl when up, else TOML
enabled flag with a note) · `run <id>` (manual fire; --dry-run assembles + prints the
exact prompt and planned API calls without executing) · `fire <id> --payload-json …
--token …` · `runs <id> [-n 20]` · `logs <id>` (print last run's captured output tail
from its record + pane read if alive) · `notes <id>` (print path; `--edit` opens) ·
`delete <id>` (confirm; --yes) · `doctor` (daemon up? session socket reachable?
roster present? config dir readable? invalid routines?). `--session` / `--json` global
flags. Exit codes: 0 ok, 1 error, 2 daemon-required-but-down.

## Testing (hard requirements)

- **Never touch the live/default herdr session.** All e2e runs in a scratch session
  (`herdr --session routineslab-$$`) on a REAL-SIZED pty (rows/cols 0 → ghostty
  error -2) — reuse the harness pattern from `~/repos/personal/herdr-voice/scripts/sandbox.py`.
- **Stub agent, no tokens burned**: tests use a `stubagent` — a tiny script that
  renders a working indicator, then an idle prompt, echoing canned replies containing
  ROUTINE_OK / ROUTINE_NOOP / nothing / never-idle (per test case), plus a matching
  detection manifest installed into `~/.config/herdr/agent-detection/stubagent.toml`
  for the test's duration (namespaced to `stubagent`; removed in cleanup; document
  the format by reading an existing manifest in ~/repos/herdr/src/detect/manifests/).
  Roster line `stubagent|stubagent|<abs path>` appended to a TEST roster file passed
  via env (do not edit the real spawn-agents.conf).
- Unit (node:test): schedule computation incl. tz + DST edge + jitter determinism ·
  missed-run accounting · TOML validation errors · outcome classification matrix ·
  preamble assembly · failure streak/renotify/auto-pause state machine · ctl protocol.
- e2e (`scripts/e2e.sh`, against sandbox session + stub agent): interval routine fires
  → workspace/tab created, run recorded ok · ok/noop/fail/timeout each produce correct
  status + notification behavior (assert via `herdr api` notification result or log) ·
  overlap skip · pause blocks firing, resume reschedules · `run --dry-run` executes
  nothing · fire with payload → payload text present in the prompt the stub received ·
  retention closes oldest tab at keep_runs+1 · daemon restart past a due time →
  missed recorded, not fired.
- **Eval command (must exit 0): `npm test && scripts/e2e.sh`.**

## Milestones

- **A (this dispatch): daemon + CLI + tests.** Everything above except src/ui.js and
  the [[panes]] manifest entry ([[startup]] entry may land now).
- **B: manager pane** — separate dispatch; do not start it in A.

## Acceptance criteria (milestone A)

1. `npm test && scripts/e2e.sh` green from a clean checkout on this machine.
2. A cron routine created via CLI fires in the sandbox at the scheduled minute
   (e2e may use `--at`/interval to avoid waiting) producing a live pane whose run
   record links workspace/tab/pane ids that verifiably exist via `herdr api`.
3. All 6 outcome statuses reachable in e2e assertions (ok, ok_untagged, noop, fail,
   timeout, blocked — blocked may use a stub that parks in a "waiting for approval"
   detection state).
4. Kill -9 the daemon mid-schedule, restart → no double-fire, no lost state, missed
   accounting correct.
5. README documents: install, daemon supervision options (launchd + [[startup]]),
   every CLI verb, the TOML schema, and a "safe to re-run" prompt-authoring note.
6. No edits outside this repo except: sandbox session state, the namespaced
   stubagent detection manifest (cleaned up), and `$HERDR_ROUTINES_*` dirs.
   `git status` in ~/repos/herdr must be untouched by your work.

---

# Milestone B addendum — manager pane (closed)

`src/ui.js`, run inside a herdr plugin pane. Design source: the doc's §5 mockups
(sidebar-row philosophy applies to the LIST view; the native sidebar section itself is
phase 2, NOT this milestone).

## Surfaces

- `herdr-plugin.toml` gains `[[panes]]` id `manager`, title "Routines",
  placement "split", width/height sensible defaults; command = node src/ui.js.
  (Keep/land the `[[startup]]` daemon entry too.) The opener may pass a floating
  placement override at open time on the fork — do not depend on it.
- Data: routine defs via src/lib (read-only), runtime state + verbs via ctl.sock
  (extend the ctl protocol if needed: e.g. `{cmd:"overview"}` returning routines
  with merged runtime state, `{cmd:"runs",id,n}`). Daemon down → render the list
  from files with a persistent "daemon down — start it (launchd/[[startup]])" banner;
  file-only verbs still work (enable/disable/delete), ctl verbs disabled visibly.

## List view (default)

Per-routine row, 2 lines max, glyphs per the doc: `✓` last ok · `✗` failing ·
`●` running (elapsed) · `◌` paused (incl. auto-paused, labeled) · `!` never ran or
missed-while-down · `▲` in the header digest (count + worst state). Line 2 =
state-dependent time-fact exactly as specced: healthy → next-run countdown · running →
elapsed · failing → streak ("✗×4" or "3d fail") · paused → since-when. Failing rows
sort to top, then running, then by next-run. `/` filters. Invalid-TOML routines render
distinctly with the parse error one-liner.

## Detail view (⏎ on a row)

Describe block (name, plain-language schedule + raw expr, tz, agent, target,
workspace, enabled/paused + reason, next run absolute+relative) · health line
(last status/when/duration, streak, missed count) · the EXACT prompt (scrollable) ·
run history (last 20: glyph, when, status, duration, summary; ⏎ on a run → its
output: if pane alive show location + `f` focuses it via pane.focus, else show the
recorded summary + `logs` tail) · contextual footer (only valid verbs).

## Verbs (single-key, both views where sensible)

`⏎/Esc` drill/back · `space` pause/resume (instant, no confirm) · `r` run now ·
`l` last run output · `e` edit TOML in $EDITOR (in-pane; reload on exit) ·
`m` notes file in $EDITOR · `n` → message: create conversationally via any agent or
`herdr-routines create` (no in-TUI wizard in v1) · `d` delete with y/N confirm ·
`R` refresh · `?` help overlay · `q`/ctrl+c quit. Live refresh: poll overview every
2s while focused (cheap; ctl is local).

## Constraints

Plain ANSI, keyboard-first, no mouse dependency, no `dim` attribute ever (explicit
colors; must be readable on catppuccin mocha AND latte). Degrade below 50 cols
(drop time-fact column last). No new deps.

## Tests + acceptance (milestone B)

1. pty render tests against a FIXTURE state dir (canned routines/state/runs — all five
   glyph states + invalid + auto-paused visible; no herdr required): list, filter,
   detail, help; snapshot-style assertions on visible text.
2. pty interaction e2e against the sandbox daemon: space toggles pause (state.json
   flips + row updates), r fires a stub run and the row goes `●` then `✓`, d deletes
   with confirm, daemon-down banner path.
3. `npm test && scripts/e2e.sh` still green (extend e2e.sh or add e2e-ui.sh invoked
   by it).
4. README gains a Manager section (open via `herdr plugin` pane, verbs table).
5. Same repo hygiene rules as milestone A.
