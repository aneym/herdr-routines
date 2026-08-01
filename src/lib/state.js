import fs from 'node:fs/promises'

export async function loadState(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { routines: {} }
    throw error
  }
}

export async function saveState(file, state) {
  await fs.mkdir(new URL('.', `file://${file}`).pathname, { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`)
  await fs.rename(temporary, file)
}
