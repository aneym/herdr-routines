# herdr-routines

External scheduled-routine daemon and CLI for herdr. Requires Node 26 or newer and herdr protocol 18.

## Install

```sh
npm install
npm link
```

Run directly with `node src/daemon.js`, install the plugin so herdr invokes the `[[startup]]` hook, or supervise it with launchd using `KeepAlive` and the repository's absolute `src/daemon.js` path. The plugin startup hook is fire-and-forget; launchd is recommended when automatic restart matters.

## CLI

Global flags: `--session NAME` selects a herdr session and `--json` selects JSON where supported.

- `list`: state, last result, and next run for every routine.
- `get ID`: definition, runtime state, and last ten runs.
- `create ID --name N --agent A --prompt P|--prompt-file F --cron E|--every D|--at T|--watch D [--tz Z --workspace W --cwd C --target T --notify P --enabled --force]`.
- `edit ID`: open the TOML in `$EDITOR`.
- `enable|disable ID`: edit the persistent enabled flag.
- `pause|resume ID`: control a running daemon; with it down, edit enabled and add a note.
- `run ID`: fire manually. `--dry-run` prints the exact prompt and planned API calls without creating anything.
- `fire ID --token T [--payload-json JSON]`: authenticated external fire.
- `runs ID [-n N]`: print JSONL history.
- `logs ID`: print the last captured output tail.
- `notes ID [--edit]`: print or edit the memory file.
- `delete ID --yes`: delete the definition.
- `status`: daemon PID, session, and active runs.
- `doctor`: check daemon, session, roster, config directory, and invalid routines.

Daemon-required commands return exit code 2 when the control socket is down; other errors return 1.

## Routine TOML

```toml
name = "lunch order"
agent = "claude"
prompt = """A complete, self-contained unattended task."""
enabled = true

[trigger]
kind = "cron" # cron | interval | at | watch | manual
expr = "30 11 * * 1-5"
tz = "America/New_York"
# every = "6h" for interval/watch; minimum 30s
# when = "2026-08-02T09:00:00-04:00" for at

[run]
target = "isolated" # or pane:<target>; session targets are not v1
workspace = "⚡ routines"
cwd = "~"
overlap = "skip"
busy = "skip"
timeout_minutes = 30
keep_runs = 3

[delivery]
notify = "always" # always | failure | never
ok_token = "ROUTINE_OK"
noop_token = "ROUTINE_NOOP"

[failure]
notify_after = 3
renotify_hours = 8
auto_pause_after_days = 7

[fire]
token = "secret"
```

Definitions live in `$HERDR_ROUTINES_CONFIG_DIR` or `~/.config/herdr/routines`. State defaults to `~/.local/state/herdr-routines/<session>`. `_daemon.toml` is reserved; `[http] port = N` enables localhost-only `POST /fire/<id>` with a bearer token.

Prompts must be **safe to re-run**. Make work idempotent, state the duplicate-check strategy, describe what counts as no-op, and tell the agent what durable facts belong in its notes file. Fresh isolated runs do not inherit a transcript.

## Manager pane

The plugin exposes the `manager` pane. After linking or installing the plugin, open it with:

```sh
herdr plugin pane open herdr-routines manager
```

The pane works without the daemon for browsing definitions and file editing, and displays a persistent daemon-down banner. Live controls require the daemon.

| Key | Action |
|---|---|
| `Enter` / `Esc` | Open detail / return |
| `space` | Pause or resume |
| `r` | Run now |
| `l` | Show last output |
| `e` / `m` | Edit definition / notes |
| `n` | Show conversational creation guidance |
| `d`, then `y` | Confirm deletion |
| `/` | Filter routines |
| `R` | Refresh |
| `?` | Help |
| `q` / `ctrl+c` | Quit |

The list polls local daemon state every two seconds, sorts failures first, and degrades to a single-column presentation below 50 columns.

## Spec deltas

The installed protocol-18 binary no longer exposes arbitrary raw requests through `herdr api '<json>'`; it only provides `api snapshot` and `api schema`. The daemon therefore speaks the documented JSON-lines protocol directly over the session API socket. Live probes also showed `agent.start` supports only built-in agent kinds, so the test stub uses the roster command/reporting path rather than registering a new executable kind.

## Test

```sh
npm test && scripts/e2e.sh
```

The end-to-end harness creates and deletes its own named session, temporary config/state directories, and the namespaced stub detection manifest. It never targets the default session.
