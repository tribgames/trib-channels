import { createHash } from 'crypto'
import { cleanMemoryText } from './memory-extraction.mjs'

export function isProfileIntent(intent) {
  return intent === 'profile'
}

export function isPolicyIntent(intent) {
  return intent === 'policy' || intent === 'security'
}

export function getIntentTypeCaps(intent, options = {}) {
  const hasTaskCandidate = Boolean(options.hasTaskCandidate)
  const hasCoreResult = Boolean(options.hasCoreResult)
  const conciseQuery = Boolean(options.conciseQuery)
  if (isProfileIntent(intent)) return new Map([['fact', 3], ['proposition', 2], ['task', 0], ['signal', 2], ['profile', 3], ['episode', 0]])
  if (intent === 'task') return new Map([['fact', 1], ['proposition', 1], ['task', hasTaskCandidate ? 4 : 2], ['signal', 0], ['episode', 1]])
  if (isPolicyIntent(intent)) return new Map([['fact', 4], ['proposition', 3], ['task', 1], ['signal', 1], ['episode', 0]])
  if (intent === 'event') return new Map([['fact', 1], ['proposition', 2], ['task', 1], ['signal', 0], ['episode', 4], ['entity', 1], ['relation', 1]])
  if (intent === 'history') return new Map([['fact', 1], ['proposition', 2], ['task', 1], ['signal', 0], ['episode', 3], ['entity', 1], ['relation', 1]])
  return new Map([
    ['fact', 4],
    ['proposition', 3],
    ['task', 3],
    ['signal', 0],
    ['entity', 2],
    ['relation', 2],
    ['episode', hasCoreResult ? (conciseQuery ? 1 : 2) : 2],
  ])
}

export function getIntentSubtypeBonus(intent, item) {
  if (isProfileIntent(intent)) {
    return (
      item.type === 'fact' && item.subtype === 'preference' ? -0.10 :
      item.type === 'fact' && item.subtype === 'constraint' ? -0.08 :
      item.type === 'profile' ? -0.14 :
      item.type === 'proposition' ? -0.06 :
      item.type === 'signal' && (item.subtype === 'tone' || item.subtype === 'language') ? -0.08 :
      0
    )
  }
  if (intent === 'task') {
    return item.type === 'task' ? -0.10 : 0
  }
  if (isPolicyIntent(intent)) {
    return (
      item.type === 'fact' && item.subtype === 'constraint' ? -0.10 :
      item.type === 'proposition' ? -0.08 :
      item.type === 'fact' && item.subtype === 'decision' ? -0.06 :
      0
    )
  }
  if (intent === 'event') return item.type === 'episode' ? -0.14 : 0
  if (intent === 'history') return item.type === 'episode' ? -0.08 : 0
  return item.type === 'fact' && item.subtype === 'decision' ? -0.06 : 0
}

export function shouldKeepRerankItem(intent, item, options = {}) {
  const hasTaskCandidate = Boolean(options.hasTaskCandidate)
  if (isProfileIntent(intent)) return item.type === 'fact' || item.type === 'signal' || item.type === 'profile' || item.type === 'proposition'
  if (intent === 'task' && hasTaskCandidate) return item.type === 'task' || (item.type === 'fact' && item.subtype === 'decision')
  if (isPolicyIntent(intent)) return item.type === 'fact' || item.type === 'signal' || item.type === 'proposition'
  if (intent === 'event') return item.type === 'episode' || item.type === 'fact' || item.type === 'task'
  if (intent === 'decision') return item.type === 'fact' || item.type === 'task' || item.type === 'proposition' || item.type === 'entity' || item.type === 'relation'
  return true
}

export function computeSourceTrustAdjustment(item, primaryIntent = 'decision') {
  const sourceKind = String(item?.source_kind ?? '').toLowerCase().trim()
  const sourceBackend = String(item?.source_backend ?? '').toLowerCase().trim()

  if (sourceKind === 'message') return item?.type === 'episode' ? -0.1 : -0.14
  if (sourceKind === 'transcript') {
    if (item?.type === 'episode' && (primaryIntent === 'event' || primaryIntent === 'history')) return 0.04
    return item?.type === 'episode' ? 0.08 : 0.14
  }
  if (sourceKind === 'turn') return 0.05
  if (sourceBackend === 'discord') return -0.03
  if (sourceBackend === 'claude-session') return 0.04
  return 0
}

export function compactRetrievalContent(item) {
  const raw = cleanMemoryText(item?.content ?? '')
  if (!raw) return ''
  if (item?.type === 'episode') return raw.slice(0, 160)
  return raw.slice(0, 260)
}

export function normalizedClaimSurfaceText(item) {
  return cleanMemoryText(item?.content ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function claimSurfaceKey(item) {
  const type = String(item?.type ?? '')
  if (type !== 'fact' && type !== 'proposition') return ''
  const sourceFactId = Number(item?.source_fact_id ?? 0)
  if (sourceFactId > 0) return `claim:${sourceFactId}`
  const fallbackId = type === 'fact' ? Number(item?.entity_id ?? 0) : 0
  if (fallbackId > 0) return `claim:${fallbackId}`
  const normalized = normalizedClaimSurfaceText(item)
  if (!normalized) return ''
  const hash = createHash('sha1').update(`${String(item?.subtype ?? '')}:${normalized.slice(0, 240)}`).digest('hex').slice(0, 16)
  return `claim:${hash}`
}

export function preferClaimSurfaceCandidate(current, previous, scoreField = 'weighted_score') {
  if (!previous) return true
  const currentType = String(current?.type ?? '')
  const previousType = String(previous?.type ?? '')
  if (currentType !== previousType) {
    if (currentType === 'fact') return true
    if (previousType === 'fact') return false
  }
  const currentScore = Number(current?.[scoreField] ?? current?.weighted_score ?? 0)
  const previousScore = Number(previous?.[scoreField] ?? previous?.weighted_score ?? 0)
  if (currentScore !== previousScore) return currentScore < previousScore
  const currentQuality = Number(current?.quality_score ?? current?.confidence ?? 0)
  const previousQuality = Number(previous?.quality_score ?? previous?.confidence ?? 0)
  if (currentQuality !== previousQuality) return currentQuality > previousQuality
  return Number(current?.retrieval_count ?? 0) > Number(previous?.retrieval_count ?? 0)
}

export function collapseClaimSurfaceDuplicates(items, scoreField = 'weighted_score') {
  const selected = new Map()
  const passthrough = []
  for (const item of items) {
    const key = claimSurfaceKey(item)
    if (!key) {
      passthrough.push(item)
      continue
    }
    const previous = selected.get(key)
    if (preferClaimSurfaceCandidate(item, previous, scoreField)) {
      selected.set(key, item)
    }
  }
  return [...passthrough, ...selected.values()]
}
