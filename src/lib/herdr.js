import crypto from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

function socketPath(session) {
  if (session === 'default' && process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH
  if (session === 'default') return path.join(os.homedir(), '.config/herdr/herdr.sock')
  return path.join(os.homedir(), '.config/herdr/sessions', session, 'herdr.sock')
}

export async function herdrRequest(session, method, params = {}) {
  const id = crypto.randomUUID()
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(session))
    let text = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.end(`${JSON.stringify({ id, method, params })}\n`))
    socket.on('data', (chunk) => { text += chunk })
    socket.on('error', (error) => reject(new Error(`${method}: ${error.message}`, { cause: error })))
    socket.on('end', () => {
      try {
        const messages = text.trim().split('\n').filter(Boolean).map(JSON.parse)
        const response = messages.at(-1)
        if (response.error) return reject(new Error(`${method}: ${response.error.message}`))
        resolve(response.result)
      } catch (error) {
        reject(new Error(`${method}: invalid response`, { cause: error }))
      }
    })
  })
}

export function constantTimeToken(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}
