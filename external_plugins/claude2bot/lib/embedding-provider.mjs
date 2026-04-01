/**
 * embedding-provider.mjs — Delegates embedding to Python ML service.
 *
 * Reads ML service port from $TMPDIR/claude2bot/ml-port.
 * Falls back to local ONNX model if ML service is unavailable.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const LOCAL_MODEL = 'Xenova/bge-m3'
const LOCAL_DIMS = 1024
const ML_PORT_FILE = join(tmpdir(), 'claude2bot', 'ml-port')
const ML_TIMEOUT_MS = Number(process.env.CLAUDE2BOT_ML_TIMEOUT_MS || 15000)
const ML_WARMUP_RETRIES = 3
const ML_WARMUP_DELAY_MS = 1500

let extractorPromise = null
let cachedDims = null
let lastProviderSwitch = null
let mlServiceAvailable = null  // null = unknown, true/false = tested

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function readMlPort() {
  try {
    return Number(readFileSync(ML_PORT_FILE, 'utf8').trim())
  } catch {
    return 0
  }
}

function fallbackToLocal(reason, error = null) {
  if (mlServiceAvailable === false) return  // already fallen back
  const previousModelId = 'ml-service/bge-m3'
  mlServiceAvailable = false
  extractorPromise = null
  cachedDims = LOCAL_DIMS
  lastProviderSwitch = {
    phase: 'runtime',
    previousModelId,
    currentModelId: LOCAL_MODEL,
    reason,
  }
  const suffix = error instanceof Error ? `: ${error.message}` : ''
  process.stderr.write(`[embed] ${reason}; falling back to local ${LOCAL_MODEL}${suffix}\n`)
}

export function configureEmbedding(config = {}) {
  // Reset cached state — ML service port may have changed
  extractorPromise = null
  cachedDims = null
  mlServiceAvailable = null
}

async function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers')
      env.allowLocalModels = false
      return pipeline('feature-extraction', LOCAL_MODEL)
    })()
  }
  return extractorPromise
}

async function mlEmbed(text, timeoutMs = ML_TIMEOUT_MS) {
  const port = readMlPort()
  if (!port) throw new Error('ML service port file not found')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`ML service ${resp.status}: ${resp.statusText}`)
    const data = await resp.json()
    return new Float32Array(data.vector)
  } finally {
    clearTimeout(timeout)
  }
}

export function getEmbeddingModelId() {
  return mlServiceAvailable === false ? LOCAL_MODEL : 'ml-service/bge-m3'
}

export function getEmbeddingDims() {
  if (cachedDims) return cachedDims
  return mlServiceAvailable === false ? LOCAL_DIMS : LOCAL_DIMS
}

export function consumeProviderSwitchEvent() {
  const event = lastProviderSwitch
  lastProviderSwitch = null
  return event
}

export async function warmupEmbeddingProvider() {
  // Try ML service first
  for (let attempt = 1; attempt <= ML_WARMUP_RETRIES; attempt += 1) {
    try {
      const vec = await mlEmbed('warmup')
      cachedDims = vec.length
      mlServiceAvailable = true
      process.stderr.write(`[embed] ML service connected. dims=${cachedDims}\n`)
      return true
    } catch (e) {
      if (attempt < ML_WARMUP_RETRIES) {
        process.stderr.write(`[embed] ML service warmup retry ${attempt}/${ML_WARMUP_RETRIES}: ${e.message}\n`)
        await sleep(ML_WARMUP_DELAY_MS)
      }
    }
  }

  // Fall back to local ONNX
  fallbackToLocal('ML service warmup failed')
  const extractor = await loadExtractor()
  await extractor('warmup', { pooling: 'mean', normalize: true })
  cachedDims = LOCAL_DIMS
  return true
}

export async function embedText(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return []

  // Try ML service if available (or unknown)
  if (mlServiceAvailable !== false) {
    try {
      const vec = await mlEmbed(clean)
      if (!cachedDims && vec.length > 0) cachedDims = vec.length
      mlServiceAvailable = true
      return Array.from(vec)
    } catch (e) {
      fallbackToLocal('ML service embedding request failed', e)
    }
  }

  // Local ONNX fallback
  const extractor = await loadExtractor()
  const output = await extractor(clean, { pooling: 'mean', normalize: true })
  cachedDims = LOCAL_DIMS
  return Array.from(output.data ?? [])
}
