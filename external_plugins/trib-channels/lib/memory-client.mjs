/**
 * memory-client.mjs — HTTP client for memory-service.
 *
 * Replaces direct memoryStore calls in server.ts with HTTP requests
 * to the memory-service process (runs on 127.0.0.1:3350-3357).
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT_FILE = path.join(os.tmpdir(), 'trib-memory', 'memory-port')

function getMemoryPort() {
  try {
    return Number(fs.readFileSync(PORT_FILE, 'utf8').trim()) || 3350
  } catch {
    return 3350
  }
}

/**
 * Send an HTTP request to the memory service.
 * @param {string} method - GET or POST
 * @param {string} endpoint - e.g. '/episode'
 * @param {object|null} body - JSON body for POST
 * @returns {Promise<object>}
 */
function memoryFetch(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const port = getMemoryPort()
    const payload = body ? JSON.stringify(body) : null
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
      timeout: 10_000,
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve({ raw: data })
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('memory-service timeout')) })
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Append an episode to the memory store.
 * @param {object} data - Episode fields (ts, backend, channelId, userId, userName, sessionId, role, kind, content, sourceRef)
 * @returns {Promise<{ok: boolean, id?: number}>}
 */
export async function appendEpisode(data) {
  try {
    return await memoryFetch('POST', '/episode', data)
  } catch (e) {
    process.stderr.write(`[memory-client] appendEpisode failed: ${e.message}\n`)
    return { ok: false }
  }
}

/**
 * Get memory hints for an inbound message.
 * @param {string} query - The message text
 * @param {object} options - Additional options (channelId, userId, skipLowSignal, etc.)
 * @returns {Promise<string>} Memory context block or empty string
 */
export async function getHints(query, options = {}) {
  try {
    const result = await memoryFetch('POST', '/hints', { query, options })
    return result.hints || ''
  } catch (e) {
    process.stderr.write(`[memory-client] getHints failed: ${e.message}\n`)
    return ''
  }
}

/**
 * Ingest a transcript file into the memory store.
 * @param {string} filePath - Absolute path to the transcript JSONL file
 * @returns {Promise<{ok: boolean}>}
 */
export async function ingestTranscript(filePath) {
  try {
    return await memoryFetch('POST', '/ingest-transcript', { filePath })
  } catch (e) {
    process.stderr.write(`[memory-client] ingestTranscript failed: ${e.message}\n`)
    return { ok: false }
  }
}

/**
 * Check if the memory service is healthy.
 * @returns {Promise<boolean>}
 */
export async function isHealthy() {
  try {
    const result = await memoryFetch('GET', '/health')
    return result.status === 'ok'
  } catch {
    return false
  }
}
