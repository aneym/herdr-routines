#!/usr/bin/env node
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getPaths } from './lib/paths.js'
import { loadRoutines } from './lib/routines.js'
import { loadState } from './lib/state.js'
import { readRuns } from './lib/runstore.js'
import { herdrRequest } from './lib/herdr.js'

const ESC = '\x1b'
const CLEAR = `${ESC}[2J${ESC}[H`
const INK = `${ESC}[38;5;255m`
const SECONDARY = `${ESC}[38;5;246m`
const GOOD = `${ESC}[38;5;114m`
const BAD = `${ESC}[38;5;203m`
const ACCENT = `${ESC}[38;5;141m`
const RESET = `${ESC}[0m`

export async function control(socketPath, request) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let text = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => { text += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      try {
        const response = JSON.parse(text)
        response.ok ? resolve(response) : reject(new Error(response.error))
      } catch (error) { reject(error) }
    })
  })
}

function relativeTime(value, now = Date.now()) {
  if (!value) return 'unscheduled'
  const seconds = Math.round((new Date(value).getTime() - now) / 1000)
  const absolute = Math.abs(seconds)
  const unit = absolute >= 86400 ? `${Math.round(absolute / 86400)}d` : absolute >= 3600 ? `${Math.round(absolute / 3600)}h` : absolute >= 60 ? `${Math.round(absolute / 60)}m` : `${absolute}s`
  return seconds >= 0 ? `in ${unit}` : `${unit} ago`
}

function glyphFor(item) {
  if (item.invalid) return `${BAD}!${RESET}`
  if (item.isRunning) return `${ACCENT}●${RESET}`
  if (item.state.paused) return `${SECONDARY}◌${RESET}`
  const status = item.runs.at(-1)?.status
  if (['fail', 'timeout', 'blocked'].includes(status)) return `${BAD}✗${RESET}`
  if (['ok', 'ok_untagged', 'noop'].includes(status)) return `${GOOD}✓${RESET}`
  return `${SECONDARY}!${RESET}`
}

function priority(item) {
  const status = item.runs.at(-1)?.status
  if (item.invalid || ['fail', 'timeout', 'blocked'].includes(status)) return 0
  if (item.isRunning) return 1
  return 2
}

function timeFact(item) {
  if (item.invalid) return item.invalid
  if (item.isRunning) return 'running'
  if (item.state.paused) return item.state.paused === 'auto' ? 'auto-paused' : 'paused'
  const last = item.runs.at(-1)
  if (['fail', 'timeout'].includes(last?.status)) return `✗×${item.state.failureStreak || 1}`
  return relativeTime(item.state.nextRunAt)
}

export function renderList(model, columns = 80) {
  const visible = model.items.filter((item) => !model.filter || `${item.id} ${item.routine?.name || ''}`.toLowerCase().includes(model.filter.toLowerCase()))
  const failing = visible.filter((item) => priority(item) === 0).length
  const lines = [`${INK}ROUTINES ${visible.length}${failing ? `  ${BAD}${failing}▲${RESET}` : ''}${RESET}`]
  if (model.isDaemonDown) lines.push(`${BAD}daemon down — start it with launchd or [[startup]]${RESET}`)
  visible.forEach((item, index) => {
    const selected = index === model.selected ? `${ACCENT}▌${RESET}` : ' '
    const name = item.routine?.name || item.id
    const fact = timeFact(item)
    const available = Math.max(8, columns - 7 - name.length)
    lines.push(`${selected} ${glyphFor(item)} ${INK}${name}${RESET}${columns >= 50 ? ` ${SECONDARY}${fact.slice(0, available)}${RESET}` : ''}`)
    if (item.invalid) lines.push(`    ${BAD}${item.invalid.slice(0, Math.max(10, columns - 6))}${RESET}`)
  })
  if (!visible.length) lines.push(`${SECONDARY}no routines${RESET}`)
  lines.push('', `${SECONDARY}enter detail  space pause  r run  / filter  n new  ? help  q quit${RESET}`)
  return lines.join('\n')
}

export function renderRun(item, runIndex) {
  const run = item.runs.slice(-20).reverse()[runIndex]
  if (!run) return `${SECONDARY}run unavailable${RESET}`
  return `${INK}${item.routine?.name || item.id} · ${run.status}${RESET}\n${run.ts} · ${run.duration_ms || 0}ms\nlocation ${run.workspace_id || '-'} / ${run.tab_id || '-'} / ${run.pane_id || '-'}\n\n${run.output_tail || run.summary || 'no recorded output'}\n\n${SECONDARY}Esc back  f focus live pane${RESET}`
}

export function renderDetail(item, columns = 80) {
  const routine = item.routine
  if (!routine) return `${BAD}${item.id}: ${item.invalid}${RESET}\n\nEsc back`
  const last = item.runs.at(-1)
  const schedule = routine.trigger.expr || routine.trigger.every || routine.trigger.when || routine.trigger.kind
  const lines = [
    `${INK}${routine.name}${RESET}  ${item.state.paused ? `${SECONDARY}${item.state.paused}-paused${RESET}` : `${GOOD}enabled${RESET}`}`,
    `${routine.trigger.kind} ${schedule}${routine.trigger.tz ? ` · ${routine.trigger.tz}` : ''}`,
    `agent ${routine.agent} · ${routine.run.target} · ${routine.run.workspace}`,
    `next ${item.state.nextRunAt || 'none'} · ${relativeTime(item.state.nextRunAt)}`,
    `last ${last?.status || 'never'}${last ? ` · ${relativeTime(last.ts)} · ${last.duration_ms}ms` : ''} · streak ${item.state.failureStreak || 0}`,
    '', `${ACCENT}PROMPT${RESET}`, ...routine.prompt.split('\n').map((line) => line.slice(0, columns)),
    '', `${ACCENT}RUNS${RESET}`,
  ]
  for (const run of item.runs.slice(-20).reverse()) lines.push(`${run.status.padEnd(16)} ${relativeTime(run.ts).padEnd(10)} ${String(run.duration_ms || 0).padStart(6)}ms  ${(run.summary || '').slice(0, Math.max(5, columns - 45))}`)
  lines.push('', `${SECONDARY}Esc back  space pause  r run  l output  e edit  m notes  d delete  ? help${RESET}`)
  return lines.join('\n')
}

export function renderHelp() {
  return `${INK}ROUTINES HELP${RESET}\n\nenter / Esc  drill in / back\nspace        pause or resume\nr            run now\nl            last output\ne / m        edit definition / notes\nn            creation guidance\nd            delete with confirmation\n/            filter\nR            refresh\n?            toggle help\nq / ctrl+c   quit`
}

async function fileOverview(paths) {
  const routines = await loadRoutines(paths.configDir)
  const state = await loadState(paths.stateFile)
  const items = []
  for (const [id, entry] of routines) items.push({ id, ...entry, state: state.routines[id] || {}, isRunning: false, runs: await readRuns(paths.runsDir, id, 20) })
  return items
}

async function openEditor(file) {
  const editor = process.env.EDITOR
  if (!editor) return
  await new Promise((resolve) => {
    const child = spawn(editor, [file], { stdio: 'inherit', shell: true })
    child.on('exit', resolve)
  })
}

export class Manager {
  constructor({ paths = getPaths(), output = process.stdout } = {}) {
    this.paths = paths
    this.output = output
    this.items = []
    this.selected = 0
    this.view = 'list'
    this.filter = ''
    this.isDaemonDown = false
    this.message = ''
    this.pendingDelete = null
    this.runSelected = 0
  }

  async refresh() {
    try {
      const response = await control(this.paths.socketPath, { cmd: 'overview' })
      this.items = response.routines
      this.isDaemonDown = false
    } catch {
      this.items = await fileOverview(this.paths)
      this.isDaemonDown = true
    }
    this.items.sort((left, right) => priority(left) - priority(right) || new Date(left.state.nextRunAt || 8640000000000000) - new Date(right.state.nextRunAt || 8640000000000000))
    this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1))
  }

  render() {
    const model = { items: this.items, selected: this.selected, filter: this.filter, isDaemonDown: this.isDaemonDown }
    const text = this.view === 'help' ? renderHelp() : this.view === 'run' ? renderRun(this.items[this.selected], this.runSelected) : this.view === 'detail' ? renderDetail(this.items[this.selected], this.output.columns || 80) : renderList(model, this.output.columns || 80)
    this.output.write(`${CLEAR}${text}${this.message ? `\n${ACCENT}${this.message}${RESET}` : ''}`)
  }

  async handle(key) {
    const item = this.items[this.selected]
    this.message = ''
    if (key === 'q' || key === '') return false
    if (key === '?') this.view = this.view === 'help' ? 'list' : 'help'
    else if (key === '' || key === 'escape') this.view = 'list'
    else if (key === '\r' || key === 'enter') {
      if (this.view === 'detail' && item?.runs.length) this.view = 'run'
      else this.view = 'detail'
    } else if (key === 'j' || key === 'down') {
      if (this.view === 'detail') this.runSelected = Math.min((item?.runs.length || 1) - 1, this.runSelected + 1)
      else this.selected = Math.min(this.items.length - 1, this.selected + 1)
    } else if (key === 'k' || key === 'up') {
      if (this.view === 'detail') this.runSelected = Math.max(0, this.runSelected - 1)
      else this.selected = Math.max(0, this.selected - 1)
    }
    else if (key === 'R') await this.refresh()
    else if (key === '/' && process.stdin.isTTY) {
      process.stdin.setRawMode(false)
      this.filter = await new Promise((resolve) => readline.createInterface({ input: process.stdin, output: this.output }).question('filter: ', resolve))
      process.stdin.setRawMode(true)
    } else if (key === ' ' && item && !this.isDaemonDown) await control(this.paths.socketPath, { cmd: item.state.paused ? 'resume' : 'pause', id: item.id })
    else if (key === 'r' && item && !this.isDaemonDown) { control(this.paths.socketPath, { cmd: 'run', id: item.id }).catch(() => {}); this.message = 'run started' }
    else if (key === 'l' && item) { this.runSelected = 0; this.view = 'run' }
    else if (key === 'f' && this.view === 'run' && item) {
      const run = item.runs.slice(-20).reverse()[this.runSelected]
      if (run?.pane_id) {
        try { await herdrRequest(process.env.HERDR_SESSION || 'default', 'pane.focus', { pane_id: run.pane_id }); this.message = 'focused live pane' }
        catch { this.message = 'pane no longer alive' }
      }
    } else if (key === 'e' && item) await openEditor(path.join(this.paths.configDir, `${item.id}.toml`))
    else if (key === 'm' && item) await openEditor(path.join(this.paths.notesDir, `${item.id}.md`))
    else if (key === 'n') this.message = 'Create conversationally via an agent, or run: herdr-routines create …'
    else if (key === 'd' && item) { this.pendingDelete = item.id; this.message = `Delete ${item.id}? press y` }
    else if (key === 'y' && this.pendingDelete) { await fs.unlink(path.join(this.paths.configDir, `${this.pendingDelete}.toml`)); this.pendingDelete = null; this.message = 'deleted' }
    await this.refresh()
    return true
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  const manager = new Manager()
  await manager.refresh()
  manager.render()
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  const poll = setInterval(async () => { await manager.refresh(); manager.render() }, 2000)
  process.stdin.on('data', async (data) => {
    const key = data === '\x1b[A' ? 'up' : data === '\x1b[B' ? 'down' : data
    if (!await manager.handle(key)) { clearInterval(poll); process.exit(0) }
    manager.render()
  })
}
