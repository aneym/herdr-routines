const CHROME_PATTERN = /^(─{3,}|⏵⏵|✻ |❯$|○+ )|│.*%|% │/

function tokenPosition(lines, token) {
  if (!token) return -1
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim()
    // Agents are instructed to END the reply with the token, so it renders as
    // its own line or a line suffix. Echoed prompt text mentioning the token
    // mid-sentence (followed by punctuation) must not match.
    if (line === token || line.endsWith(` ${token}`)) return index
  }
  return -1
}

export function classifyOutcome({ waitTimedOut = false, status, tail = '', okToken, noopToken, error }) {
  if (waitTimedOut) return 'timeout'
  if (error) return 'fail'
  if (status === 'blocked') return 'blocked'
  const lines = tail.split(/\r?\n/).filter((line) => !line.includes('End your reply with'))
  const noopIndex = tokenPosition(lines, noopToken)
  const okIndex = tokenPosition(lines, okToken)
  if (noopIndex > okIndex) return 'noop'
  if (okIndex >= 0) return 'ok'
  if (status === 'idle' || status === 'done') return 'ok_untagged'
  return 'fail'
}

export function lastMeaningfulLine(text, maxLength = 200, tokens = []) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !CHROME_PATTERN.test(line))
    .filter((line) => !line.includes('End your reply with'))
    .filter((line) => !tokens.some((token) => token && (line === token || line.endsWith(` ${token}`))))
  return (lines.at(-1) || '').slice(0, maxLength)
}
