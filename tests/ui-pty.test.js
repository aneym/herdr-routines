import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

test('manager process renders fixture and handles help key over pipes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-ui-process-'))
  const config = path.join(root, 'config')
  const state = path.join(root, 'state')
  await fs.mkdir(path.join(state, 'runs'), { recursive: true })
  await fs.mkdir(config, { recursive: true })
  await fs.writeFile(path.join(config, 'sample.toml'), 'name="Sample"\nagent="stubagent"\nprompt="exact prompt"\n[trigger]\nkind="manual"\n')
  await fs.writeFile(path.join(state, 'state.json'), '{"routines":{}}')
  const child = spawn(process.execPath, [path.resolve('src/ui.js')], {
    cwd: path.resolve('.'),
    env: { ...process.env, HERDR_ROUTINES_CONFIG_DIR: config, HERDR_ROUTINES_STATE_DIR: state },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  await new Promise((resolve) => setTimeout(resolve, 150))
  child.stdin.write('?')
  await new Promise((resolve) => setTimeout(resolve, 100))
  child.stdin.write('q')
  await new Promise((resolve) => child.on('exit', resolve))
  const visible = stripAnsi(output)
  assert.match(visible, /daemon down/)
  assert.match(visible, /Sample/)
  assert.match(visible, /ROUTINES HELP/)
  await fs.rm(root, { recursive: true, force: true })
})
