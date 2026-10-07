import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

test('manager process renders fixture, help, and the detail of a routine and a semantic watch over pipes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-ui-process-'))
  const config = path.join(root, 'config')
  const state = path.join(root, 'state')
  await fs.mkdir(path.join(state, 'runs'), { recursive: true })
  await fs.mkdir(config, { recursive: true })
  await fs.writeFile(path.join(config, 'sample.toml'), 'name="Sample"\nagent="stubagent"\nprompt="exact prompt"\n[trigger]\nkind="manual"\n')
  await fs.writeFile(path.join(config, 'deploy.toml'), 'name="Deploy ready"\n[trigger]\nkind="watch"\nevery="1h"\n[watch]\nurl="https://example.com/status"\nintent="tell me when it becomes ready"\n')
  await fs.writeFile(path.join(state, 'state.json'), '{"routines":{}}')
  const child = spawn(process.execPath, [path.resolve('src/ui.js')], {
    cwd: path.resolve('.'),
    env: { ...process.env, HERDR_ROUTINES_CONFIG_DIR: config, HERDR_ROUTINES_STATE_DIR: state },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const press = async (key) => { child.stdin.write(key); await new Promise((resolve) => setTimeout(resolve, 100)) }
  // Open help, then the detail of each routine in turn (list order is not fixed).
  for (const key of ['?', '?', '\r', '\x1b', 'j', '\r']) await press(key)
  child.stdin.write('q')
  await exited
  const visible = stripAnsi(output)
  assert.match(visible, /daemon down/)
  assert.match(visible, /Sample/)
  assert.match(visible, /ROUTINES HELP/)
  assert.match(visible, /exact prompt/)
  assert.match(visible, /watch https:\/\/example\.com\/status/)
  assert.match(visible, /INTENT\s+tell me when it becomes ready/)
  await fs.rm(root, { recursive: true, force: true })
})
