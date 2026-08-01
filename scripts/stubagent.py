#!/usr/bin/env python3
import os
import subprocess
import sys
import time

sequence = 0
def report(state):
    global sequence
    sequence += 1
    binary = os.path.expanduser('~/.local/bin/herdr')
    session = os.environ.get('HERDR_SESSION', 'default')
    pane = os.environ.get('HERDR_PANE_ID')
    if pane:
        agent = os.environ.get('STUBAGENT_KIND', 'stubagent')
        subprocess.run([binary, '--session', session, 'pane', 'report-agent', pane, '--source', 'stubagent-test', '--agent', agent, '--state', state, '--seq', str(sequence), '--agent-session-id', f'stub-{pane}'], check=True, stdout=subprocess.DEVNULL)

print('STUBAGENT READY')
report('idle')
print('stub> ', end='', flush=True)
for line in sys.stdin:
    text = line.strip()
    capture = os.environ.get('STUBAGENT_CAPTURE')
    if capture:
        with open(capture, 'a') as file: file.write(text + '\n---\n')
    if not text.startswith('CASE_'):
        continue
    report('working')
    time.sleep(0.2)
    if 'CASE_NOOP' in text: print('nothing changed ROUTINE_NOOP')
    elif 'CASE_UNTAGGED' in text: print('completed without token')
    elif 'CASE_FAIL' in text: print('failed intentionally'); sys.exit(1)
    elif 'CASE_TIMEOUT' in text: time.sleep(120)
    elif 'CASE_BLOCKED' in text:
        print('waiting for approval')
        report('blocked')
        continue
    else: print('completed ROUTINE_OK')
    report('idle')
    print('stub> ', end='', flush=True)
