import os from 'node:os'
import path from 'node:path'

export function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

export function getPaths(session = process.env.HERDR_SESSION || 'default') {
  const configDir = expandHome(process.env.HERDR_ROUTINES_CONFIG_DIR || '~/.config/herdr/routines')
  const stateRoot = expandHome(process.env.HERDR_ROUTINES_STATE_DIR || '~/.local/state/herdr-routines')
  const stateDir = process.env.HERDR_ROUTINES_STATE_DIR ? stateRoot : path.join(stateRoot, session)
  return {
    configDir,
    stateDir,
    runsDir: path.join(stateDir, 'runs'),
    notesDir: path.join(stateDir, 'notes'),
    stateFile: path.join(stateDir, 'state.json'),
    socketPath: path.join(stateDir, 'ctl.sock'),
    logFile: path.join(stateDir, 'daemon.log'),
  }
}
