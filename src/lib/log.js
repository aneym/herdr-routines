import fs from 'node:fs/promises'

export async function logLine(file, id, message) {
  await fs.appendFile(file, `${new Date().toISOString()} [${id || 'daemon'}] ${message.replaceAll('\n', ' ')}\n`)
}
