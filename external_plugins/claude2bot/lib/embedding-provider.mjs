const LOCAL_MODEL = 'Xenova/bge-m3'
const LOCAL_DIMS = 1024
const OLLAMA_DEFAULT_MODEL = 'nomic-embed-text'
const OLLAMA_URL = process.env.CLAUDE2BOT_OLLAMA_URL || 'http://localhost:11434'
const OLLAMA_WARMUP_RETRIES = Number(process.env.CLAUDE2BOT_OLLAMA_WARMUP_RETRIES || 3)
const OLLAMA_WARMUP_DELAY_MS = Number(process.env.CLAUDE2BOT_OLLAMA_WARMUP_DELAY_MS || 1500)
const OLLAMA_WARMUP_TIMEOUT_MS = Number(process.env.CLAUDE2BOT_OLLAMA_WARMUP_TIMEOUT_MS || 12000)
const OLLAMA_EMBED_TIMEOUT_MS = Number(process.env.CLAUDE2BOT_OLLAMA_EMBED_TIMEOUT_MS || 20000)
const OLLAMA_EMBED_CONCURRENCY = 1

let provider = process.env.CLAUDE2BOT_EMBED_PROVIDER || 'local'  // 'local' | 'ollama'
let ollamaModel = process.env.CLAUDE2BOT_OLLAMA_EMBED_MODEL || OLLAMA_DEFAULT_MODEL
let extractorPromise = null
let warmupPromise = null
let cachedDims = null
let lastProviderSwitch = null
let ollamaActive = 0
const ollamaWaiters = []

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function fallbackToLocal(reason, error = null) {
  if (provider !== 'ollama') return
  const previousModelId = `ollama/${ollamaModel}`
  provider = 'local'
  extractorPromise = null
  warmupPromise = null
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

async function withOllamaSlot(work) {
  if (ollamaActive >= OLLAMA_EMBED_CONCURRENCY) {
    await new Promise(resolve => ollamaWaiters.push(resolve))
  }
  ollamaActive += 1
  try {
    return await work()
  } finally {
    ollamaActive = Math.max(0, ollamaActive - 1)
    const next = ollamaWaiters.shift()
    if (next) next()
  }
}

export function configureEmbedding(config = {}) {
  if (config.provider) provider = config.provider
  if (config.ollamaModel) ollamaModel = config.ollamaModel
  // Reset cached state on config change
  extractorPromise = null
  warmupPromise = null
  cachedDims = null
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

async function ollamaEmbed(text, timeoutMs = OLLAMA_EMBED_TIMEOUT_MS) {
  return withOllamaSlot(async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, prompt: text }),
        signal: controller.signal,
      })
      if (!resp.ok) throw new Error(`ollama ${resp.status}: ${resp.statusText}`)
      const data = await resp.json()
      return data.embedding ?? []
    } finally {
      clearTimeout(timeout)
    }
  })
}

export function getEmbeddingModelId() {
  return provider === 'ollama' ? `ollama/${ollamaModel}` : LOCAL_MODEL
}

export function getEmbeddingDims() {
  if (cachedDims) return cachedDims
  return provider === 'ollama' ? 768 : LOCAL_DIMS
}

export function consumeProviderSwitchEvent() {
  const event = lastProviderSwitch
  lastProviderSwitch = null
  return event
}

export async function warmupEmbeddingProvider() {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      if (provider === 'ollama') {
        let lastError = null
        for (let attempt = 1; attempt <= Math.max(1, OLLAMA_WARMUP_RETRIES); attempt += 1) {
          try {
            const vec = await ollamaEmbed('warmup', OLLAMA_WARMUP_TIMEOUT_MS)
            cachedDims = vec.length
            return true
          } catch (e) {
            lastError = e
            if (attempt < OLLAMA_WARMUP_RETRIES) {
              process.stderr.write(`[embed] ollama warmup retry ${attempt}/${OLLAMA_WARMUP_RETRIES} failed: ${e.message}\n`)
              await sleep(OLLAMA_WARMUP_DELAY_MS)
            }
          }
        }
        fallbackToLocal('ollama warmup failed', lastError)
        const extractor = await loadExtractor()
        await extractor('warmup', { pooling: 'mean', normalize: true })
        cachedDims = LOCAL_DIMS
        return true
      }
      const extractor = await loadExtractor()
      await extractor('warmup', { pooling: 'mean', normalize: true })
      cachedDims = LOCAL_DIMS
      return true
    })()
  }
  return warmupPromise
}

export async function embedText(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return []

  if (provider === 'ollama') {
    try {
      const vec = await ollamaEmbed(clean)
      if (!cachedDims && vec.length > 0) cachedDims = vec.length
      return vec
    } catch (e) {
      fallbackToLocal('ollama embedding request failed', e)
      const extractor = await loadExtractor()
      const output = await extractor(clean, { pooling: 'mean', normalize: true })
      cachedDims = LOCAL_DIMS
      return Array.from(output.data ?? [])
    }
  }

  const extractor = await loadExtractor()
  const output = await extractor(clean, { pooling: 'mean', normalize: true })
  return Array.from(output.data ?? [])
}
