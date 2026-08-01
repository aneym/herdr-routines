import { Cron } from 'croner'
import { parseDuration } from './routines.js'

export function jitterSeconds(id) {
  let hash = 2166136261
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return Math.abs(hash >>> 0) % 121
}

function isTopOfHour(expression) {
  const fields = expression.trim().split(/\s+/)
  return fields.length === 5 && fields[0] === '0'
}

export function nextRunAt(routine, from = new Date()) {
  const trigger = routine.trigger
  if (!routine.enabled || trigger.kind === 'manual') return null
  if (trigger.kind === 'at') {
    const at = new Date(trigger.when)
    return at > from ? at : null
  }
  if (trigger.kind === 'interval' || trigger.kind === 'watch') return new Date(from.getTime() + parseDuration(trigger.every))
  const job = new Cron(trigger.expr, { timezone: trigger.tz, paused: true })
  const next = job.nextRun(from)
  if (next && isTopOfHour(trigger.expr)) next.setSeconds(next.getSeconds() + jitterSeconds(routine.id))
  return next
}

export function accountMissed(routine, persistedNext, now = new Date()) {
  if (!persistedNext) return { missedCount: 0, next: nextRunAt(routine, now) }
  const due = new Date(persistedNext)
  if (now - due <= 300000) return { missedCount: 0, next: due }
  let missedCount = 1
  if (['interval', 'watch'].includes(routine.trigger.kind)) missedCount = Math.max(1, Math.floor((now - due) / parseDuration(routine.trigger.every)) + 1)
  return { missedCount, next: nextRunAt(routine, now) }
}
