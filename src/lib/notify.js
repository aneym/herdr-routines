import { herdrRequest } from './herdr.js'

export function shouldNotify(routine, status, failureDecision = {}) {
  if (status === 'noop') return false
  if (failureDecision.didAutoPause || failureDecision.shouldNotifyFailure) return true
  if (['fail', 'timeout'].includes(status)) return false
  if (routine.delivery.notify === 'never') return false
  if (routine.delivery.notify === 'failure') return ['blocked'].includes(status)
  return true
}

export async function notify(session, routine, status, durationMs) {
  const seconds = Math.round(durationMs / 1000)
  const isGood = ['ok', 'ok_untagged'].includes(status)
  return await herdrRequest(session, 'notification.show', {
    title: `routine ${routine.name}: ${status} (${seconds}s)`,
    sound: isGood ? 'done' : 'request',
  })
}
