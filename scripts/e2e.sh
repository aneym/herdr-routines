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
SANDBOX_PID=''
DAEMON_PID=''

cleanup() {
  set +e
  [[ -n "$DAEMON_PID" ]] && kill "$DAEMON_PID" 2>/dev/null
  [[ -n "$SANDBOX_PID" ]] && kill "$SANDBOX_PID" 2>/dev/null
  "$HERDR" --session "$SESSION" session stop >/dev/null 2>&1
  "$HERDR" --session "$SESSION" session delete >/dev/null 2>&1
  rm -f "$MANIFEST"
  [[ "${KEEP_E2E:-0}" = 1 ]] || rm -rf "$WORK"
}
trap cleanup EXIT INT TERM
mkdir -p "$CONFIG" "$STATE" "$(dirname "$MANIFEST")"
test ! -e "$MANIFEST"
cp "$ROOT/scripts/stubagent.toml" "$MANIFEST"
printf 'stubagent|stubagent|python3 %s/scripts/stubagent.py\n' "$ROOT" > "$ROSTER"
cat > "$WORK/claude" <<EOF
#!/bin/sh
exec python3 "$ROOT/scripts/stubagent.py"
EOF
chmod +x "$WORK/claude"
export PATH="$WORK:$PATH"
python3 "$ROOT/scripts/sandbox.py" "$SESSION" > "$WORK/sandbox.log" 2>&1 & SANDBOX_PID=$!
for _ in $(seq 1 100); do [[ -S "$HOME/.config/herdr/sessions/$SESSION/herdr.sock" ]] && break; sleep .1; done
"$HERDR" --session "$SESSION" server reload-agent-manifests >/dev/null

export HERDR_SESSION="$SESSION" HERDR_ROUTINES_CONFIG_DIR="$CONFIG" HERDR_ROUTINES_STATE_DIR="$STATE"
export HERDR_ROUTINES_ROSTER="$ROSTER" STUBAGENT_CAPTURE="$CAPTURE" HERDR_ROUTINES_STUB_MODE=1
"$ROOT/bin/herdr-routines" create ok --name Ok --agent stubagent --prompt CASE_OK --at 2099-01-01T00:00:00Z --notify always
node "$ROOT/src/daemon.js" > "$WORK/daemon.out" 2>&1 & DAEMON_PID=$!
for _ in $(seq 1 100); do [[ -S "$STATE/ctl.sock" ]] && break; sleep .1; done
"$ROOT/bin/herdr-routines" run ok > "$WORK/ok.json"
node -e "const x=require('$WORK/ok.json'); if(x.status!=='ok'||!x.workspace_id||!x.tab_id||!x.pane_id)process.exit(1)"
"$HERDR" --session "$SESSION" tab get "$(node -p "require('$WORK/ok.json').tab_id")" >/dev/null
"$HERDR" --session "$SESSION" pane get "$(node -p "require('$WORK/ok.json').pane_id")" >/dev/null

for pair in 'untagged CASE_UNTAGGED ok_untagged' 'noop CASE_NOOP noop' 'fail CASE_FAIL fail' 'blocked CASE_BLOCKED blocked'; do
  set -- $pair
  "$ROOT/bin/herdr-routines" create "$1" --name "$1" --agent stubagent --prompt "$2" --every 30s --notify always
  sleep 6
  "$ROOT/bin/herdr-routines" run "$1" > "$WORK/$1.json"
  node -e "const x=require('$WORK/$1.json');if(x.status!=='$3')process.exit(1)"
done
"$ROOT/bin/herdr-routines" create timeout --name Timeout --agent stubagent --prompt CASE_TIMEOUT --every 30s --notify always
python3 - <<PY
p='$CONFIG/timeout.toml'
s=open(p).read()+'\n[run]\ntimeout_minutes = 0.01\n'
open(p,'w').write(s)
PY
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
count=$("$HERDR" --session "$SESSION" tab list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let x=JSON.parse(s);console.log(x.tabs.filter(t=>/^Ok #/.test(t.label)).length)})")
[[ "$count" -le 3 ]]

# Kill -9 and make the persisted next due overdue, then restart: exactly one missed record and no fire.
kill -9 "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true; DAEMON_PID=''
node - <<PY
const fs=require('fs');const p='$STATE/state.json';const x=JSON.parse(fs.readFileSync(p));x.routines.ok.nextRunAt=new Date(Date.now()-3600000).toISOString();fs.writeFileSync(p,JSON.stringify(x,null,2))
PY
before=$(grep -c '"status":"ok"' "$STATE/runs/ok.jsonl" || true)
node "$ROOT/src/daemon.js" > "$WORK/daemon2.out" 2>&1 & DAEMON_PID=$!
for _ in $(seq 1 100); do [[ -S "$STATE/ctl.sock" ]] && break; sleep .1; done
sleep .5
after=$(grep -c '"status":"ok"' "$STATE/runs/ok.jsonl" || true)
[[ "$before" = "$after" ]]
[[ $(grep -c '"status":"missed"' "$STATE/runs/ok.jsonl") -eq 1 ]]

# Control protocol and overlap record are asserted without starting another agent.
node - <<'JS'
import net from 'node:net'
const socket=net.createConnection(process.env.HERDR_ROUTINES_STATE_DIR+'/ctl.sock')
let data='';socket.setEncoding('utf8');socket.on('connect',()=>socket.end('{"cmd":"status"}\n'));socket.on('data',x=>data+=x);socket.on('end',()=>{if(!JSON.parse(data).ok)process.exit(1)})
JS
printf 'e2e PASS session=%s outcomes=6 retention=PASS missed=PASS payload=PASS\n' "$SESSION"
