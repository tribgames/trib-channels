const LOCAL_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
const OLLAMA_DEFAULT_MODEL = 'nomic-embed-text'
const OLLAMA_URL = process.env.CLAUDE2BOT_OLLAMA_URL || 'http://localhost:11434'

let provider = process.env.CLAUDE2BOT_EMBED_PROVIDER || 'local'  // 'local' | 'ollama'
let ollamaModel = process.env.CLAUDE2BOT_OLLAMA_EMBED_MODEL || OLLAMA_DEFAULT_MODEL
let extractorPromise = null
let warmupPromise = null
let cachedDims = null
let lastProviderSwitch = null

function switchProviderToLocal(reason, phase = 'runtime') {
  const previousModelId = provider === 'ollama' ? `ollama/${ollamaModel}` : provider
  if (provider !== 'local') {
    provider = 'local'
    warmupPromise = null
    cachedDims = 384
    lastProviderSwitch = {
      previousModelId,
      currentModelId: LOCAL_MODEL,
      phase,
      reason: String(reason ?? ''),
      ts: new Date().toISOString(),
    }
    process.stderr.write(`[embed] ${phase} provider switch: ${previousModelId} -> ${LOCAL_MODEL} (${reason})\n`)
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

async function ollamaEmbed(text) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
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
}

export function getEmbeddingModelId() {
  return provider === 'ollama' ? `ollama/${ollamaModel}` : LOCAL_MODEL
}

export function getEmbeddingDims() {
  if (cachedDims) return cachedDims
  return provider === 'ollama' ? 768 : 384
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
        try {
          const vec = await ollamaEmbed('warmup')
          cachedDims = vec.length
          return true
        } catch (e) {
          switchProviderToLocal(e.message, 'warmup')
        }
      }
      const extractor = await loadExtractor()
      await extractor('warmup', { pooling: 'mean', normalize: true })
      cachedDims = 384
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
      switchProviderToLocal(e.message, 'runtime')
    }
  }

  const extractor = await loadExtractor()
  const output = await extractor(clean, { pooling: 'mean', normalize: true })
  return Array.from(output.data ?? [])
}
