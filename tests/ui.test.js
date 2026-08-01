import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { renderList, renderDetail, renderHelp, Manager } from '../src/ui.js'
import { getPaths } from '../src/lib/paths.js'

const routine = { name: 'Daily scan', agent: 'stubagent', prompt: 'Find changes\nand report them.', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' }, run: { target: 'isolated', workspace: 'routines' } }
const items = [
  { id: 'fail', routine: { ...routine, name: 'Failing' }, state: { failureStreak: 4 }, runs: [{ status: 'fail', ts: new Date().toISOString(), duration_ms: 10, summary: 'bad' }] },
  { id: 'run', routine: { ...routine, name: 'Running' }, state: {}, isRunning: true, runs: [] },
  { id: 'ok', routine, state: { nextRunAt: new Date(Date.now() + 60000).toISOString() }, runs: [{ status: 'ok', ts: new Date().toISOString(), duration_ms: 20, summary: 'done' }] },
  { id: 'pause', routine: { ...routine, name: 'Paused' }, state: { paused: 'manual' }, runs: [] },
  { id: 'auto', routine: { ...routine, name: 'Auto' }, state: { paused: 'auto' }, runs: [] },
  { id: 'invalid', invalid: 'unknown key wat', state: {}, runs: [] },
]

test('list renders all glyph states, invalids, daemon banner, and filter', () => {
  const text = renderList({ items, selected: 0, filter: '', isDaemonDown: true }, 80)
  for (const expected of ['✗', '●', '✓', '◌', 'Auto', 'auto-paused', 'unknown key wat', 'daemon down']) assert.match(text, new RegExp(expected))
  const filtered = renderList({ items, selected: 0, filter: 'Daily', isDaemonDown: false }, 80)
  assert.match(filtered, /Daily scan/)
  assert.doesNotMatch(filtered, /Failing/)
})

test('detail renders definition, exact prompt, and run history', () => {
  const text = renderDetail(items[2], 80)
  assert.match(text, /cron 0 9 \* \* \*/)
  assert.match(text, /Find changes\nand report them\./)
  assert.match(text, /done/)
})

test('help documents keyboard verbs', () => {
  const text = renderHelp()
  for (const expected of ['pause or resume', 'run now', 'delete with confirmation', 'quit']) assert.match(text, new RegExp(expected))
})

test('manager interaction toggles pause and refreshes row state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-ui-live-'))
  const paths = { ...getPaths('ui-live'), configDir: path.join(root, 'config'), stateDir: path.join(root, 'state'), runsDir: path.join(root, 'state/runs'), notesDir: path.join(root, 'state/notes'), stateFile: path.join(root, 'state/state.json'), socketPath: path.join(root, 'ctl.sock'), logFile: path.join(root, 'state/daemon.log') }
  await fs.mkdir(paths.configDir, { recursive: true })
  await fs.writeFile(path.join(paths.configDir, 'sample.toml'), 'name="Sample"\nagent="stubagent"\nprompt="p"\n[trigger]\nkind="manual"\n')
  const { RoutineDaemon } = await import('../src/daemon.js')
  const daemon = new RoutineDaemon({ session: 'ui-live', paths })
  await daemon.initialize()
  const manager = new Manager({ paths, output: { columns: 80, write() {} } })
  await manager.refresh()
  await manager.handle(' ')
  assert.equal(manager.items[0].state.paused, 'manual')
  await manager.handle(' ')
  assert.equal(manager.items[0].state.paused, undefined)
  t.after(async () => { await daemon.stop(); await fs.rm(root, { recursive: true, force: true }) })
})

test('manager file mode shows daemon down and deletes with confirmation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-ui-'))
  const oldConfig = process.env.HERDR_ROUTINES_CONFIG_DIR
  const oldState = process.env.HERDR_ROUTINES_STATE_DIR
  process.env.HERDR_ROUTINES_CONFIG_DIR = path.join(root, 'config')
  process.env.HERDR_ROUTINES_STATE_DIR = path.join(root, 'state')
  const paths = getPaths('ui')
  await fs.mkdir(paths.configDir, { recursive: true })
  await fs.writeFile(path.join(paths.configDir, 'sample.toml'), 'name="Sample"\nagent="stubagent"\nprompt="p"\n[trigger]\nkind="manual"\n')
  const manager = new Manager({ paths, output: { columns: 80, write() {} } })
  await manager.refresh()
  assert.equal(manager.isDaemonDown, true)
  await manager.handle('d')
  await manager.handle('y')
  await assert.rejects(fs.access(path.join(paths.configDir, 'sample.toml')))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); if (oldConfig === undefined) delete process.env.HERDR_ROUTINES_CONFIG_DIR; else process.env.HERDR_ROUTINES_CONFIG_DIR = oldConfig; if (oldState === undefined) delete process.env.HERDR_ROUTINES_STATE_DIR; else process.env.HERDR_ROUTINES_STATE_DIR = oldState })
})
