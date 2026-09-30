const CHROME_PATTERN = /^(─{3,}|⏵⏵|✻ |❯$|○+ |◯ |⎇ |Enter to confirm)|│.*%|% │|paste again to expand|^focus$|^[\s─-╿]+$/

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
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const outcomeIndex = Math.max(...tokens.map((token) => tokenPosition(lines, token)), -1)
  const end = outcomeIndex >= 0 ? outcomeIndex : lines.length - 1
  const trailingToken = (line) => tokens.find((token) => token && (line === token || line.endsWith(` ${token}`)))

  for (let index = end; index >= 0; index--) {
    if (!lines[index].startsWith('⏺ ')) continue
    const parts = []
    for (let next = index; next <= end; next++) {
      let line = next === index ? lines[next].slice(2).trim() : lines[next]
      if (!line || CHROME_PATTERN.test(line) || line.startsWith('⏺ ') || line.startsWith('❯')) break
      const token = trailingToken(line)
      if (token) line = line.slice(0, -token.length).trim()
      if (line) parts.push(line)
      if (token) break
    }
    const message = parts.join(' ').trim()
    if (message) return message.slice(0, maxLength)
  }

  const meaningful = lines
    .filter(Boolean)
    .filter((line) => !CHROME_PATTERN.test(line))
    .filter((line) => !line.includes('End your reply with'))
    .filter((line) => !trailingToken(line))
  return (meaningful.at(-1) || '').slice(0, maxLength)
}
