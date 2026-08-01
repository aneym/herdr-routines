import fs from 'node:fs/promises'
import path from 'node:path'
import { assemblePreamble } from './preamble.js'
import { classifyOutcome, lastMeaningfulLine } from './outcome.js'
import { herdrRequest } from './herdr.js'

async function rosterEntry(agent) {
  const file = process.env.HERDR_ROUTINES_ROSTER || path.join(process.env.HOME, '.config/herdr/spawn-agents.conf')
  const text = await fs.readFile(file, 'utf8')
  for (const line of text.split('\n')) {
    const [label, kind, command] = line.trim().split('|')
    if (label === agent) return { kind, command }
  }
  throw new Error(`agent not found in roster: ${agent}`)
}

async function waitForReady(session, paneId, expectedKind, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const result = await herdrRequest(session, 'agent.get', { target: paneId })
      const agent = result.agent
      if ((process.env.HERDR_ROUTINES_STUB_MODE === '1' || agent?.interactive_ready) && ['idle', 'working', 'blocked'].includes(agent?.agent_status)) return agent
    } catch (error) {
      if (!error.message.includes('agent target') || !error.message.includes('not found')) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`agent detection timed out for ${paneId}`)
}

async function ensureWorkspace(session, label) {
  const listed = await herdrRequest(session, 'workspace.list')
  const existing = listed.workspaces.find((workspace) => workspace.label === label)
  if (existing) return existing.workspace_id
  const created = await herdrRequest(session, 'workspace.create', { label, focus: false })
  return created.workspace.workspace_id
}

async function readTail(session, paneId) {
  try {
    const result = await herdrRequest(session, 'agent.read', { target: paneId, source: 'visible', format: 'text' })
    return result.read?.text || ''
  } catch {
    const result = await herdrRequest(session, 'pane.read', { pane_id: paneId, source: 'visible', format: 'text' })
    return result.read?.text || ''
  }
}

export async function monitorRun({ session, paneId, timeoutMs, pollMs = 200 }) {
  const deadline = Date.now() + timeoutMs
  let hasStarted = false
  while (Date.now() < deadline) {
    try {
      await herdrRequest(session, 'pane.get', { pane_id: paneId })
      const result = await herdrRequest(session, 'agent.get', { target: paneId })
      const processResult = await herdrRequest(session, 'pane.process_info', { pane_id: paneId })
      const processes = processResult.process_info?.foreground_processes || []
      const isShellOnly = processes.length > 0 && processes.every((process) => /^(zsh|bash|sh|fish)$/.test(process.name))
      const status = result.agent.agent_status
      if (hasStarted && status === 'working' && isShellOnly) return { error: new Error('agent exited') }
      if (status === 'working') hasStarted = true
      if (status === 'blocked') return { status }
      if (status === 'done') return { status }
      if (hasStarted && status === 'idle') return { status }
    } catch (error) {
      if (/not found|exited|closed|ENOENT|ECONNREFUSED/i.test(error.message)) return { error: new Error('agent exited') }
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return { waitTimedOut: true }
}

export async function planRun({ session, routine, runNumber, lastRun, notesPath, payload }) {
  const prompt = assemblePreamble({ routine, runNumber, lastRun, notesPath, payload })
  if (routine.run.target.startsWith('pane:')) {
    return { prompt, calls: [{ method: 'agent.get' }, { method: 'agent.prompt' }, { method: 'agent.read' }] }
  }
  return { prompt, calls: [{ method: 'workspace.list/create' }, { method: 'tab.create' }, { method: 'pane.send_input or agent.start' }, { method: 'agent.prompt' }, { method: 'agent.read' }] }
}

export async function executeRun(context) {
  const { session, routine, runId, runNumber, lastRun, notesPath, payload } = context
  const started = Date.now()
  const { prompt } = await planRun(context)
  let workspaceId
  let tabId
  let paneId
  let waitTimedOut = false
  let error
  let agentStatus
  try {
    if (routine.run.target.startsWith('pane:')) {
      paneId = routine.run.target.slice(5)
      const result = await herdrRequest(session, 'agent.get', { target: paneId })
      if (result.agent.agent_status !== 'idle') throw new Error(`target pane is busy: ${paneId}`)
      workspaceId = result.agent.workspace_id
      tabId = result.agent.tab_id
    } else {
      workspaceId = await ensureWorkspace(session, routine.run.workspace)
      const created = await herdrRequest(session, 'tab.create', {
        workspace_id: workspaceId,
        cwd: routine.run.cwd,
        focus: false,
        label: `${routine.name} #${runNumber}`,
        env: {
          HERDR_ROUTINE_ID: routine.id,
          HERDR_ROUTINE_RUN: runId,
          HERDR_ROUTINE_NOTES: notesPath,
          HERDR_SESSION: session,
          ...(process.env.HERDR_ROUTINES_STUB_MODE === '1' ? { STUBAGENT_CAPTURE: process.env.STUBAGENT_CAPTURE || '' } : {}),
        },
      })
      tabId = created.tab.tab_id
      paneId = created.root_pane.pane_id
      const entry = await rosterEntry(routine.agent)
      if (entry.command) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await herdrRequest(session, 'pane.send_input', { pane_id: paneId, text: entry.command, keys: ['Enter'] })
        await waitForReady(session, paneId, entry.kind)
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await herdrRequest(session, 'agent.start', { name: entry.kind, kind: entry.kind, pane_id: paneId, args: [], timeout_ms: 60000 })
        await waitForReady(session, paneId, entry.kind)
      }
    }
    try {
      const timeoutMs = routine.run.timeout_minutes * 60000
      if (process.env.HERDR_ROUTINES_STUB_MODE === '1') {
        await herdrRequest(session, 'pane.send_input', { pane_id: paneId, text: prompt, keys: ['Enter'] })
      } else {
        herdrRequest(session, 'agent.prompt', {
          target: paneId,
          text: prompt,
          wait: { until: ['idle', 'blocked'], timeout_ms: timeoutMs },
        }).catch(() => {})
      }
      const monitored = await monitorRun({ session, paneId, timeoutMs })
      agentStatus = monitored.status
      waitTimedOut = monitored.waitTimedOut || false
      if (monitored.error) throw monitored.error
    } catch (promptError) {
      if (/timeout/i.test(promptError.message)) waitTimedOut = true
      else throw promptError
    }
    if (!error && !waitTimedOut) {
      const result = await herdrRequest(session, 'agent.get', { target: paneId })
      agentStatus = result.agent.agent_status
    }
  } catch (caught) {
    error = caught
  }
  let tail = ''
  if (paneId) {
    try { tail = await readTail(session, paneId) } catch (readError) { if (!error) error = readError }
  }
  const status = classifyOutcome({ waitTimedOut, status: agentStatus, tail, okToken: routine.delivery.ok_token, noopToken: routine.delivery.noop_token, error })
  return {
    status,
    durationMs: Date.now() - started,
    summary: error ? error.message.slice(0, 200) : lastMeaningfulLine(tail),
    outputTail: tail.slice(-8000),
    workspaceId,
    tabId,
    paneId,
  }
}
