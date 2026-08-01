import fs from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'smol-toml'
import { Cron } from 'croner'

const ROOT_KEYS = new Set(['name', 'agent', 'prompt', 'enabled', 'trigger', 'run', 'delivery', 'failure', 'fire'])
const MAX_PROMPT_BYTES = 256 * 1024
const SECTION_KEYS = {
  trigger: new Set(['kind', 'expr', 'tz', 'every', 'when']),
  run: new Set(['target', 'workspace', 'cwd', 'overlap', 'timeout_minutes', 'detect_timeout_seconds', 'keep_runs', 'busy']),
  delivery: new Set(['notify', 'ok_token', 'noop_token']),
  failure: new Set(['notify_after', 'renotify_hours', 'auto_pause_after_days']),
  fire: new Set(['token']),
}

function rejectUnknown(object, keys, location) {
  for (const key of Object.keys(object || {})) {
    if (!keys.has(key)) throw new Error(`unknown key ${location}${key}`)
  }
}

export function parseDuration(value) {
  const match = /^(\d+)(s|m|h|d)$/.exec(value || '')
  if (!match) throw new Error(`invalid duration: ${value}`)
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 }
  const milliseconds = Number(match[1]) * multipliers[match[2]]
  if (milliseconds < 30000) throw new Error('interval must be at least 30s')
  return milliseconds
}

export function validateRoutine(id, input) {
  rejectUnknown(input, ROOT_KEYS, '')
  for (const [section, keys] of Object.entries(SECTION_KEYS)) rejectUnknown(input[section], keys, `${section}.`)
  for (const key of ['name', 'agent', 'prompt']) if (!input[key] || typeof input[key] !== 'string') throw new Error(`${key} is required`)
  if (Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT_BYTES) throw new Error('prompt exceeds 256KB limit')
  if (!input.trigger || !['cron', 'interval', 'at', 'watch', 'manual'].includes(input.trigger.kind)) throw new Error('invalid trigger.kind')
  if (input.trigger.kind === 'cron') {
    if (!input.trigger.expr) throw new Error('trigger.expr is required')
    try { new Cron(input.trigger.expr, { timezone: input.trigger.tz, paused: true }).nextRun() }
    catch (error) { throw new Error(`invalid cron or timezone: ${error.message}`) }
  }
  if (['interval', 'watch'].includes(input.trigger.kind)) parseDuration(input.trigger.every)
  if (input.trigger.kind === 'at' && Number.isNaN(new Date(input.trigger.when).getTime())) throw new Error('invalid trigger.when')
  const target = input.run?.target || 'isolated'
  const detectTimeoutSeconds = input.run?.detect_timeout_seconds ?? 120
  if (!Number.isFinite(detectTimeoutSeconds) || detectTimeoutSeconds < 10) throw new Error('run.detect_timeout_seconds must be at least 10')
  if (target.startsWith('session:')) throw new Error('session target is not in v1')
  if (target !== 'isolated' && !target.startsWith('pane:')) throw new Error('invalid run.target')
  if (input.fire && !input.fire.token) throw new Error('fire.token is required')
  return {
    id,
    name: input.name,
    agent: input.agent,
    prompt: input.prompt,
    enabled: input.enabled !== false,
    trigger: { ...input.trigger },
    run: {
      target,
      workspace: input.run?.workspace || '⚡ routines',
      cwd: input.run?.cwd || '~',
      overlap: input.run?.overlap || 'skip',
      busy: input.run?.busy || 'skip',
      timeout_minutes: input.run?.timeout_minutes ?? 30,
      detect_timeout_seconds: detectTimeoutSeconds,
      keep_runs: input.run?.keep_runs ?? 3,
    },
    delivery: {
      notify: input.delivery?.notify || 'always',
      ok_token: input.delivery?.ok_token || 'ROUTINE_OK',
      noop_token: input.delivery?.noop_token || 'ROUTINE_NOOP',
    },
    failure: {
      notify_after: input.failure?.notify_after ?? 3,
      renotify_hours: input.failure?.renotify_hours ?? 8,
      auto_pause_after_days: input.failure?.auto_pause_after_days ?? 7,
    },
    fire: input.fire,
  }
}

export async function loadRoutines(configDir) {
  await fs.mkdir(configDir, { recursive: true })
  const entries = await fs.readdir(configDir)
  const routines = new Map()
  for (const name of entries.filter((entry) => entry.endsWith('.toml') && !entry.startsWith('_'))) {
    const id = path.basename(name, '.toml')
    try {
      const raw = parse(await fs.readFile(path.join(configDir, name), 'utf8'))
      routines.set(id, { routine: validateRoutine(id, raw) })
    } catch (error) {
      routines.set(id, { invalid: error.message })
    }
  }
  return routines
}

export async function writeRoutine(configDir, id, routine, force = false) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('id must use lowercase letters, numbers, _ or -')
  await fs.mkdir(configDir, { recursive: true })
  const file = path.join(configDir, `${id}.toml`)
  if (!force) {
    try { await fs.access(file); throw new Error(`routine already exists: ${id}`) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  validateRoutine(id, routine)
  await fs.writeFile(file, stringify(routine))
  return file
}
