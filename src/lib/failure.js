const FAILURES = new Set(['fail', 'timeout'])
const SUCCESSES = new Set(['ok', 'ok_untagged', 'noop'])

export function applyFailurePolicy(previous = {}, status, config, now = new Date()) {
  const state = { ...previous }
  if (SUCCESSES.has(status)) {
    state.failureStreak = 0
    delete state.failingSince
    delete state.lastFailureNotificationAt
    return { state, shouldNotifyFailure: false, didAutoPause: false }
  }
  if (!FAILURES.has(status)) return { state, shouldNotifyFailure: false, didAutoPause: false }
  state.failureStreak = (state.failureStreak || 0) + 1
  state.failingSince ||= now.toISOString()
  const lastNotify = state.lastFailureNotificationAt ? new Date(state.lastFailureNotificationAt) : null
  const renotifyMs = config.renotify_hours * 60 * 60 * 1000
  const thresholdReached = state.failureStreak >= config.notify_after
  const shouldNotifyFailure = thresholdReached && (!lastNotify || now - lastNotify >= renotifyMs)
  if (shouldNotifyFailure) state.lastFailureNotificationAt = now.toISOString()
  const failingMs = now - new Date(state.failingSince)
  const didAutoPause = !state.paused && failingMs >= config.auto_pause_after_days * 86400000
  if (didAutoPause) state.paused = 'auto'
  return { state, shouldNotifyFailure, didAutoPause }
}
