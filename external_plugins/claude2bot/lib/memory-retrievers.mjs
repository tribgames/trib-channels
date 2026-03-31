import { getExactHistoryTypePriority, getResultDayKey, isOngoingTaskQuery } from './memory-query-plan.mjs'
import { isProfileRelatedText } from './memory-extraction.mjs'
import { SEED_LANE_PRIOR } from './memory-ranking-utils.mjs'
import { DEFAULT_MEMORY_TUNING } from './memory-tuning.mjs'

const RECALL_EPISODE_KIND_SQL = `'message', 'turn'`

function uniqueByEntity(rows = []) {
  return rows.filter((item, index, arr) =>
    arr.findIndex(candidate => `${candidate.type}:${candidate.entity_id}` === `${item.type}:${item.entity_id}`) === index,
  )
}

async function getEpisodeSessionId(store, sourceEpisodeId, cache) {
  const id = Number(sourceEpisodeId ?? 0)
  if (!id) return ''
  if (cache.has(id)) return cache.get(id)
  try {
    const value = String(store.db.prepare(`SELECT session_id FROM episodes WHERE id = ?`).get(id)?.session_id ?? '')
    cache.set(id, value)
    return value
  } catch {
    cache.set(id, '')
    return ''
  }
}

export async function applyMetadataFilters(store, rows = [], filters = {}) {
  const memoryKind = String(filters.memory_kind ?? '').trim()
  const taskStatus = String(filters.task_status ?? '').trim()
  const sourceType = String(filters.source_type ?? '').trim().toLowerCase()
  const sessionId = String(filters.session_id ?? '').trim()
  if (!memoryKind && !taskStatus && !sourceType && !sessionId) return rows
  const sessionCache = new Map()
  const filtered = []
  for (const row of rows) {
    if (memoryKind && String(row?.type ?? '') !== memoryKind) continue
    if (taskStatus && row?.type === 'task' && String(row?.status ?? '') !== taskStatus) continue
    if (sourceType) {
      const kind = String(row?.source_kind ?? '').toLowerCase()
      const backend = String(row?.source_backend ?? '').toLowerCase()
      if (kind !== sourceType && backend !== sourceType) continue
    }
    if (sessionId) {
      const matchedSessionId = await getEpisodeSessionId(store, row?.source_episode_id ?? row?.entity_id, sessionCache)
      if (matchedSessionId !== sessionId) continue
    }
    filtered.push(row)
  }
  return filtered
}

function parseEpisodeTime(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function taskStageSeedBonus(stage = '', taskSeedConfig = DEFAULT_MEMORY_TUNING.taskSeed) {
  const bonus = taskSeedConfig?.stageBonus ?? DEFAULT_MEMORY_TUNING.taskSeed.stageBonus
  switch (String(stage).toLowerCase()) {
    case 'implementing': return Number(bonus.implementing ?? 0.42)
    case 'wired': return Number(bonus.wired ?? 0.34)
    case 'verified': return Number(bonus.verified ?? 0.26)
    case 'investigating': return Number(bonus.investigating ?? 0.12)
    case 'planned': return Number(bonus.planned ?? -0.24)
    case 'done': return Number(bonus.done ?? 0.08)
    default: return 0
  }
}

function taskStatusSeedBonus(status = '', includeDoneTasks = false, taskSeedConfig = DEFAULT_MEMORY_TUNING.taskSeed) {
  const bonus = taskSeedConfig?.statusBonus ?? DEFAULT_MEMORY_TUNING.taskSeed.statusBonus
  switch (String(status).toLowerCase()) {
    case 'in_progress': return Number(bonus.in_progress ?? 0.28)
    case 'active': return Number(bonus.active ?? 0.22)
    case 'paused': return Number(bonus.paused ?? -0.06)
    case 'done': return includeDoneTasks ? Number(bonus.done ?? 0.68) : Number(bonus.doneExcluded ?? -0.32)
    default: return 0
  }
}

function taskPrioritySeedBonus(priority = '', taskSeedConfig = DEFAULT_MEMORY_TUNING.taskSeed) {
  const bonus = taskSeedConfig?.priorityBonus ?? DEFAULT_MEMORY_TUNING.taskSeed.priorityBonus
  switch (String(priority).toLowerCase()) {
    case 'high': return Number(bonus.high ?? 0.14)
    case 'normal': return Number(bonus.normal ?? 0.06)
    case 'low': return Number(bonus.low ?? 0)
    default: return 0
  }
}

function historyRepresentativeScore(item, options = {}) {
  const cfg = options.historyConfig ?? DEFAULT_MEMORY_TUNING.history.representative
  const overlap = Number(item?.overlapCount ?? 0)
  const semantic = Math.max(0, Number(item?.semanticSimilarity ?? 0))
  const contentLen = String(item?.content ?? '').length
  const subtype = String(item?.subtype ?? '').toLowerCase()
  const clean = String(item?.content ?? '').trim()
  const genericPenalty =
    clean.length < 18 ? 1.8 :
    /^(ok|okay|ㅇㅋ|네|예|응|맞아요)[.!?]?$/i.test(clean) ? 2.2 :
    /보이나요|됐나요|알려주세요|테스트해보시고|결과 알려주세요|포워딩/.test(clean) ? 1.4 :
    /\?$/.test(clean) && clean.length < 40 ? 0.8 :
    0
  return (
    overlap * Number(cfg.overlapMultiplier ?? 6) +
    semantic * Number(cfg.semanticMultiplier ?? 4) +
    Math.min(Number(cfg.contentLengthMax ?? 1.25), contentLen / Math.max(1, Number(cfg.contentLengthDivisor ?? 180))) +
    (subtype === 'assistant' ? Number(cfg.assistantBonus ?? 0.2) : 0) +
    (subtype === 'turn' ? Number(cfg.turnBonus ?? 0.1) : 0) +
    parseEpisodeTime(item?.updated_at) * Number(cfg.recencyBonus ?? 0.000001) -
    genericPenalty
  )
}

function segmentEpisodesByGap(rows = [], gapMinutes = 45) {
  const sorted = [...rows].sort((a, b) => parseEpisodeTime(a.updated_at) - parseEpisodeTime(b.updated_at))
  const segments = []
  let current = []
  for (const row of sorted) {
    const previous = current[current.length - 1]
    if (!previous) {
      current = [row]
      continue
    }
    const gapMs = parseEpisodeTime(row.updated_at) - parseEpisodeTime(previous.updated_at)
    if (gapMs > gapMinutes * 60 * 1000) {
      segments.push(current)
      current = [row]
    } else {
      current.push(row)
    }
  }
  if (current.length > 0) segments.push(current)
  return segments
}

export function getDirectRelationSeedRows(store, query = '', queryEntities = [], seedLimit = 4) {
  const directRows = []
  const preferDirectRelation = queryEntities.length > 0
  if (!query || !preferDirectRelation) return directRows
  try {
    const subjectTokens = String(query).split(/\s+/).filter(Boolean).slice(0, 6)
    const likePatterns = subjectTokens.map(token => `%${token}%`)
    const hasTokenSearch = likePatterns.length > 0
    directRows.push(...store.db.prepare(`
      SELECT 'entity' AS type, entity_type AS subtype, CAST(id AS TEXT) AS ref, name AS content,
             unixepoch(last_seen) AS updated_at, id AS entity_id, 0.8 AS quality_score, 0 AS retrieval_count
      FROM entities
      WHERE ${hasTokenSearch ? likePatterns.map(() => `(name LIKE ? OR COALESCE(description, '') LIKE ?)`).join(' OR ') : '1 = 0'}
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(...likePatterns.flatMap(pattern => [pattern, pattern]), Math.max(4, seedLimit * 2)))
    directRows.push(...store.db.prepare(`
      SELECT 'relation' AS type, relation_type AS subtype, CAST(r.id AS TEXT) AS ref,
             trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content,
             unixepoch(r.last_seen) AS updated_at, r.id AS entity_id, r.confidence AS quality_score, 0 AS retrieval_count
      FROM relations r
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE ${hasTokenSearch ? likePatterns.map(() => `(se.name LIKE ? OR te.name LIKE ? OR r.relation_type LIKE ? OR COALESCE(r.description, '') LIKE ?)`).join(' OR ') : '1 = 0'}
      ORDER BY r.confidence DESC, r.last_seen DESC
      LIMIT ?
    `).all(...likePatterns.flatMap(pattern => [pattern, pattern, pattern, pattern]), Math.max(4, seedLimit * 2)))
  } catch {}
  return directRows
}

export async function getProfileSeedResults(store, query = '', queryVector = null, seedLimit = 4) {
  const candidatePool = Math.max(seedLimit * 6, 18)
  const profiles = store.db.prepare(`
    SELECT 'profile' AS type, key AS subtype, key || ': ' || value AS content,
           unixepoch(last_seen) AS updated_at, 0 AS entity_id,
           confidence AS quality_score, retrieval_count
    FROM profiles
    WHERE status = 'active'
    ORDER BY confidence DESC, mention_count DESC, last_seen DESC
    LIMIT ?
  `).all(Math.max(6, seedLimit * 2))
  const facts = store.db.prepare(`
    SELECT 'fact' AS type, fact_type AS subtype, CAST(id AS TEXT) AS ref, text AS content,
           unixepoch(last_seen) AS updated_at, id AS entity_id,
           confidence AS quality_score, retrieval_count
    FROM facts
    WHERE status = 'active'
      AND fact_type IN ('preference', 'constraint')
    ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
    LIMIT ?
  `).all(candidatePool)
  const signals = store.db.prepare(`
    SELECT 'signal' AS type, kind AS subtype, CAST(id AS TEXT) AS ref, value AS content,
           unixepoch(last_seen) AS updated_at, id AS entity_id,
           score AS quality_score, retrieval_count
    FROM signals
    WHERE kind IN ('language', 'tone')
    ORDER BY score DESC, retrieval_count DESC, last_seen DESC
    LIMIT ?
  `).all(Math.max(4, seedLimit * 2))
  const propositions = store.db.prepare(`
    SELECT 'proposition' AS type, proposition_kind AS subtype, CAST(id AS TEXT) AS ref, text AS content,
           unixepoch(last_seen) AS updated_at, id AS entity_id, confidence AS quality_score, retrieval_count, source_fact_id
    FROM propositions
    WHERE status = 'active'
    ORDER BY confidence DESC, retrieval_count DESC, last_seen DESC
    LIMIT ?
  `).all(Math.max(4, seedLimit * 2))
  const ranked = await store.rankIntentSeedItems(
    [
      ...profiles,
      ...facts.filter(item => isProfileRelatedText(item.content)),
      ...signals,
      ...propositions.filter(item => isProfileRelatedText(item.content)),
    ],
    query,
    queryVector,
    { minSimilarity: 0.18 },
  )
  return ranked.slice(0, seedLimit).map(item => ({ ...item, score: SEED_LANE_PRIOR.profile }))
}

export async function getTaskSeedResults(store, query = '', queryVector = null, seedLimit = 4, options = {}) {
  const includeDoneTasks = Boolean(options.includeDoneTasks)
  const preferActiveTasks = Boolean(options.preferActiveTasks) || isOngoingTaskQuery(query)
  const taskSeedConfig = options.taskSeedConfig ?? DEFAULT_MEMORY_TUNING.taskSeed
  const candidatePool = Math.max(seedLimit * 6, 18)
  const statusClause = preferActiveTasks
    ? (includeDoneTasks ? "'active', 'in_progress', 'done'" : "'active', 'in_progress'")
    : (includeDoneTasks ? "'active', 'in_progress', 'paused', 'done'" : "'active', 'in_progress', 'paused'")
  const tasks = store.db.prepare(`
    SELECT 'task' AS type, stage AS subtype, CAST(id AS TEXT) AS ref,
           trim(title || CASE WHEN details IS NOT NULL AND details != '' THEN ' — ' || details ELSE '' END) AS content,
           unixepoch(last_seen) AS updated_at, id AS entity_id,
           confidence AS quality_score, retrieval_count,
           status, stage, priority, evidence_level
    FROM tasks
    WHERE status IN (${statusClause})
    ORDER BY
      CASE
        WHEN ${includeDoneTasks ? "status = 'done'" : "0"} THEN 0
        WHEN status = 'in_progress' THEN 1
        WHEN status = 'active' THEN 2
        WHEN status = 'paused' THEN 3
        ELSE 4
      END,
      CASE
        WHEN stage = 'implementing' THEN 0
        WHEN stage = 'wired' THEN 1
        WHEN stage = 'verified' THEN 2
        WHEN stage = 'investigating' THEN 3
        WHEN stage = 'planned' THEN 4
        WHEN stage = 'done' THEN 5
        ELSE 6
      END,
      CASE
        WHEN priority = 'high' THEN 1
        WHEN priority = 'normal' THEN 2
        ELSE 3
      END,
      retrieval_count DESC,
      last_seen DESC
    LIMIT ?
  `).all(candidatePool)
  const ranked = await store.rankIntentSeedItems(tasks, query, queryVector, { minSimilarity: 0.12 })
  const prioritized = (ranked.length > 0 ? ranked : tasks)
    .map(item => ({
      ...item,
      task_seed_score:
        Number(item.seedRank ?? 0) +
        taskStageSeedBonus(item.stage, taskSeedConfig) +
        taskStatusSeedBonus(item.status, includeDoneTasks, taskSeedConfig) +
        taskPrioritySeedBonus(item.priority, taskSeedConfig) +
        (
          preferActiveTasks
            ? (
                String(item.stage).toLowerCase() === 'planned'
                  ? Number(taskSeedConfig?.ongoingQuery?.plannedPenalty ?? -0.85)
                  : String(item.status).toLowerCase() === 'paused'
                    ? Number(taskSeedConfig?.ongoingQuery?.pausedPenalty ?? -0.2)
                    : String(item.status).toLowerCase() === 'in_progress'
                      ? Number(taskSeedConfig?.ongoingQuery?.inProgressBonus ?? 0.28)
                      : String(item.status).toLowerCase() === 'active'
                        ? Number(taskSeedConfig?.ongoingQuery?.activeBonus ?? 0.22)
                        : 0
              )
            : 0
        ),
    }))
    .sort((a, b) => Number(b.task_seed_score) - Number(a.task_seed_score))
  return uniqueByEntity(prioritized).slice(0, seedLimit).map(item => ({ ...item, score: SEED_LANE_PRIOR.task }))
}

export async function getDecisionSeedResults(store, query = '', queryVector = null, seedLimit = 4, options = {}) {
  const candidatePool = Math.max(seedLimit * 6, 18)
  const directRows = options.directRows ?? []
  const facts = store.db.prepare(`
    SELECT 'fact' AS type, fact_type AS subtype, CAST(id AS TEXT) AS ref, text AS content,
           unixepoch(last_seen) AS updated_at, id AS entity_id,
           confidence AS quality_score, retrieval_count
    FROM facts
    WHERE status = 'active'
      AND fact_type IN ('decision', 'constraint')
    ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
    LIMIT ?
  `).all(candidatePool)
  const propositions = store.db.prepare(`
    SELECT 'proposition' AS type, proposition_kind AS subtype, CAST(id AS TEXT) AS ref, text AS content,
           unixepoch(last_seen) AS updated_at, id AS entity_id, confidence AS quality_score, retrieval_count, source_fact_id
    FROM propositions
    WHERE status = 'active'
    ORDER BY confidence DESC, retrieval_count DESC, last_seen DESC
    LIMIT ?
  `).all(candidatePool)
  const ranked = await store.rankIntentSeedItems([...facts, ...propositions, ...directRows], query, queryVector, { minSimilarity: 0.14 })
  return (ranked.length > 0 ? ranked : facts).slice(0, seedLimit).map(item => ({ ...item, score: SEED_LANE_PRIOR.decision }))
}

export async function getPolicySeedResults(store, query = '', queryVector = null, seedLimit = 4) {
  const candidatePool = Math.max(seedLimit * 6, 18)
  const facts = store.db.prepare(`
    SELECT 'fact' AS type, fact_type AS subtype, CAST(id AS TEXT) AS ref, text AS content,
           unixepoch(last_seen) AS updated_at, id AS entity_id,
           confidence AS quality_score, retrieval_count
    FROM facts
    WHERE status = 'active'
      AND fact_type IN ('constraint', 'decision')
    ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
    LIMIT ?
  `).all(candidatePool)
  const propositions = store.db.prepare(`
    SELECT 'proposition' AS type, proposition_kind AS subtype, CAST(id AS TEXT) AS ref, text AS content,
           unixepoch(last_seen) AS updated_at, id AS entity_id, confidence AS quality_score, retrieval_count, source_fact_id
    FROM propositions
    WHERE status = 'active'
    ORDER BY confidence DESC, retrieval_count DESC, last_seen DESC
    LIMIT ?
  `).all(candidatePool)
  const ranked = await store.rankIntentSeedItems([...facts, ...propositions], query, queryVector, { minSimilarity: 0.14 })
  return (ranked.length > 0 ? ranked : facts).slice(0, seedLimit).map(item => ({ ...item, score: SEED_LANE_PRIOR.policy }))
}

export async function getRelationSeedResults(store, query = '', queryVector = null, seedLimit = 4, options = {}) {
  const candidatePool = Math.max(seedLimit * 6, 18)
  const directRows = options.directRows ?? []
  const facts = store.db.prepare(`
    SELECT 'fact' AS type, fact_type AS subtype, CAST(id AS TEXT) AS ref, text AS content,
           unixepoch(last_seen) AS updated_at, id AS entity_id,
           confidence AS quality_score, retrieval_count
    FROM facts
    WHERE status = 'active'
      AND fact_type IN ('decision', 'fact')
    ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
    LIMIT ?
  `).all(candidatePool)
  const ranked = await store.rankIntentSeedItems([...directRows, ...facts], query, queryVector, { minSimilarity: 0.16 })
  return uniqueByEntity(ranked.length > 0 ? ranked : directRows).slice(0, seedLimit).map(item => ({ ...item, score: SEED_LANE_PRIOR.graph }))
}

export async function getHistorySeedResults(store, intent, query = '', queryVector = null, seedLimit = 4, options = {}) {
  const candidatePool = Math.max(seedLimit * 6, 18)
  const directRows = options.directRows ?? []
  const historyConfig = options.historyConfig ?? DEFAULT_MEMORY_TUNING.history.representative
  const episodes = store.db.prepare(`
    SELECT 'episode' AS type, role AS subtype, CAST(id AS TEXT) AS ref, content,
           created_at AS updated_at, id AS entity_id, 0 AS retrieval_count
    FROM episodes
    WHERE kind IN (${RECALL_EPISODE_KIND_SQL})
      AND content NOT LIKE 'You are consolidating%'
      AND content NOT LIKE 'You are improving%'
      AND LENGTH(content) >= 10
    ORDER BY ts DESC
    LIMIT ?
  `).all(Math.max(candidatePool, seedLimit + 8))
  const propositions = store.db.prepare(`
    SELECT 'proposition' AS type, proposition_kind AS subtype, CAST(id AS TEXT) AS ref, text AS content,
           unixepoch(last_seen) AS updated_at, id AS entity_id, confidence AS quality_score, retrieval_count, source_fact_id
    FROM propositions
    WHERE status = 'active'
    ORDER BY last_seen DESC, retrieval_count DESC
    LIMIT ?
  `).all(Math.max(8, seedLimit * 3))
  const ranked = await store.rankIntentSeedItems(
    [...episodes, ...propositions, ...directRows],
    query,
    queryVector,
    { minSimilarity: intent === 'event' ? 0.04 : 0.08 },
  )
  const rankedEpisodesFirst = ranked.length > 0 ? ranked : episodes
  const segments = segmentEpisodesByGap(rankedEpisodesFirst.filter(item => item.type === 'episode'))
  const segmentedEpisodes = segments
    .map(segment => [...segment].sort((a, b) => historyRepresentativeScore(b, { historyConfig }) - historyRepresentativeScore(a, { historyConfig }))[0])
    .filter(Boolean)
  const merged = uniqueByEntity([
    ...segmentedEpisodes,
    ...rankedEpisodesFirst.filter(item => item.type !== 'episode'),
  ])
  return merged.slice(0, seedLimit).map(item => ({ ...item, score: SEED_LANE_PRIOR.history }))
}

export async function getSeedResultsForPlan(store, plan, queryVector = null) {
  const seedLimit = Math.min(4, plan.limit)
  const tuning = store.getRetrievalTuning()
  const directRows = getDirectRelationSeedRows(store, plan.query, plan.preferRelations ? plan.queryEntities : [], seedLimit)
  if (plan.retriever === 'profile') {
    return getProfileSeedResults(store, plan.query, queryVector, seedLimit)
  }
  if (plan.retriever === 'task') {
    return getTaskSeedResults(store, plan.query, queryVector, seedLimit, {
      includeDoneTasks: plan.includeDoneTasks,
      preferActiveTasks: plan.preferActiveTasks,
      taskSeedConfig: tuning.taskSeed,
    })
  }
  if (plan.retriever === 'policy') {
    return getPolicySeedResults(store, plan.query, queryVector, seedLimit)
  }
  if (plan.retriever === 'graph') {
    return getRelationSeedResults(store, plan.query, queryVector, seedLimit, { directRows })
  }
  if (plan.retriever === 'decision') {
    return getDecisionSeedResults(store, plan.query, queryVector, seedLimit, { directRows })
  }
  if (plan.retriever === 'history') {
    return getHistorySeedResults(store, plan.intent.primary, plan.query, queryVector, seedLimit, {
      directRows,
      historyConfig: tuning.history.representative,
    })
  }
  return []
}

export async function buildHybridRetrievalInputs(store, plan, queryVector, focusVector) {
  const limit = plan.limit
  const denseRows = await store.searchRelevantDense(plan.query, limit * 2, queryVector, focusVector, {
    includeDoneTasks: plan.includeDoneTasks,
  })
  const seededRows = await getSeedResultsForPlan(store, plan, queryVector)
  const entityScopedRows = store.getEntityScopedResults(plan.queryEntities, Math.min(6, limit * 2), {
    preferRelations: plan.preferRelations,
  })
  const ruleScopedRows = store.getRuleScopedResults(plan.query, Math.min(5, limit * 2))
  const sparseRows = [...entityScopedRows, ...ruleScopedRows, ...seededRows, ...store.searchRelevantSparse(plan.query, limit * 2)]
  const dense = await applyMetadataFilters(store, denseRows, plan.filters)
  const sparse = await applyMetadataFilters(store, sparseRows, plan.filters)

  if (plan.temporal) {
    const seen = new Set(sparse.map(item => `${item.type}:${item.entity_id}`))
    try {
      const temporalEpisodes = store.db.prepare(`
        SELECT 'episode' AS type, role AS subtype, CAST(id AS TEXT) AS ref, content,
               ? AS score, created_at AS updated_at, id AS entity_id, 0 AS retrieval_count
        FROM episodes
        WHERE day_key >= ? AND day_key <= ?
          AND kind IN (${RECALL_EPISODE_KIND_SQL})
          AND content NOT LIKE 'You are consolidating%'
          AND LENGTH(content) >= 10
        ORDER BY ts DESC
        LIMIT 6
      `).all(
        (plan.intent.primary === 'event' || plan.intent.primary === 'history') && plan.temporal.exact ? -4.0 : -1.5,
        plan.temporal.start,
        plan.temporal.end,
      )
      for (const episode of temporalEpisodes) {
        if (!seen.has(`episode:${episode.entity_id}`)) {
          sparse.push(episode)
          seen.add(`episode:${episode.entity_id}`)
        }
      }
    } catch {}
  }

  if (plan.isHistoryExact) {
    const exactEpisodeLane = store.db.prepare(`
      SELECT 'episode' AS type, role AS subtype, CAST(id AS TEXT) AS ref, content,
             -12.0 AS score, created_at AS updated_at, id AS entity_id, 0 AS retrieval_count,
             NULL AS quality_score, source_ref, ts AS source_ts, kind AS source_kind, backend AS source_backend
      FROM episodes
      WHERE day_key = ?
        AND kind IN (${RECALL_EPISODE_KIND_SQL})
        AND LENGTH(content) >= 10
      ORDER BY ts ASC
      LIMIT ?
    `).all(plan.temporal.start, Math.max(limit, 6))
    const seen = new Set(sparse.map(item => `${item.type}:${item.entity_id}`))
    for (const row of exactEpisodeLane) {
      if (seen.has(`episode:${row.entity_id}`)) continue
      sparse.unshift(row)
      seen.add(`episode:${row.entity_id}`)
    }
  }

  return { sparse, dense }
}

export function applyExactHistorySelection(plan, results, limit, options = {}) {
  if (!plan.isHistoryExact) return results
  const exactDate = plan.temporal.start
  const exactCfg = options.tuning?.history?.exactDate ?? DEFAULT_MEMORY_TUNING.history.exactDate
  const candidates = results.filter(item => getResultDayKey(item) === exactDate)
  const substantiveCandidates = candidates.filter(item => String(item?.content ?? '').trim().length >= 10)
  const score = (item) => {
    const overlap = Number(item?.overlapCount ?? 0)
    const weightedScore = Number(item?.weighted_score ?? item?.score ?? 0)
    const contentLen = String(item?.content ?? '').length
    const subtype = String(item?.subtype ?? '').toLowerCase()
    const clean = String(item?.content ?? '').trim()
    const genericPenalty =
      clean.length < 18 ? 1.6 :
      /^(ok|okay|ㅇㅋ|네|예|응|맞아요)[.!?]?$/i.test(clean) ? 2 :
      /보이나요|됐나요|알려주세요|테스트해보시고|결과 알려주세요|포워딩/.test(clean) ? 1.2 :
      /\?$/.test(clean) && clean.length < 40 ? 0.7 :
      0
    return (
      overlap * Number(exactCfg.overlapMultiplier ?? 8) +
      weightedScore * Number(exactCfg.weightedScoreMultiplier ?? -1) +
      Math.min(Number(exactCfg.contentLengthMax ?? 1.2), contentLen / Math.max(1, Number(exactCfg.contentLengthDivisor ?? 180))) +
      (subtype === 'assistant' ? Number(exactCfg.assistantBonus ?? 0.24) : 0) +
      (subtype === 'turn' ? Number(exactCfg.turnBonus ?? 0.12) : 0) -
      genericPenalty
    )
  }
  const exactDayResults = (substantiveCandidates.length > 0 ? substantiveCandidates : candidates)
    .sort((a, b) => {
      const scoreDelta = score(b) - score(a)
      if (scoreDelta !== 0) return scoreDelta
      const typeDelta = getExactHistoryTypePriority(a) - getExactHistoryTypePriority(b)
      if (typeDelta !== 0) return typeDelta
      return Number(a?.weighted_score ?? a?.score ?? 0) - Number(b?.weighted_score ?? b?.score ?? 0)
    })
  if (exactDayResults.length === 0) return results
  return exactDayResults.slice(0, limit)
}

export function summarizeRetrieverDebug(plan, sparse = [], dense = [], finalResults = []) {
  const summarizeItem = (item) => ({
    type: item?.type ?? null,
    subtype: item?.subtype ?? null,
    entity_id: item?.entity_id ?? null,
    status: item?.status ?? null,
    score: item?.score ?? item?.weighted_score ?? null,
    rerank_score: item?.rerank_score ?? null,
    overlap: item?.overlapCount ?? null,
    content: String(item?.content ?? '').slice(0, 120),
  })

  return {
    plan: {
      retriever: plan.retriever,
      intent: plan.intent?.primary ?? null,
      includeDoneTasks: plan.includeDoneTasks,
      explicitRelationQuery: plan.explicitRelationQuery,
      preferRelations: plan.preferRelations,
      isHistoryExact: plan.isHistoryExact,
      temporal: plan.temporal ?? null,
      entityScope: (plan.queryEntities ?? []).map(item => ({
        id: item.id,
        name: item.name,
        type: item.entity_type,
      })),
    },
    candidate_pool: {
      sparse_count: sparse.length,
      dense_count: dense.length,
      sparse_top: sparse.slice(0, 5).map(summarizeItem),
      dense_top: dense.slice(0, 5).map(summarizeItem),
    },
    final_top: finalResults.slice(0, 5).map(summarizeItem),
  }
}
