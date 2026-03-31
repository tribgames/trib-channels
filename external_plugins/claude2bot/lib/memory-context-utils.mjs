import { cleanMemoryText } from './memory-extraction.mjs'

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0))
}

export function formatHintAge(ts, nowTs = Date.now()) {
  if (!ts) return ''
  const msTs = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : new Date(ts).getTime()
  const diff = nowTs - msTs
  if (diff < 0) return '0m'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function computeHintRelevance(item, options = {}) {
  const queryTokenCount = Math.max(1, Number(options.queryTokenCount ?? 1))
  const weighted = Number(item?.weighted_score)
  if (Number.isFinite(weighted)) return clamp01((-weighted + 0.15) / 1.35)
  const priority = Number(item?.priority_score)
  if (Number.isFinite(priority)) return clamp01(priority / 4.5)
  const rank = Number(item?.rankScore)
  if (Number.isFinite(rank)) return clamp01(rank / 5.5)
  const overlap = Number(item?.overlapCount ?? 0)
  return clamp01(overlap / Math.min(3, queryTokenCount))
}

export function shouldInjectHint(item, overrides = {}, options = {}) {
  const type = String(overrides.type ?? item?.type ?? 'episode')
  const queryTokenCount = Math.max(1, Number(options.queryTokenCount ?? 1))
  const confidence = clamp01(overrides.confidence ?? item?.confidence ?? item?.quality_score ?? item?.effectiveScore ?? 0)
  const relevance = clamp01(overrides.relevanceScore ?? computeHintRelevance(item, { queryTokenCount }))
  const overlap = clamp01(Number(item?.overlapCount ?? 0) / Math.min(3, queryTokenCount))
  const composite = Number((relevance * 0.58 + confidence * 0.27 + overlap * 0.15).toFixed(3))

  if (type === 'profile') return relevance >= 0.58 || composite >= 0.55 || confidence >= 0.68
  if (type === 'signal') return relevance >= 0.66 || composite >= 0.6 || (confidence >= 0.76 && overlap >= 0.2)
  if (type === 'task') return relevance >= 0.5 || composite >= 0.56 || (confidence >= 0.72 && overlap > 0)
  if (type === 'fact' || type === 'proposition') return relevance >= 0.62 || composite >= 0.58 || (confidence >= 0.84 && overlap > 0)
  return relevance >= 0.68 || composite >= 0.6
}

export function buildHintKey(item, overrides = {}) {
  const type = overrides.type ?? item?.type ?? 'episode'
  const rawText = String(overrides.text ?? item?.content ?? item?.text ?? item?.value ?? '').trim()
  if (!rawText) return ''
  const normalized = cleanMemoryText(rawText).toLowerCase().replace(/\s+/g, ' ').slice(0, 160)
  const signalSubtype = String(overrides.subtype ?? item?.subtype ?? item?.kind ?? '').toLowerCase().trim()
  if (type === 'signal') return `signal:${signalSubtype || normalized}`
  if (type === 'fact' || type === 'proposition') {
    const sourceFactId = Number(item?.source_fact_id ?? overrides.source_fact_id ?? 0)
    return sourceFactId > 0 ? `claim:${sourceFactId}` : `claim:${normalized}`
  }
  return `${type}:${normalized}`
}

export function formatHintTag(item, overrides = {}, options = {}) {
  const type = overrides.type ?? item?.type ?? 'episode'
  const attrs = [`type="${type}"`]
  const conf = overrides.confidence ?? item?.confidence ?? item?.quality_score ?? item?.effectiveScore
  if (conf != null) attrs.push(`confidence="${Number(conf).toFixed(2)}"`)
  const stage = overrides.stage ?? item?.stage ?? item?.status
  if (stage && (type === 'task' || type === 'signal')) attrs.push(`stage="${stage}"`)
  const ts = overrides.ts ?? item?.updated_at ?? item?.last_seen ?? item?.source_ts ?? item?.created_at
  if (ts) attrs.push(`age="${formatHintAge(ts, options.nowTs)}"`)
  const rel = overrides.relevanceScore ?? computeHintRelevance(item, { queryTokenCount: options.queryTokenCount })
  if (rel != null) attrs.push(`relevance="${Number(rel).toFixed(2)}"`)
  const text = String(overrides.text ?? item?.content ?? item?.text ?? item?.value ?? '').slice(0, 200)
  return `<hint ${attrs.join(' ')}>${text}</hint>`
}
