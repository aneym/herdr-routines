import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RoutineDaemon } from '../src/daemon.js'
import { getPaths } from '../src/lib/paths.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routines-test-'))
  const oldConfig = process.env.HERDR_ROUTINES_CONFIG_DIR
  const oldState = process.env.HERDR_ROUTINES_STATE_DIR
  process.env.HERDR_ROUTINES_CONFIG_DIR = path.join(root, 'config')
  process.env.HERDR_ROUTINES_STATE_DIR = path.join(root, 'state')
  const paths = getPaths('test')
  const daemon = new RoutineDaemon({ session: 'test', paths })
  await fs.mkdir(paths.configDir, { recursive: true })
  await fs.writeFile(path.join(paths.configDir, 'manual.toml'), 'name="Manual"\nagent="a"\nprompt="p"\n[trigger]\nkind="manual"\n')
  await daemon.initialize()
  t.after(async () => { await daemon.stop(); await fs.rm(root, { recursive: true, force: true }); if (oldConfig === undefined) delete process.env.HERDR_ROUTINES_CONFIG_DIR; else process.env.HERDR_ROUTINES_CONFIG_DIR = oldConfig; if (oldState === undefined) delete process.env.HERDR_ROUTINES_STATE_DIR; else process.env.HERDR_ROUTINES_STATE_DIR = oldState })
  return daemon
}

test('ctl status list pause resume and invalid command', async (t) => {
  const daemon = await fixture(t)
  assert.equal((await daemon.command({ cmd: 'status' })).ok, true)
  assert.equal((await daemon.command({ cmd: 'list' })).routines.length, 1)
  await daemon.command({ cmd: 'pause', id: 'manual' })
  assert.equal(daemon.state.routines.manual.paused, 'manual')
  await daemon.command({ cmd: 'resume', id: 'manual' })
  assert.equal(daemon.state.routines.manual.paused, undefined)
  await assert.rejects(daemon.command({ cmd: 'unknown' }), /unknown command/)
})
