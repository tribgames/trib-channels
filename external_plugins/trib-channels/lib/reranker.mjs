import { AutoTokenizer, AutoModelForSequenceClassification } from '@xenova/transformers'

let _tokenizer = null
let _model = null
let _loading = null

const MODEL_ID = 'Xenova/bge-reranker-large'

async function ensureModel() {
  if (_model && _tokenizer) return
  if (_loading) return _loading
  _loading = (async () => {
    _tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)
    _model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID)
    _loading = null
  })()
  return _loading
}

export async function crossEncoderRerank(query, candidates, options = {}) {
  const limit = Math.min(Number(options.limit ?? 5), candidates.length)
  if (limit === 0) return []

  await ensureModel()

  const scored = []
  for (const item of candidates.slice(0, limit)) {
    const text = String(item.content ?? item.text ?? '').slice(0, 300)
    if (!text) continue
    const inputs = await _tokenizer(query, { text_pair: text, padding: true, truncation: true, max_length: 512 })
    const output = await _model(inputs)
    scored.push({ ...item, reranker_score: output.logits.data[0] })
  }

  return scored.sort((a, b) => Number(b.reranker_score) - Number(a.reranker_score))
}

export function isRerankerAvailable() {
  return _model !== null && _tokenizer !== null
}

// Pre-warm on first import (non-blocking)
ensureModel().catch(() => {})
