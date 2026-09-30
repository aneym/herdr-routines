import test from 'node:test'
import assert from 'node:assert/strict'
import { nextRunAt, jitterSeconds, accountMissed } from '../src/lib/schedule.js'
import { validateRoutine } from '../src/lib/routines.js'
import { classifyOutcome, lastMeaningfulLine } from '../src/lib/outcome.js'
import { assemblePreamble } from '../src/lib/preamble.js'
import { applyFailurePolicy } from '../src/lib/failure.js'
import { monitorRun } from '../src/lib/executor.js'

const base = validateRoutine('daily', { name: 'Daily', agent: 'stubagent', prompt: 'work', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' } })

test('cron respects timezone and deterministic jitter', () => {
  const first = nextRunAt(base, new Date('2026-01-15T13:59:00Z'))
  assert.equal(first.getUTCHours(), 14)
  assert.equal(first.getUTCSeconds(), jitterSeconds('daily'))
  assert.equal(jitterSeconds('daily'), jitterSeconds('daily'))
})

test('cron crosses DST', () => {
  const before = nextRunAt(base, new Date('2026-03-07T15:00:00Z'))
  const after = nextRunAt(base, before)
  assert.equal(after.getUTCHours(), 13)
})

test('missed intervals aggregate once', () => {
  const routine = validateRoutine('i', { name: 'I', agent: 'a', prompt: 'p', trigger: { kind: 'interval', every: '1h' } })
  const result = accountMissed(routine, '2026-01-01T00:00:00Z', new Date('2026-01-01T03:01:00Z'))
  assert.equal(result.missedCount, 4)
})

test('validation defaults and bounds agent detection timeout', () => {
  assert.equal(validateRoutine('x', { name: 'X', agent: 'a', prompt: 'p', trigger: { kind: 'manual' } }).run.detect_timeout_seconds, 120)
  assert.equal(validateRoutine('x', { name: 'X', agent: 'a', prompt: 'p', trigger: { kind: 'manual' }, run: { detect_timeout_seconds: 180 } }).run.detect_timeout_seconds, 180)
  assert.throws(() => validateRoutine('x', { name: 'X', agent: 'a', prompt: 'p', trigger: { kind: 'manual' }, run: { detect_timeout_seconds: 9 } }), /at least 10/)
})

test('validation rejects unknowns and unsupported session target', () => {
  assert.throws(() => validateRoutine('x', { name: 'X', agent: 'a', prompt: 'p', wat: 1, trigger: { kind: 'manual' } }), /unknown key/)
  assert.throws(() => validateRoutine('x', { name: 'X', agent: 'a', prompt: 'p', trigger: { kind: 'manual' }, run: { target: 'session:key' } }), /not in v1/)
})

test('outcome matrix', () => {
  assert.equal(classifyOutcome({ status: 'idle', tail: 'ROUTINE_OK', okToken: 'ROUTINE_OK' }), 'ok')
  assert.equal(classifyOutcome({ status: 'idle', tail: 'plain', okToken: 'OK' }), 'ok_untagged')
  assert.equal(classifyOutcome({ status: 'idle', tail: 'ROUTINE_NOOP', noopToken: 'ROUTINE_NOOP' }), 'noop')
  assert.equal(classifyOutcome({ error: new Error('dead') }), 'fail')
  assert.equal(classifyOutcome({ waitTimedOut: true }), 'timeout')
  assert.equal(classifyOutcome({ status: 'blocked' }), 'blocked')
})

test('monitor classifier resolves an exited pane without hanging', async () => {
  const result = await monitorRun({ session: 'missing-test-session', paneId: 'w1:p1', timeoutMs: 1000, pollMs: 1 })
  assert.match(result.error.message, /agent exited/)
})

test('preamble includes memory, prior run, watch and payload', () => {
  const routine = validateRoutine('w', { name: 'W', agent: 'a', prompt: 'scan', trigger: { kind: 'watch', every: '1h' } })
  const text = assemblePreamble({ routine, runNumber: 2, lastRun: { status: 'ok', ts: 'then', summary: 'done' }, notesPath: '/notes/w.md', payload: { value: 1 } })
  assert.match(text, /read it first/)
  assert.match(text, /nothing meaningful changed/)
  assert.match(text, /"value": 1/)
})

test('failure policy thresholds, renotify and auto pause', () => {
  const config = { notify_after: 3, renotify_hours: 8, auto_pause_after_days: 7 }
  let result = applyFailurePolicy({}, 'fail', config, new Date('2026-01-01T00:00:00Z'))
  result = applyFailurePolicy(result.state, 'fail', config, new Date('2026-01-01T01:00:00Z'))
  result = applyFailurePolicy(result.state, 'fail', config, new Date('2026-01-01T02:00:00Z'))
  assert.equal(result.shouldNotifyFailure, true)
  result = applyFailurePolicy(result.state, 'fail', config, new Date('2026-01-08T01:00:00Z'))
  assert.equal(result.didAutoPause, true)
  assert.equal(applyFailurePolicy(result.state, 'ok', config).state.failureStreak, 0)
})

// Regression: real Claude Code pane — token mid-tail, TUI chrome after the
// reply, and the echoed prompt mentioning the token mid-sentence (2026-08-01
// live smoke misclassified this as ok_untagged).
test('classifyOutcome finds token above TUI chrome, ignores echoed prompt', () => {
  const tail = [
    '❯ [herdr routine: disk-watch]',
    '  End your reply with ROUTINE_OK if all good, ROUTINE_NOOP if there was nothing to do, or a short failure summary',
    '  otherwise.',
    '  ...update your notes with today\'s numbers and end with',
    '  ROUTINE_NOOP. Never delete anything; report only.',
    '⏺ Disk health check done — both metrics are within thresholds.',
    '  ROUTINE_NOOP',
    '✻ Churned for 38s · 2 messages hidden (/focus to show)',
    '───────────────',
    '❯',
    '───────────────',
    '  ○○○○○ 8% │ Fable 5 │ $1.98 │ ⎇ main',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')
  assert.equal(
    classifyOutcome({ status: 'idle', tail, okToken: 'ROUTINE_OK', noopToken: 'ROUTINE_NOOP' }),
    'noop'
  )
  assert.equal(
    lastMeaningfulLine(tail, 200, ['ROUTINE_OK', 'ROUTINE_NOOP']),
    'Disk health check done — both metrics are within thresholds.'
  )
})

test('routine summary selects the last assistant message, not wrapped tails or chrome', () => {
  const cases = [
    {
      tail: [
        '⏺ Checked the routine runs and',
        '  updated the notes. The report was',
        '  posted.',
        '  ROUTINE_OK',
        '⎇ main · ┄┄┄┄ · Fable 5.1',
        'paste again to expand',
      ],
      expected: 'Checked the routine runs and updated the notes. The report was posted.',
    },
    {
      tail: ['⏺ Disk fine, notes updated.', '', '⏺ ROUTINE_NOOP'],
      expected: 'Disk fine, notes updated.',
    },
    {
      tail: [
        'Nothing deleted.',
        '⎇ main · ┄┄┄┄ · Fable 5.1',
        '◯ contrib-sweep Read-only sweep idle',
        '○ other-agent idle',
        'Enter to confirm · Esc to cancel',
        'focus',
        '╭── ┄━ │ ╮╰╯',
        '⏵⏵ bypass permissions on',
        '  paste again to expand (hint)',
      ],
      expected: 'Nothing deleted.',
    },
    {
      tail: ['⏺ Old reply.', '', '⏺ Latest reply', '  continued. ROUTINE_OK', '⏺ After the outcome.'],
      expected: 'Latest reply continued.',
    },
    {
      tail: ['⏺ First reply.', '', '⏺ Latest reply', '  continued.', '❯ Next prompt'],
      expected: 'Latest reply continued.',
    },
    {
      tail: ['⏺ Reply.', '', 'Unrelated text.'],
      expected: 'Reply.',
    },
    {
      tail: ['⏺ Reply.', '⎇ main', 'Unrelated text.'],
      expected: 'Reply.',
    },
    {
      tail: ['⏺ Reply. ROUTINE_OK'],
      expected: 'Reply.',
    },
  ]
  for (const { tail, expected } of cases) {
    assert.equal(lastMeaningfulLine(tail.join('\n'), 200, ['ROUTINE_OK', 'ROUTINE_NOOP']), expected)
  }
  assert.equal(lastMeaningfulLine(`⏺ ${'a'.repeat(210)}\nROUTINE_OK`, 200, ['ROUTINE_OK']), 'a'.repeat(200))
})
