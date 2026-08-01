export function classifyOutcome({ waitTimedOut = false, status, tail = '', okToken, noopToken, error }) {
  if (waitTimedOut) return 'timeout'
  if (error) return 'fail'
  if (status === 'blocked') return 'blocked'
  const lines = tail.split(/\r?\n/).filter((line) => !line.includes('End your reply with'))
  const scanned = lines.slice(-4).join('\n')
  const noopIndex = noopToken ? scanned.lastIndexOf(noopToken) : -1
  const okIndex = okToken ? scanned.lastIndexOf(okToken) : -1
  if (noopIndex > okIndex) return 'noop'
  if (okIndex >= 0) return 'ok'
  if (status === 'idle' || status === 'done') return 'ok_untagged'
  return 'fail'
}

export function lastMeaningfulLine(text, maxLength = 200) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return (lines.at(-1) || '').slice(0, maxLength)
}
