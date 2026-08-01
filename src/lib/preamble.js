export function assemblePreamble({ routine, runNumber, lastRun, notesPath, payload }) {
  const previous = lastRun
    ? `${lastRun.status}, ${lastRun.ts}, ${lastRun.summary || 'no summary'}`
    : 'none'
  const lines = [
    `[herdr routine: ${routine.id}]`,
    `Run #${runNumber}. Last run: ${previous}.`,
    `Your routine memory file is ${notesPath} — read it first; update it before finishing.`,
    `End your reply with ${routine.delivery.ok_token} if all good, ${routine.delivery.noop_token} if there was nothing to do, or a short failure summary otherwise.`,
  ]
  if (routine.trigger.kind === 'watch') {
    lines.push(`Compare findings against your notes; if nothing meaningful changed, update notes and end with ${routine.delivery.noop_token}.`)
  }
  if (payload !== undefined) lines.push(`Trigger payload:\n${JSON.stringify(payload, null, 2)}`)
  return `${lines.join('\n')}\n\n${routine.prompt}`
}
