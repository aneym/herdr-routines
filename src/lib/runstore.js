import fs from 'node:fs/promises'
import path from 'node:path'

export async function appendRun(runsDir, record) {
  await fs.mkdir(runsDir, { recursive: true })
  const file = path.join(runsDir, `${record.routine_id}.jsonl`)
  await fs.appendFile(file, `${JSON.stringify(record)}\n`)
  const text = await fs.readFile(file, 'utf8')
  const lines = text.trimEnd().split('\n')
  if (lines.length > 2000) await fs.writeFile(file, `${lines.slice(-2000).join('\n')}\n`)
}

export async function readRuns(runsDir, id, count = 20) {
  try {
    const text = await fs.readFile(path.join(runsDir, `${id}.jsonl`), 'utf8')
    return text.trim().split('\n').filter(Boolean).map(JSON.parse).slice(-count)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
