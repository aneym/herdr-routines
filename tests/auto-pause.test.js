import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { applyRunOutcome } from '../src/lib/failure.js'
import { RoutineDaemon } from '../src/daemon.js'
import { getPaths } from '../src/lib/paths.js'
import { readRuns } from '../src/lib/runstore.js'
import { saveState, loadState } from '../src/lib/state.js'

const failure = { notify_after: 3, renotify_hours: 8, auto_pause_after_days: 7 }
const exec = promisify(execFile)

test('a successful run clears stale failure dates before a later isolated failure', async (t) => {
  const { paths } = await fixture(t)
  const state = { failureStreak: 0, failingSince: '2026-01-01T00:00:00Z', lastFailureNotificationAt: '2026-01-01T01:00:00Z', nextRunAt: '2026-02-01T00:00:00Z', runCount: 25, paused: 'manual' }
  applyRunOutcome(state, 'ok', failure, new Date('2026-02-01T00:00:00Z'))
  assert.equal(Object.hasOwn(state, 'failingSince'), false)
  assert.equal(Object.hasOwn(state, 'lastFailureNotificationAt'), false)
  assert.equal(state.failureStreak, 0)
  assert.equal(state.nextRunAt, '2026-02-01T00:00:00Z')
  assert.equal(state.runCount, 25)
  assert.equal(state.paused, 'manual')
  await saveState(paths.stateFile, { routines: { sample: state } })
  const saved = (await loadState(paths.stateFile)).routines.sample
  assert.equal(Object.hasOwn(saved, 'failingSince'), false)
  assert.equal(Object.hasOwn(saved, 'lastFailureNotificationAt'), false)
  delete state.paused
  const result = applyRunOutcome(state, 'fail', failure, new Date('2026-03-03T00:00:00Z'))
  assert.equal(result.didAutoPause, false)
  assert.equal(state.paused, undefined)
  assert.equal(state.failingSince, '2026-03-03T00:00:00.000Z')
  assert.equal(state.failureStreak, 1)
})

test('seven days of continuous failures still auto-pause the live state', () => {
  const state = {}
  applyRunOutcome(state, 'fail', failure, new Date('2026-01-01T00:00:00Z'))
  const result = applyRunOutcome(state, 'timeout', failure, new Date('2026-01-08T00:00:00Z'))
  assert.equal(result.didAutoPause, true)
  assert.equal(state.paused, 'auto')
})

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-auto-pause-'))
  const stateDir = path.join(root, 'state')
  const paths = { ...getPaths('auto-pause-test'), configDir: path.join(root, 'config'), stateDir, runsDir: path.join(stateDir, 'runs'), notesDir: path.join(stateDir, 'notes'), stateFile: path.join(stateDir, 'state.json'), socketPath: path.join(root, 'ctl.sock'), socketMapFile: path.join(stateDir, 'ctl.sock.path'), inFlightFile: path.join(stateDir, 'in-flight.json'), logFile: path.join(stateDir, 'daemon.log') }
  // Unix sockets must stay short even when TMPDIR points at a long scratch path.
  paths.socketPath = getPathsForState(stateDir).socketPath
  await fs.mkdir(paths.configDir, { recursive: true })
  await fs.mkdir(paths.runsDir, { recursive: true })
  const daemon = new RoutineDaemon({ session: 'auto-pause-test', paths })
  t.after(async () => { await daemon.stop(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, paths, daemon }
}

function getPathsForState(stateDir) {
  const previous = process.env.HERDR_ROUTINES_STATE_DIR
  process.env.HERDR_ROUTINES_STATE_DIR = stateDir
  try { return getPaths('auto-pause-test') }
  finally {
    if (previous === undefined) delete process.env.HERDR_ROUTINES_STATE_DIR
    else process.env.HERDR_ROUTINES_STATE_DIR = previous
  }
}

test('startup accounts missed runs only for enabled, unpaused routines', async (t) => {
  const { paths, daemon } = await fixture(t)
  const past = new Date(Date.now() - 3 * 3600000).toISOString()
  for (const id of ['paused', 'disabled', 'active']) {
    await fs.writeFile(path.join(paths.configDir, `${id}.toml`), `name="${id}"\nagent="a"\nprompt="p"\nenabled=${id !== 'disabled'}\n[trigger]\nkind="interval"\nevery="1h"\n`)
    daemon.state.routines[id] = { nextRunAt: past, ...(id === 'paused' ? { paused: 'auto' } : {}) }
  }
  daemon.isStopping = true
  await daemon.reload(true)
  for (const id of ['paused', 'disabled']) {
    assert.deepEqual(await readRuns(paths.runsDir, id), [])
    assert.equal(daemon.state.routines[id].nextRunAt, past)
  }
  const runs = await readRuns(paths.runsDir, 'active')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'missed')
  assert.ok(runs[0].missed_count >= 3)
  const log = await fs.readFile(paths.logFile, 'utf8')
  assert.match(log, /active.*missed count=/)
  assert.doesNotMatch(log, /paused|disabled/)
})

async function doctor(root, paths) {
  const env = { ...process.env, HOME: root, HERDR_SESSION: 'auto-pause-test', HERDR_ROUTINES_CONFIG_DIR: paths.configDir, HERDR_ROUTINES_STATE_DIR: paths.stateDir, HERDR_ROUTINES_ROSTER: path.join(root, 'roster') }
  try {
    const { stdout } = await exec(process.execPath, ['bin/herdr-routines', 'doctor'], { env })
    return { code: 0, checks: JSON.parse(stdout) }
  } catch (error) {
    if (!error.stdout) throw error
    return { code: error.code, checks: JSON.parse(error.stdout) }
  }
}

test('doctor reports live auto pauses and accepts a manual pause', async (t) => {
  const { root, paths, daemon } = await fixture(t)
  await fs.writeFile(path.join(paths.configDir, 'sample.toml'), 'name="Sample"\nagent="a"\nprompt="p"\n[trigger]\nkind="manual"\n')
  await fs.writeFile(path.join(root, 'roster'), '')
  const sessionDir = path.join(root, '.config/herdr/sessions/auto-pause-test')
  await fs.mkdir(sessionDir, { recursive: true })
  await fs.writeFile(path.join(sessionDir, 'herdr.sock'), '')
  await daemon.initialize()
  const failingSince = '2026-01-01T00:00:00Z'
  daemon.state.routines.sample = { paused: 'auto', failingSince }
  let result = await doctor(root, paths)
  assert.equal(result.code, 1)
  assert.equal(result.checks.daemonUp, true)
  assert.deepEqual(result.checks.pausedRoutines, [{ id: 'sample', paused: 'auto', failingSince }])
  daemon.state.routines.sample = { paused: 'manual' }
  result = await doctor(root, paths)
  assert.equal(result.code, 0)
  assert.deepEqual(result.checks.pausedRoutines, [{ id: 'sample', paused: 'manual', failingSince: null }])
})

test('doctor reads paused routines from saved state when the daemon is down', async (t) => {
  const { root, paths } = await fixture(t)
  const failingSince = '2026-01-01T00:00:00Z'
  await fs.writeFile(paths.stateFile, JSON.stringify({ routines: { sample: { paused: 'auto', failingSince } } }))
  const result = await doctor(root, paths)
  assert.equal(result.code, 1)
  assert.equal(result.checks.daemonUp, false)
  assert.deepEqual(result.checks.pausedRoutines, [{ id: 'sample', paused: 'auto', failingSince }])
})
