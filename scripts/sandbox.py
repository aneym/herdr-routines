#!/usr/bin/env python3
import fcntl
import os
import pty
import signal
import struct
import sys
import termios

session = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    env = dict(os.environ)
    env.pop('HERDR_ENV', None)
    env['TERM'] = 'xterm-256color'
    binary = os.path.expanduser('~/.local/bin/herdr')
    os.execvpe(binary, [binary, '--session', session], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 160, 0, 0))
print(pid, flush=True)
def cleanup(*_):
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    sys.exit(0)
signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)
while True:
    try:
        if not os.read(fd, 65536): break
    except OSError: break
