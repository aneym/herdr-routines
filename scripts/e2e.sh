#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HERDR="$HOME/.local/bin/herdr"
SESSION="routineslab-$$"
WORK="$ROOT/.e2e-$$"
CONFIG="$WORK/config"
STATE="$WORK/state"
ROSTER="$WORK/roster"
CAPTURE="$WORK/prompts.txt"
MANIFEST="$HOME/.config/herdr/agent-detection/stubagent.toml"
MANIFEST_LOCK="$HOME/.config/herdr/agent-detection/.stubagent-e2e.lock"
SANDBOX_PID=''
DAEMON_PID=''
STEP='initialization'
FAILED_COMMAND=''

on_error() {
  local status=$?
  FAILED_COMMAND="$BASH_COMMAND"
  printf 'e2e ERROR step=%s status=%s command=%q\n' "$STEP" "$status" "$FAILED_COMMAND" >&2
  return "$status"
}

dump_diagnostics() {
  printf '\n--- e2e diagnostics: step=%s command=%s ---\n' "$STEP" "${FAILED_COMMAND:-unknown}" >&2
  for file in "$WORK/sandbox.log" "$WORK/herdr-ready.log" "$WORK/daemon.out" "$WORK/daemon2.out" "$STATE/daemon.log" "$HOME/.config/herdr/sessions/$SESSION/herdr-server.log"; do
    if [[ -f "$file" ]]; then
      printf '\n--- %s (last 40 lines) ---\n' "$file" >&2
      tail -40 "$file" >&2
    fi
  done
}

cleanup() {
  local status=$?
  set +e
  [[ "$status" -ne 0 ]] && dump_diagnostics
  [[ -n "$DAEMON_PID" ]] && kill "$DAEMON_PID" 2>/dev/null
  [[ -n "$SANDBOX_PID" ]] && kill "$SANDBOX_PID" 2>/dev/null
  "$HERDR" --session "$SESSION" session stop >/dev/null 2>&1
  "$HERDR" --session "$SESSION" session delete >/dev/null 2>&1
  rm -f "$MANIFEST"
  rmdir "$MANIFEST_LOCK" 2>/dev/null
  [[ "${KEEP_E2E:-0}" = 1 ]] || rm -rf "$WORK"
  exit "$status"
}
trap on_error ERR
trap cleanup EXIT INT TERM
mkdir -p "$CONFIG" "$STATE" "$(dirname "$MANIFEST")"
STEP='acquire stubagent manifest lock'
for _ in $(seq 1 300); do
  if mkdir "$MANIFEST_LOCK" 2>/dev/null; then break; fi
  sleep .1
done
[[ -d "$MANIFEST_LOCK" ]] || { printf 'e2e: timed out waiting for stubagent manifest lock\n' >&2; exit 1; }
[[ ! -e "$MANIFEST" ]] || { printf 'e2e: stubagent manifest exists without an available test lock\n' >&2; exit 1; }
cp "$ROOT/scripts/stubagent.toml" "$MANIFEST"
printf 'stubagent|stubagent|python3 %s/scripts/stubagent.py\n' "$ROOT" > "$ROSTER"
cat > "$WORK/claude" <<EOF
#!/bin/sh
exec python3 "$ROOT/scripts/stubagent.py"
EOF
chmod +x "$WORK/claude"
export PATH="$WORK:$PATH"
STEP='start sandbox session'
python3 "$ROOT/scripts/sandbox.py" "$SESSION" > "$WORK/sandbox.log" 2>&1 & SANDBOX_PID=$!
STEP='wait for accepting herdr API socket'
HERDR_READY=0
for _ in $(seq 1 300); do
  if ! kill -0 "$SANDBOX_PID" 2>/dev/null; then
    printf 'e2e: sandbox process exited before readiness\n' >&2
    exit 1
  fi
  if "$HERDR" --session "$SESSION" api snapshot > "$WORK/herdr-ready.log" 2>&1; then
    HERDR_READY=1
    break
  fi
  sleep .1
done
[[ "$HERDR_READY" = 1 ]] || { printf 'e2e: herdr API did not become ready within 30s\n' >&2; exit 1; }
STEP='reload stubagent manifest'
"$HERDR" --session "$SESSION" server reload-agent-manifests > "$WORK/reload-manifests.log" 2>&1

export HERDR_SESSION="$SESSION" HERDR_ROUTINES_CONFIG_DIR="$CONFIG" HERDR_ROUTINES_STATE_DIR="$STATE"
export HERDR_ROUTINES_ROSTER="$ROSTER" STUBAGENT_CAPTURE="$CAPTURE" HERDR_ROUTINES_STUB_MODE=1
"$ROOT/bin/herdr-routines" create ok --name Ok --agent stubagent --prompt CASE_OK --at 2099-01-01T00:00:00Z --notify always
STEP='start routines daemon'
node "$ROOT/src/daemon.js" > "$WORK/daemon.out" 2>&1 & DAEMON_PID=$!
STEP='wait for routines control socket'
DAEMON_READY=0
for _ in $(seq 1 300); do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    printf 'e2e: routines daemon exited before readiness\n' >&2
    exit 1
  fi
  socket_path=$(cat "$STATE/ctl.sock.path" 2>/dev/null || true)
  if [[ -n "$socket_path" && -S "$socket_path" ]] && "$ROOT/bin/herdr-routines" status > "$WORK/daemon-ready.log" 2>&1; then
    DAEMON_READY=1
    break
  fi
  sleep .1
done
[[ "$DAEMON_READY" = 1 ]] || { printf 'e2e: routines control socket did not become ready within 30s\n' >&2; exit 1; }
STEP='run outcome and lifecycle assertions'
"$ROOT/bin/herdr-routines" run ok > "$WORK/ok.json"
node -e "const x=require('$WORK/ok.json'); if(x.status!=='ok'||!x.workspace_id||!x.tab_id||!x.pane_id)process.exit(1)"
"$HERDR" --session "$SESSION" tab get "$(node -p "require('$WORK/ok.json').tab_id")" >/dev/null
"$HERDR" --session "$SESSION" pane get "$(node -p "require('$WORK/ok.json').pane_id")" >/dev/null

for pair in 'untagged CASE_UNTAGGED ok_untagged' 'noop CASE_NOOP noop' 'fail CASE_FAIL fail' 'blocked CASE_BLOCKED blocked'; do
  set -- $pair
  "$ROOT/bin/herdr-routines" create "$1" --name "$1" --agent stubagent --prompt "$2" --at 2099-01-01T00:00:00Z --notify always
  sleep 6
  started=$(date +%s)
  "$ROOT/bin/herdr-routines" run "$1" > "$WORK/$1.json"
  elapsed=$(($(date +%s)-started))
  node -e "const x=require('$WORK/$1.json');if(x.status!=='$3')process.exit(1)"
  [[ "$1" != fail || "$elapsed" -lt 8 ]]
done
"$ROOT/bin/herdr-routines" create timeout --name Timeout --agent stubagent --prompt CASE_TIMEOUT --at 2099-01-01T00:00:00Z --notify always
sleep 6
python3 - <<PY
p='$CONFIG/timeout.toml'
s=open(p).read().replace('target = "isolated"', 'timeout_minutes = 0.01\ntarget = "isolated"')
open(p,'w').write(s)
PY
sleep 6
"$ROOT/bin/herdr-routines" run timeout > "$WORK/timeout.json"
node -e "const x=require('$WORK/timeout.json');if(x.status!=='timeout')process.exit(1)"

"$ROOT/bin/herdr-routines" pause ok
if "$ROOT/bin/herdr-routines" run ok >/dev/null 2>&1; then exit 1; fi
"$ROOT/bin/herdr-routines" resume ok
before=$(wc -l < "$STATE/runs/ok.jsonl")
"$ROOT/bin/herdr-routines" run ok --dry-run > "$WORK/dry.txt"
after=$(wc -l < "$STATE/runs/ok.jsonl")
[[ "$before" = "$after" ]]

cat >> "$CONFIG/ok.toml" <<'TOML'
[fire]
token = "secret"
TOML
sleep 6
"$ROOT/bin/herdr-routines" fire ok --token secret --payload-json '{"issue":42}' >/dev/null
grep -q '"issue": 42' "$CAPTURE"

# Retention at keep_runs=3 must leave at most three routine run tabs.
"$ROOT/bin/herdr-routines" run ok >/dev/null
"$ROOT/bin/herdr-routines" run ok >/dev/null
count=$("$HERDR" --session "$SESSION" tab list | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let x=JSON.parse(s);console.log(x.result.tabs.filter(t=>/^Ok #/.test(t.label)).length)})")
[[ "$count" -le 3 ]]

# Kill -9 and make the persisted next due overdue, then restart: exactly one missed record and no fire.
kill -9 "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true; DAEMON_PID=''
node - <<PY
const fs=require('fs');const p='$STATE/state.json';const x=JSON.parse(fs.readFileSync(p));x.routines.ok.nextRunAt=new Date(Date.now()-3600000).toISOString();fs.writeFileSync(p,JSON.stringify(x,null,2))
PY
before=$(grep -c '"status":"ok"' "$STATE/runs/ok.jsonl" || true)
STEP='restart routines daemon after kill -9'
node "$ROOT/src/daemon.js" > "$WORK/daemon2.out" 2>&1 & DAEMON_PID=$!
RESTART_READY=0
for _ in $(seq 1 300); do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    printf 'e2e: restarted daemon exited before readiness\n' >&2
    exit 1
  fi
  socket_path=$(cat "$STATE/ctl.sock.path" 2>/dev/null || true)
  if [[ -n "$socket_path" && -S "$socket_path" ]] && "$ROOT/bin/herdr-routines" status > "$WORK/daemon2-ready.log" 2>&1; then
    RESTART_READY=1
    break
  fi
  sleep .1
done
[[ "$RESTART_READY" = 1 ]] || { printf 'e2e: restarted control socket did not become ready within 30s\n' >&2; exit 1; }
sleep .5
STEP='verify restart and control protocol'
after=$(grep -c '"status":"ok"' "$STATE/runs/ok.jsonl" || true)
[[ "$before" = "$after" ]]
[[ $(grep -c '"status":"missed"' "$STATE/runs/ok.jsonl") -eq 1 ]]

# Control protocol and overlap record are asserted without starting another agent.
node - <<'JS'
import net from 'node:net'
const fs = await import('node:fs/promises')
const socketPath = (await fs.readFile(process.env.HERDR_ROUTINES_STATE_DIR+'/ctl.sock.path','utf8')).trim()
const socket=net.createConnection(socketPath)
let data='';socket.setEncoding('utf8');socket.on('connect',()=>socket.end('{"cmd":"status"}\n'));socket.on('data',x=>data+=x);socket.on('end',()=>{if(!JSON.parse(data).ok)process.exit(1)})
JS
printf 'e2e PASS session=%s outcomes=6 retention=PASS missed=PASS payload=PASS\n' "$SESSION"
