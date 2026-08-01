#!/usr/bin/env node
import fs from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { parse } from 'smol-toml'
import { getPaths } from './lib/paths.js'
import { loadRoutines } from './lib/routines.js'
import { loadState, saveState } from './lib/state.js'
import { nextRunAt, accountMissed } from './lib/schedule.js'
import { appendRun, readRuns } from './lib/runstore.js'
import { executeRun } from './lib/executor.js'
import { applyFailurePolicy } from './lib/failure.js'
import { notify, shouldNotify } from './lib/notify.js'
import { constantTimeToken } from './lib/herdr.js'
import { logLine } from './lib/log.js'

export class RoutineDaemon {
  constructor({ session = process.env.HERDR_SESSION || 'default', paths = getPaths(session) } = {}) {
    this.session = session
    this.paths = paths
    this.routines = new Map()
    this.state = { routines: {} }
    this.running = new Set()
    this.timer = null
    this.pollTimer = null
    this.server = null
    this.httpServer = null
    this.isStopping = false
    this.lastLogs = new Map()
    this.markers = new Map()
    this.markerWrite = Promise.resolve()
  }

  async initialize() {
    await fs.mkdir(this.paths.runsDir, { recursive: true })
    await fs.mkdir(this.paths.notesDir, { recursive: true })
    this.state = await loadState(this.paths.stateFile)
    await this.reconcileOrphans()
    await this.reload(true)
    await this.startControlServer()
    await this.startHttpServer()
    this.pollTimer = setInterval(() => this.reload().catch((error) => this.log('', error.message)), 5000)
    this.scheduleTimer()
  }

  async log(id, message) {
    const key = `${id}:${message}`
    const now = Date.now()
    if (now - (this.lastLogs.get(key) || 0) < 60000) return
    this.lastLogs.set(key, now)
    await logLine(this.paths.logFile, id, message)
  }

  async reconcileOrphans() {
    let markers = []
    try { markers = JSON.parse(await fs.readFile(this.paths.inFlightFile, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    this.markers = new Map(markers.map((marker) => [marker.run_id, marker]))
    for (const marker of markers) {
      const state = this.state.routines[marker.routine_id] ||= {}
      state.failureStreak = (state.failureStreak || 0) + 1
      state.failingSince ||= new Date().toISOString()
      await appendRun(this.paths.runsDir, { ...marker, ts: new Date().toISOString(), status: 'orphaned', duration_ms: Date.now() - new Date(marker.started_at).getTime(), summary: 'daemon exited during run' })
    }
    if (markers.length) await saveState(this.paths.stateFile, this.state)
    this.markers.clear()
    await this.persistMarkers()
  }

  async persistMarkers() {
    this.markerWrite = this.markerWrite.then(() => fs.writeFile(this.paths.inFlightFile, `${JSON.stringify([...this.markers.values()], null, 2)}\n`))
    await this.markerWrite
  }

  async addMarker(marker) {
    this.markers.set(marker.run_id, marker)
    await this.persistMarkers()
  }

  async removeMarker(runId) {
    this.markers.delete(runId)
    await this.persistMarkers()
  }

  async reload(isStartup = false) {
    this.routines = await loadRoutines(this.paths.configDir)
    const now = new Date()
    for (const [id, entry] of this.routines) {
      if (entry.invalid) { await this.log(id, `invalid: ${entry.invalid}`); continue }
      const routineState = this.state.routines[id] ||= {}
      if (isStartup) {
        const accounting = accountMissed(entry.routine, routineState.nextRunAt, now)
        if (accounting.missedCount) {
          const record = { ts: now.toISOString(), run_id: crypto.randomUUID(), routine_id: id, trigger: entry.routine.trigger.kind, status: 'missed', missed_count: accounting.missedCount, duration_ms: 0, summary: `missed ${accounting.missedCount} scheduled run(s)`, next_run_at: accounting.next?.toISOString() || null }
          await appendRun(this.paths.runsDir, record)
          await this.log(id, `missed count=${accounting.missedCount}`)
        }
        routineState.nextRunAt = accounting.next?.toISOString() || null
      } else if (!routineState.nextRunAt) {
        routineState.nextRunAt = nextRunAt(entry.routine, now)?.toISOString() || null
      }
    }
    await saveState(this.paths.stateFile, this.state)
    this.scheduleTimer()
  }

  scheduleTimer() {
    clearTimeout(this.timer)
    if (this.isStopping) return
    let earliest = Infinity
    for (const [id, entry] of this.routines) {
      if (entry.invalid || !entry.routine.enabled || this.state.routines[id]?.paused) continue
      const due = new Date(this.state.routines[id]?.nextRunAt || 0).getTime()
      if (due > 0) earliest = Math.min(earliest, due)
    }
    if (earliest !== Infinity) {
      const delay = Math.min(2147483647, Math.max(0, earliest - Date.now()))
      this.timer = setTimeout(() => this.tick().catch((error) => this.log('', error.message)), delay)
    }
  }

  async tick() {
    const now = Date.now()
    for (const [id, entry] of this.routines) {
      if (entry.invalid) continue
      const due = new Date(this.state.routines[id]?.nextRunAt || 0).getTime()
      if (due && due <= now && entry.routine.enabled && !this.state.routines[id]?.paused) {
        this.state.routines[id].nextRunAt = nextRunAt(entry.routine, new Date(now + 1000))?.toISOString() || null
        if (entry.routine.trigger.kind === 'at') entry.routine.enabled = false
        await this.run(id, entry.routine.trigger.kind)
      }
    }
    await saveState(this.paths.stateFile, this.state)
    this.scheduleTimer()
  }

  async run(id, trigger = 'manual', payload) {
    const entry = this.routines.get(id)
    if (!entry) throw new Error(`routine not found: ${id}`)
    if (entry.invalid) throw new Error(`routine invalid: ${entry.invalid}`)
    const routine = entry.routine
    const routineState = this.state.routines[id] ||= {}
    if (routineState.paused) throw new Error(`routine paused: ${id}`)
    if (this.running.has(id)) return await this.recordSkip(routine, trigger, 'skipped_overlap')
    if (this.running.size >= 2) return await this.recordSkip(routine, trigger, 'skipped_busy')
    this.running.add(id)
    const runs = await readRuns(this.paths.runsDir, id, 1)
    const runNumber = (routineState.runCount || 0) + 1
    const runId = crypto.randomUUID()
    routineState.runCount = runNumber
    const marker = { run_id: runId, routine_id: id, trigger, started_at: new Date().toISOString() }
    await this.addMarker(marker)
    await saveState(this.paths.stateFile, this.state)
    try {
      const result = await executeRun({ session: this.session, routine, runId, runNumber, lastRun: runs.at(-1), notesPath: path.join(this.paths.notesDir, `${id}.md`), payload })
      Object.assign(marker, { workspace_id: result.workspaceId, tab_id: result.tabId, pane_id: result.paneId })
      const liveState = this.state.routines[id] ||= {}
      const failureDecision = applyFailurePolicy(liveState, result.status, routine.failure)
      Object.assign(liveState, failureDecision.state)
      const record = { ts: new Date().toISOString(), run_id: runId, routine_id: id, trigger, status: result.status, duration_ms: result.durationMs, summary: result.summary, output_tail: result.outputTail, workspace_id: result.workspaceId, tab_id: result.tabId, pane_id: result.paneId, next_run_at: liveState.nextRunAt || null }
      await appendRun(this.paths.runsDir, record)
      await this.log(id, `${trigger} ${result.status} run=${runId}`)
      if (shouldNotify(routine, result.status, failureDecision)) await notify(this.session, routine, result.status, result.durationMs)
      await this.applyRetention(routine)
      await saveState(this.paths.stateFile, this.state)
      await this.removeMarker(runId)
      return record
    } finally {
      this.running.delete(id)
    }
  }

  async recordSkip(routine, trigger, status) {
    const record = { ts: new Date().toISOString(), run_id: crypto.randomUUID(), routine_id: routine.id, trigger, status, duration_ms: 0, summary: status, next_run_at: this.state.routines[routine.id]?.nextRunAt || null }
    await appendRun(this.paths.runsDir, record)
    await this.log(routine.id, `${trigger} ${status}`)
    return record
  }

  async applyRetention(routine) {
    const runs = await readRuns(this.paths.runsDir, routine.id, 2000)
    const tabs = runs.filter((run) => run.tab_id).map((run) => run.tab_id)
    const unique = [...new Set(tabs)]
    for (const tabId of unique.slice(0, Math.max(0, unique.length - routine.run.keep_runs))) {
      try {
        const { herdrRequest } = await import('./lib/herdr.js')
        await herdrRequest(this.session, 'tab.close', { tab_id: tabId })
      } catch (error) { await this.log(routine.id, `tab.close ${tabId}: ${error.message}`) }
    }
  }

  async command(request) {
    if (request.cmd === 'status') return { ok: true, pid: process.pid, session: this.session, running: [...this.running] }
    if (request.cmd === 'list') return { ok: true, routines: [...this.routines].map(([id, entry]) => ({ id, invalid: entry.invalid, routine: entry.routine, state: this.state.routines[id] || {} })) }
    if (request.cmd === 'overview') {
      const routines = []
      for (const [id, entry] of this.routines) {
        const runs = await readRuns(this.paths.runsDir, id, 20)
        routines.push({ id, invalid: entry.invalid, routine: entry.routine, state: this.state.routines[id] || {}, isRunning: this.running.has(id), runs })
      }
      return { ok: true, routines }
    }
    if (request.cmd === 'runs') return { ok: true, runs: await readRuns(this.paths.runsDir, request.id, request.n || 20) }
    if (request.cmd === 'reload') { await this.reload(); return { ok: true } }
    if (request.cmd === 'run') return { ok: true, run: await this.run(request.id, 'manual') }
    if (request.cmd === 'fire') {
      const routine = this.routines.get(request.id)?.routine
      if (!routine?.fire || !constantTimeToken(routine.fire.token, request.token)) throw new Error('invalid fire token')
      return { ok: true, run: await this.run(request.id, 'fire', request.payload) }
    }
    if (request.cmd === 'pause' || request.cmd === 'resume') {
      const state = this.state.routines[request.id] ||= {}
      if (request.cmd === 'pause') state.paused = 'manual'
      else { delete state.paused; state.nextRunAt = nextRunAt(this.routines.get(request.id)?.routine, new Date())?.toISOString() || null }
      await saveState(this.paths.stateFile, this.state)
      this.scheduleTimer()
      return { ok: true }
    }
    if (request.cmd === 'stop') { setImmediate(() => this.stop()); return { ok: true } }
    throw new Error(`unknown command: ${request.cmd}`)
  }

  async startControlServer() {
    try { await fs.unlink(this.paths.socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let text = ''
      socket.on('error', () => {})
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => { text += chunk })
      socket.on('end', async () => {
        try { socket.end(`${JSON.stringify(await this.command(JSON.parse(text.trim())))}\n`) }
        catch (error) { socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`) }
      })
    })
    this.server.on('error', (error) => this.log('', `ctl server: ${error.message}`))
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.paths.socketPath, resolve) })
    await fs.writeFile(this.paths.socketMapFile, `${this.paths.socketPath}\n`)
  }

  async startHttpServer() {
    try {
      const config = parse(await fs.readFile(path.join(this.paths.configDir, '_daemon.toml'), 'utf8'))
      if (!config.http?.port) return
      this.httpServer = http.createServer(async (request, response) => {
        request.on('error', () => {})
        response.on('error', () => {})
        const match = /^\/fire\/([^/]+)$/.exec(request.url || '')
        if (request.method !== 'POST' || !match) { response.writeHead(404).end(); return }
        let body = ''
        request.on('data', (chunk) => { body += chunk })
        request.on('end', async () => {
          try {
            const token = (request.headers.authorization || '').replace(/^Bearer /, '')
            const result = await this.command({ cmd: 'fire', id: match[1], token, payload: body ? JSON.parse(body) : undefined })
            response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
          } catch (error) { response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message })) }
        })
      })
      await new Promise((resolve, reject) => { this.httpServer.once('error', reject); this.httpServer.listen(config.http.port, '127.0.0.1', resolve) })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }

  async stop() {
    if (this.isStopping) return
    this.isStopping = true
    clearTimeout(this.timer)
    clearInterval(this.pollTimer)
    await new Promise((resolve) => this.server?.close(resolve) || resolve())
    await new Promise((resolve) => this.httpServer?.close(resolve) || resolve())
    try { await fs.unlink(this.paths.socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = new RoutineDaemon()
  await daemon.initialize()
  process.on('SIGTERM', () => daemon.stop().then(() => process.exit(0)))
  process.on('SIGINT', () => daemon.stop().then(() => process.exit(0)))
}
