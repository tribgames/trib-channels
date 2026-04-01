import { embedText } from './embedding-provider.mjs'
import { cleanMemoryText } from './memory-extraction.mjs'
import {
  buildFtsQuery,
  buildTokenLikePatterns,
  tokenizeMemoryText,
} from './memory-text-utils.mjs'
import { vecToHex } from './memory-vector-utils.mjs'
import { applyMetadataFilters } from './memory-retrievers.mjs'
export { applyMetadataFilters }

const RECALL_EPISODE_KIND_SQL = `'message', 'turn'`
const DEBUG_RECALL_EPISODE_KIND_SQL = `'message', 'turn', 'transcript'`



export function getProfileRecallRows(store, query = '', limit = 5) {
  const clean = String(query ?? '').trim()
  const likePatterns = clean ? buildTokenLikePatterns(clean) : []
  const profileRows = clean
    ? store.db.prepare(`
        SELECT 'profile' AS type, key AS subtype, value AS content, confidence, last_seen, 0 AS entity_id
        FROM profiles
        WHERE status = 'active'
          AND (${likePatterns.map(() => '(key LIKE ? OR value LIKE ?)').join(' OR ')})
        ORDER BY confidence DESC, last_seen DESC
        LIMIT ?
      `).all(...likePatterns.flatMap(pattern => [pattern, pattern]), Math.max(1, Math.ceil(limit / 2)))
    : store.db.prepare(`
        SELECT 'profile' AS type, key AS subtype, value AS content, confidence, last_seen, 0 AS entity_id
        FROM profiles
        WHERE status = 'active'
        ORDER BY confidence DESC, last_seen DESC
        LIMIT ?
      `).all(Math.max(1, Math.ceil(limit / 2)))

  const factRows = clean
    ? store.db.prepare(`
        SELECT 'fact' AS type, fact_type AS subtype, text AS content, confidence, last_seen, id AS entity_id, retrieval_count, source_episode_id
        FROM facts
        WHERE status = 'active'
          AND fact_type IN ('preference', 'constraint')
          AND (${likePatterns.map(() => 'text LIKE ?').join(' OR ')})
        ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(...likePatterns, Math.max(1, Math.ceil(limit / 2)))
    : store.db.prepare(`
        SELECT 'fact' AS type, fact_type AS subtype, text AS content, confidence, last_seen, id AS entity_id, retrieval_count, source_episode_id
        FROM facts
        WHERE status = 'active'
          AND fact_type IN ('preference', 'constraint')
        ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(Math.max(1, Math.ceil(limit / 2)))

  const signalRows = clean
    ? store.db.prepare(`
        SELECT 'signal' AS type, kind AS subtype, value AS content, score AS confidence, last_seen, id AS entity_id, retrieval_count
        FROM signals
        WHERE kind IN ('language', 'tone', 'response_style')
          AND (${likePatterns.map(() => '(kind LIKE ? OR value LIKE ?)').join(' OR ')})
        ORDER BY score DESC, last_seen DESC
        LIMIT ?
      `).all(...likePatterns.flatMap(pattern => [pattern, pattern]), Math.max(1, Math.ceil(limit / 2)))
    : store.db.prepare(`
        SELECT 'signal' AS type, kind AS subtype, value AS content, score AS confidence, last_seen, id AS entity_id, retrieval_count
        FROM signals
        WHERE kind IN ('language', 'tone', 'response_style')
        ORDER BY score DESC, last_seen DESC
        LIMIT ?
      `).all(Math.max(1, Math.ceil(limit / 2)))

  return [...factRows, ...profileRows, ...signalRows].slice(0, limit)
}

export function getPolicyRecallRows(store, query = '', limit = 5, options = {}) {
  const factTypes = ['constraint', 'preference', 'decision', 'fact']
  const clean = String(query ?? '').trim()
  const queryLike = `%${clean}%`
  const { startDate = null, endDate = null } = options
  const timeClause = startDate && endDate ? ` AND last_seen >= ? AND last_seen <= ?` : ''
  const params = [
    ...factTypes,
    ...(clean ? [queryLike] : []),
    ...(startDate && endDate ? [startDate, `${endDate}T23:59:59`] : []),
    limit,
  ]
  return store.db.prepare(`
    SELECT 'fact' AS type, fact_type AS subtype, text AS content, confidence, last_seen, id AS entity_id, retrieval_count, source_episode_id
    FROM facts
    WHERE status = 'active'
      AND fact_type IN (${factTypes.map(() => '?').join(', ')})
      ${clean ? 'AND text LIKE ?' : ''}
      ${timeClause}
    ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
    LIMIT ?
  `).all(...params)
}

export function getEntityRecallRows(store, query = '', limit = 5) {
  const clean = String(query ?? '').trim()
  const queryLike = `%${clean}%`
  return store.db.prepare(`
    SELECT 'entity' AS type, entity_type AS subtype, name AS content, description, last_seen
    FROM entities
    WHERE ${clean ? '(name LIKE ? OR description LIKE ?)' : '1=1'}
    ORDER BY last_seen DESC, id DESC
    LIMIT ?
  `).all(...(clean ? [queryLike, queryLike, limit] : [limit]))
}

export function getRelationRecallRows(store, query = '', limit = 5) {
  const clean = String(query ?? '').trim()
  const queryLike = `%${clean}%`
  return store.db.prepare(`
    SELECT 'relation' AS type, r.relation_type AS subtype,
           trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content,
           r.confidence, r.last_seen
    FROM relations r
    JOIN entities se ON se.id = r.source_entity_id
    JOIN entities te ON te.id = r.target_entity_id
    WHERE r.status = 'active'
      ${clean ? "AND (se.name LIKE ? OR te.name LIKE ? OR r.relation_type LIKE ? OR COALESCE(r.description, '') LIKE ?)" : ''}
    ORDER BY r.confidence DESC, r.last_seen DESC
    LIMIT ?
  `).all(...(clean ? [queryLike, queryLike, queryLike, queryLike, limit] : [limit]))
}

export async function verifyMemoryClaim(store, query, options = {}) {
  const clean = String(query ?? '').trim()
  if (!clean) return []
  const verifyLimit = Math.max(1, Math.min(Number(options.limit ?? 3), 5))
  const queryVector = options.queryVector ?? await embedText(clean)
  const ftsQuery = String(options.ftsQuery ?? '').trim()
  const matchesById = new Map()

  const registerMatch = (fact, extras = {}) => {
    const id = Number(fact.id ?? extras.id ?? 0)
    if (!id) return
    const previous = matchesById.get(id) ?? {}
    const merged = { ...previous, ...fact, ...extras, type: 'fact' }
    const normalizedQuery = clean.toLowerCase()
    const normalizedText = cleanMemoryText(merged.text ?? merged.content ?? '').toLowerCase()
    const queryTokens = tokenizeMemoryText(clean)
    const lexicalHits = queryTokens.filter(token => normalizedText.includes(token)).length
    const lexicalOverlap = queryTokens.length > 0 ? lexicalHits / queryTokens.length : 0
    const literalMatch = normalizedText.includes(normalizedQuery)
    const similarity = Number(merged.similarity ?? previous.similarity ?? 0)
    const exactBoost = literalMatch ? 0.18 : 0
    const lexicalBoost = Math.min(0.45, lexicalOverlap * 0.45)
    const semanticBoost = Math.min(0.55, Math.max(0, similarity) * 0.55)
    const verifyScore = Number(Math.min(1, semanticBoost + lexicalBoost + exactBoost).toFixed(3))
    const crossLingual = lexicalOverlap < 0.1 && similarity > 0
    const highConfidenceFactFound = Number(merged.confidence ?? 0) >= 0.8 && (lexicalOverlap > 0 || similarity > 0.2)
    const accepted = literalMatch || verifyScore >= 0.55 || similarity >= 0.82 || (crossLingual && similarity >= 0.45) || (similarity >= 0.7 && lexicalOverlap >= 0.15) || highConfidenceFactFound
    matchesById.set(id, {
      ...merged,
      lexical_overlap: lexicalOverlap,
      literal_match: literalMatch,
      verify_score: verifyScore,
      accepted,
    })
  }

  if (store.vecEnabled && Array.isArray(queryVector) && queryVector.length > 0) {
    try {
      const hex = vecToHex(queryVector)
      const knnRows = store.vecReadDb.prepare(
        `SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?`
      ).all(verifyLimit * 3)
      for (const knn of knnRows) {
        const { entityType, entityId } = store._vecRowToEntity(knn.rowid)
        if (entityType !== 'fact') continue
        const fact = store.db.prepare(
          `SELECT id, text, confidence, mention_count, last_seen, status FROM facts WHERE id = ? AND status = 'active'`
        ).get(entityId)
        if (fact) registerMatch(fact, { similarity: Number((1 - knn.distance).toFixed(3)), source: 'vector' })
      }
    } catch {}
  }

  if (ftsQuery) {
    try {
      const ftsMatches = store.db.prepare(`
        SELECT f.id, f.text, f.confidence, f.mention_count, f.last_seen, f.status
        FROM facts_fts
        JOIN facts f ON f.id = facts_fts.rowid
        WHERE facts_fts MATCH ? AND f.status = 'active'
        ORDER BY bm25(facts_fts)
        LIMIT ?
      `).all(ftsQuery, verifyLimit * 2)
      for (const fact of ftsMatches) registerMatch(fact, { source: 'fts' })
    } catch {}
  }

  return Array.from(matchesById.values())
    .sort((a, b) => {
      const verifyDelta = Number(b.verify_score ?? 0) - Number(a.verify_score ?? 0)
      if (verifyDelta !== 0) return verifyDelta
      const lexicalDelta = Number(b.lexical_overlap ?? 0) - Number(a.lexical_overlap ?? 0)
      if (lexicalDelta !== 0) return lexicalDelta
      return Number(b.confidence ?? b.similarity ?? 0) - Number(a.confidence ?? a.similarity ?? 0)
    })
    .slice(0, verifyLimit)
}

export async function getEpisodeRecallRows(store, options = {}) {
  const {
    query = '',
    startDate,
    endDate,
    limit = 5,
    queryVector = null,
    ftsQuery = '',
    includeTranscripts = false,
  } = options
  const clean = String(query ?? '').trim()
  const queryLimit = Math.max(1, Number(limit))
  let episodes = []

  if (store.vecEnabled && Array.isArray(queryVector) && queryVector.length > 0) {
    try {
      const hex = vecToHex(queryVector)
      const knnRows = store.vecReadDb.prepare(
        `SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?`
      ).all(queryLimit * 5)
      for (const knn of knnRows) {
        const { entityType, entityId } = store._vecRowToEntity(knn.rowid)
        if (entityType !== 'episode') continue
        const ep = store.db.prepare(`
          SELECT id, ts, day_key, role, kind, content, source_ref, backend AS source_backend
          FROM episodes
          WHERE id = ? AND day_key >= ? AND day_key <= ?
            AND kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
        `).get(entityId, startDate, endDate)
        if (ep) episodes.push({ ...ep, similarity: 1 - knn.distance })
      }
    } catch {}
  }

  if (episodes.length === 0 && clean) {
    try {
      episodes = store.db.prepare(`
        SELECT e.id, e.ts, e.day_key, e.role, e.kind, e.content, e.source_ref, e.backend AS source_backend, bm25(episodes_fts) AS score
        FROM episodes_fts
        JOIN episodes e ON e.id = episodes_fts.rowid
        WHERE episodes_fts MATCH ? AND e.day_key >= ? AND e.day_key <= ?
          AND e.kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, startDate, endDate, queryLimit * 2)
    } catch {}
  }

  if (episodes.length === 0 && !clean) {
    episodes = store.db.prepare(`
      SELECT e.id, e.ts, e.day_key, e.role, e.kind, e.content, e.source_ref, e.backend AS source_backend
      FROM episodes e
      WHERE e.day_key >= ? AND e.day_key <= ?
        AND e.kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
      ORDER BY e.ts DESC
      LIMIT ?
    `).all(startDate, endDate, queryLimit)
  }

  const seen = new Set()
  return episodes.filter(row => {
    const id = Number(row.id ?? row.entity_id ?? 0)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  }).slice(0, queryLimit)
}

export async function bulkVerifyHints(store, hints = []) {
  const details = []
  let confirmed = 0
  let outdated = 0
  let unknown = 0

  for (const rawHint of hints) {
    const clean = String(rawHint ?? '').trim()
    if (!clean) {
      unknown += 1
      details.push({ hint: clean, status: '?' })
      continue
    }
    const ftsQuery = clean.replace(/['"*\-(){}[\]^~:]/g, ' ').replace(/\b(OR|AND|NOT|NEAR)\b/gi, '').trim()
    const matches = await verifyMemoryClaim(store, clean, { limit: 1, ftsQuery })
    const bestMatch = matches[0]
    if (bestMatch) {
      const status = bestMatch.status === 'active' && bestMatch.accepted !== false ? '✓' : '✗'
      if (status === '✓') confirmed += 1
      else outdated += 1
      details.push({
        hint: clean,
        status,
        fact: String(bestMatch.text ?? bestMatch.content ?? ''),
        confidence: Number(bestMatch.confidence ?? bestMatch.similarity ?? 0).toFixed(2),
        mention_count: Number(bestMatch.mention_count ?? 0),
      })
    } else {
      unknown += 1
      details.push({ hint: clean, status: '?' })
    }
  }

  return {
    summary: `✓ confirmed(${confirmed}) ✗ outdated(${outdated}) ? unknown(${unknown})`,
    details,
  }
}

export function getRecallShortcutRows(store, kind = 'all', limit = 5, options = {}) {
  const queryLimit = Math.max(1, Number(limit))
  const { startDate = null, endDate = null } = options
  const timeClause = startDate && endDate ? ` AND last_seen >= ? AND last_seen <= ?` : ''
  const timeParams = startDate && endDate ? [startDate, `${endDate}T23:59:59`] : []
  let rows = []

  if (kind === 'all' || kind === 'facts') {
    rows.push(...store.db.prepare(`
      SELECT 'fact' AS type, fact_type AS subtype, text AS content, confidence, mention_count, last_seen, status
      FROM facts
      WHERE status = 'active'${timeClause}
      ORDER BY confidence DESC, mention_count DESC, last_seen DESC
      LIMIT ?
    `).all(...timeParams, kind === 'all' ? Math.ceil(queryLimit / 2) : queryLimit))
  }
  if (kind === 'all' || kind === 'tasks') {
    rows.push(...store.db.prepare(`
      SELECT 'task' AS type, stage AS subtype, title AS content, confidence, last_seen, status, priority
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')${timeClause}
      ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, last_seen DESC
      LIMIT ?
    `).all(...timeParams, kind === 'all' ? Math.ceil(queryLimit / 3) : queryLimit))
  }
  if (kind === 'all' || kind === 'signals') {
    rows.push(...store.db.prepare(`
      SELECT 'signal' AS type, kind AS subtype, value AS content, score AS confidence, last_seen
      FROM signals${startDate && endDate ? ' WHERE last_seen >= ? AND last_seen <= ?' : ''}
      ORDER BY score DESC, last_seen DESC
      LIMIT ?
    `).all(...timeParams, kind === 'all' ? Math.ceil(queryLimit / 3) : queryLimit))
  }
  if (kind === 'all' || kind === 'profiles') {
    rows.push(...getProfileRecallRows(store, '', kind === 'all' ? Math.ceil(queryLimit / 3) : queryLimit))
  }
  if (kind === 'all' || kind === 'episodes') {
    rows.push(...store.db.prepare(`
      SELECT 'episode' AS type, role AS subtype, content, ts AS last_seen
      FROM episodes
      WHERE kind IN (${RECALL_EPISODE_KIND_SQL})
        AND content NOT LIKE 'You are consolidating%'
        AND LENGTH(content) >= 10
        ${startDate && endDate ? 'AND day_key >= ? AND day_key <= ?' : ''}
      ORDER BY ts DESC
      LIMIT ?
    `).all(...(startDate && endDate ? [startDate, endDate, kind === 'all' ? Math.ceil(queryLimit / 3) : queryLimit] : [kind === 'all' ? Math.ceil(queryLimit / 3) : queryLimit])))
  }
  if (kind === 'all' || kind === 'entities') {
    rows.push(...getEntityRecallRows(store, '', kind === 'all' ? Math.ceil(queryLimit / 4) : queryLimit))
  }
  if (kind === 'all' || kind === 'relations') {
    rows.push(...getRelationRecallRows(store, '', kind === 'all' ? Math.ceil(queryLimit / 4) : queryLimit))
  }

  return rows
}

