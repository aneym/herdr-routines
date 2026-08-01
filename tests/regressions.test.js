import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getPaths } from '../src/lib/paths.js'
import { validateRoutine } from '../src/lib/routines.js'
import { RoutineDaemon } from '../src/daemon.js'

function fixturePaths(root) {
  const stateDir = path.join(root, 'state')
  return { ...getPaths('repair'), configDir: path.join(root, 'config'), stateDir, runsDir: path.join(stateDir, 'runs'), notesDir: path.join(stateDir, 'notes'), stateFile: path.join(stateDir, 'state.json'), socketMapFile: path.join(stateDir, 'ctl.sock.path'), inFlightFile: path.join(stateDir, 'in-flight.json'), logFile: path.join(stateDir, 'daemon.log') }
}

test('ctl socket remains short for a deeply nested state directory', () => {
  const old = process.env.HERDR_ROUTINES_STATE_DIR
  process.env.HERDR_ROUTINES_STATE_DIR = `/private/tmp/${'deep/'.repeat(30)}state`
  const paths = getPaths('deep')
  assert.ok(paths.socketPath.length < 104)
  assert.match(paths.socketPath, /hr-[a-f0-9]+\.sock$/)
  if (old === undefined) delete process.env.HERDR_ROUTINES_STATE_DIR
  else process.env.HERDR_ROUTINES_STATE_DIR = old
})

test('invalid timezone and oversized prompt are rejected while far-future schedules are valid', () => {
  assert.throws(() => validateRoutine('bad', { name: 'Bad', agent: 'a', prompt: 'p', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Not/AZone' } }), /invalid cron or timezone/)
  assert.throws(() => validateRoutine('large', { name: 'Large', agent: 'a', prompt: 'x'.repeat(256 * 1024 + 1), trigger: { kind: 'manual' } }), /256KB/)
  assert.doesNotThrow(() => validateRoutine('future', { name: 'Future', agent: 'a', prompt: 'p', trigger: { kind: 'at', when: '2099-01-01T00:00:00Z' } }))
  assert.doesNotThrow(() => validateRoutine('cron', { name: 'Cron', agent: 'a', prompt: 'p', trigger: { kind: 'cron', expr: '0 0 1 1 *' } }))
})

test('daemon startup survives invalid timezone and marks routine invalid', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-invalid-tz-'))
  const paths = fixturePaths(root)
  await fs.mkdir(paths.configDir, { recursive: true })
  await fs.writeFile(path.join(paths.configDir, 'bad.toml'), 'name="Bad"\nagent="a"\nprompt="p"\n[trigger]\nkind="cron"\nexpr="0 9 * * *"\ntz="Not/AZone"\n')
  const daemon = new RoutineDaemon({ session: 'repair', paths })
  await daemon.initialize()
  assert.match(daemon.routines.get('bad').invalid, /invalid cron or timezone/)
  assert.equal((await daemon.command({ cmd: 'status' })).ok, true)
  t.after(async () => { await daemon.stop(); await fs.rm(root, { recursive: true, force: true }) })
})

test('timer delay clamps far-future schedules', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-timer-'))
  const paths = fixturePaths(root)
  await fs.mkdir(paths.configDir, { recursive: true })
  await fs.writeFile(path.join(paths.configDir, 'future.toml'), 'name="Future"\nagent="a"\nprompt="p"\n[trigger]\nkind="at"\nwhen="2099-01-01T00:00:00Z"\n')
  const daemon = new RoutineDaemon({ session: 'repair', paths })
  await daemon.initialize()
  assert.ok(daemon.timer._idleTimeout <= 2147483647)
  t.after(async () => { await daemon.stop(); await fs.rm(root, { recursive: true, force: true }) })
})

test('startup reconciles in-flight markers as orphaned', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-orphan-'))
  const paths = fixturePaths(root)
  await fs.mkdir(paths.runsDir, { recursive: true })
  await fs.mkdir(paths.configDir, { recursive: true })
  await fs.writeFile(paths.stateFile, '{"routines":{"sample":{"runCount":1}}}')
  await fs.writeFile(paths.inFlightFile, JSON.stringify([{ run_id: 'run-1', routine_id: 'sample', trigger: 'manual', started_at: new Date(Date.now() - 1000).toISOString(), tab_id: 'w1:t2' }]))
  const daemon = new RoutineDaemon({ session: 'repair', paths })
  await daemon.initialize()
  const history = await fs.readFile(path.join(paths.runsDir, 'sample.jsonl'), 'utf8')
  assert.match(history, /"status":"orphaned"/)
  assert.equal(daemon.state.routines.sample.runCount, 1)
  assert.equal(daemon.state.routines.sample.failureStreak, 1)
  t.after(async () => { await daemon.stop(); await fs.rm(root, { recursive: true, force: true }) })
})

test('ctl disconnect during response does not kill daemon', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-epipe-'))
  const paths = fixturePaths(root)
  await fs.mkdir(paths.configDir, { recursive: true })
  const daemon = new RoutineDaemon({ session: 'repair', paths })
  await daemon.initialize()
  const client = net.createConnection(paths.socketPath)
  client.on('error', () => {})
  await new Promise((resolve) => client.once('connect', resolve))
  client.write('{"cmd":"status"}\n')
  client.destroy()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await daemon.command({ cmd: 'status' })).ok, true)
  t.after(async () => { await daemon.stop(); await fs.rm(root, { recursive: true, force: true }) })
})
