import { embedText } from './embedding-provider.mjs'
import { cleanMemoryText } from './memory-extraction.mjs'
import { buildHintKey, formatHintTag, shouldInjectHint } from './memory-context-utils.mjs'
import { decayConfidence, decaySignalScore } from './memory-decay-utils.mjs'
import { detectProfileQuerySlot } from './memory-profile-utils.mjs'
import { looksLowSignalQuery, tokenizeMemoryText } from './memory-text-utils.mjs'

export async function buildInboundMemoryContext(store, query, options = {}) {
  const clean = cleanMemoryText(query)
  if (!clean || looksLowSignalQuery(clean)) return ''

  const totalStartedAt = Date.now()
  const stageTimings = []
  const tuning = store.getRetrievalTuning()
  const measureStage = async (label, work) => {
    const startedAt = Date.now()
    try {
      return await work()
    } finally {
      stageTimings.push(`${label}=${Date.now() - startedAt}ms`)
    }
  }

  const limit = Number(options.limit ?? 6)
  const lines = []
  const seenHintKeys = new Set()
  const queryTokenCount = Math.max(1, tokenizeMemoryText(clean).length)
  const profileSlot = detectProfileQuerySlot(clean)
  const queryVector = await measureStage('embed_query', () => embedText(clean))
  const focusVector = await measureStage('build_focus', () => store.buildRecentFocusVector({
    channelId: options.channelId,
    userId: options.userId,
  }))
  const intent = await measureStage('classify_intent', () => store.classifyQueryIntent(clean, queryVector, { tuning }))
  const topTaskHint = store.db.prepare(`
    SELECT workstream
    FROM tasks
    WHERE status IN ('active', 'in_progress', 'paused')
      AND workstream IS NOT NULL
      AND workstream != ''
    ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, retrieval_count DESC, last_seen DESC
    LIMIT 1
  `).get()?.workstream ?? ''

  const pushHint = (item, overrides = {}) => {
    const rawText = String(overrides.text ?? item.content ?? item.text ?? item.value ?? '').trim()
    if (!rawText) return
    const hintType = String(overrides.type ?? item?.type ?? 'episode')
    const hintSubtype = String(overrides.subtype ?? item?.subtype ?? item?.kind ?? '').trim()
    const hintStage = String(overrides.stage ?? item?.stage ?? item?.status ?? '').toLowerCase()
    const overlapCount = Number(item?.overlapCount ?? 0)
    if (hintType === 'task' && intent.primary !== 'task') {
      const isActiveStage = hintStage === 'implementing' || hintStage === 'wired' || hintStage === 'verified' || hintStage === 'in_progress' || hintStage === 'investigating'
      if (!isActiveStage || overlapCount < 1) return
    }
    if (intent.primary === 'profile' && profileSlot) {
      if (hintType === 'profile' && hintSubtype !== profileSlot) return
      if (hintType === 'signal' && hintSubtype !== profileSlot && !(profileSlot === 'response_style' && hintSubtype === 'tone')) return
    }
    if (!shouldInjectHint(item, overrides, { queryTokenCount, hintConfig: tuning.hintInjection })) return
    const key = buildHintKey(item, overrides)
    if (!key) return
    if (seenHintKeys.has(key)) return
    seenHintKeys.add(key)
    lines.push(formatHintTag(item, overrides, { queryTokenCount, nowTs: totalStartedAt }))
  }

  const coreMemory = await measureStage('core_memory', () => store.getCoreMemoryItems(clean, intent, queryVector))
  if (coreMemory.length > 0) {
    for (const item of coreMemory) {
      pushHint(item)
    }
  }

  if (intent.primary === 'task') {
    const priorityTasks = await measureStage('priority_tasks', () => store.getPriorityTasks(clean, {
      channelId: options.channelId,
      userId: options.userId,
      focusVector,
      workstreamHint: topTaskHint,
      limit: 3,
    }))
    if (priorityTasks.length > 0) {
      for (const task of priorityTasks) {
        const detail = task.details ? ` — ${task.details}` : ''
        pushHint(task, { type: 'task', text: `${task.title}${detail}` })
      }
    }
  }

  let relevant = await measureStage('hybrid_search', () => store.searchRelevantHybrid(clean, limit, {
    queryVector,
    intent,
    focusVector,
    channelId: options.channelId,
    userId: options.userId,
    recordRetrieval: false,
    tuning,
  }))
  if (intent.primary === 'profile') {
    relevant = relevant.filter(item => item.type === 'fact' || item.type === 'signal')
  }
  relevant = relevant.slice(0, Math.max(3, limit - 1))

  const hasFactInRelevant = relevant.some(item => item.type === 'fact')

  if (!hasFactInRelevant && (intent.primary === 'decision' || intent.primary === 'policy' || intent.primary === 'security')) {
    const queryTokens = new Set(tokenizeMemoryText(clean))
    const decisions = store.db.prepare(`
      SELECT fact_type AS type, 'fact' AS hintType, text AS content, confidence, last_seen
      FROM facts
      WHERE status = 'active'
        AND fact_type IN ('decision', 'constraint')
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT 5
    `).all()
    const relevantDecisions = decisions.filter(d => {
      const factTokens = tokenizeMemoryText(d.content)
      return factTokens.some(t => queryTokens.has(t))
    }).slice(0, 3)
    for (const item of relevantDecisions) {
      pushHint(item, { type: 'fact' })
    }
  }

  if (relevant.length > 0) {
    for (const item of relevant) {
      pushHint(item)
    }

    const hasSignal = intent.primary === 'profile' && relevant.some(item => item.type === 'signal')
    if (hasSignal) {
      const seenSignals = new Set(
        relevant
          .filter(item => item.type === 'signal')
          .map(item => `${item.subtype}:${item.content}`),
      )
      const extraSignals = store.db.prepare(`
        SELECT kind, value, score, last_seen
        FROM signals
        ORDER BY score DESC, retrieval_count DESC, last_seen DESC
        LIMIT 3
      `).all()
        .map(item => ({
          ...item,
          effectiveScore: decaySignalScore(item.score, item.last_seen, item.kind),
        }))
        .filter(item => item.effectiveScore >= 0.45)
        .filter(item => !seenSignals.has(`${item.kind}:${item.value}`))
        .slice(0, 1)
      for (const signal of extraSignals) {
        pushHint(signal, { type: 'signal', confidence: signal.effectiveScore, text: signal.value })
      }
    }
  } else {
    const facts = store.db.prepare(`
      SELECT fact_type, text, confidence, last_seen
      FROM facts
      WHERE status = 'active'
      ORDER BY
        CASE fact_type
          WHEN 'preference' THEN 1
          WHEN 'constraint' THEN 2
          WHEN 'decision' THEN 3
          ELSE 4
        END,
        confidence DESC,
        mention_count DESC,
        last_seen DESC
      LIMIT 4
    `).all()
    for (const fact of facts) {
      const confidence = decayConfidence(fact.confidence, fact.last_seen)
      if (confidence < 0.25) continue
      pushHint(fact, { type: 'fact', confidence })
    }

    const tasks = store.db.prepare(`
      SELECT title, status, confidence, last_seen, stage
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        last_seen DESC
      LIMIT 3
    `).all()
    for (const task of tasks) {
      const confidence = decayConfidence(task.confidence, task.last_seen)
      if (confidence < 0.25) continue
      pushHint(task, { type: 'task', text: task.title, confidence })
    }

    const signals = store.db.prepare(`
      SELECT kind, value, score, last_seen
      FROM signals
      ORDER BY score DESC, last_seen DESC
      LIMIT 3
    `).all()
    const activeSignals = signals
      .map(item => ({
        ...item,
        effectiveScore: decaySignalScore(item.score, item.last_seen, item.kind),
      }))
      .filter(item => item.effectiveScore >= 0.45)
    for (const signal of activeSignals) {
      pushHint(signal, { type: 'signal', confidence: signal.effectiveScore, text: signal.value })
    }
  }

  if (lines.length > 0) {
    try {
      let recentTopics = []
      if (options.channelId) {
        recentTopics = store.db.prepare(`
          SELECT content FROM episodes
          WHERE role = 'user'
            AND kind = 'message'
            AND channel_id = ?
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 200
            AND ts >= datetime('now', '-1 day')
          ORDER BY ts DESC
          LIMIT 3
        `).all(String(options.channelId))
      }
      if (recentTopics.length === 0 && options.userId) {
        recentTopics = store.db.prepare(`
          SELECT content FROM episodes
          WHERE role = 'user'
            AND kind = 'message'
            AND user_id = ?
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 200
            AND ts >= datetime('now', '-1 day')
          ORDER BY ts DESC
          LIMIT 3
        `).all(String(options.userId))
      }
      if (recentTopics.length > 0) {
        lines.push('<recent>' + recentTopics.map(r => cleanMemoryText(r.content).slice(0, 40)).join(' / ') + '</recent>')
      }
    } catch {}
  }

  if (lines.length === 0) return ''
  const ctx = `<memory-context>\n${lines.join('\n')}\n</memory-context>`
  const totalMs = Date.now() - totalStartedAt
  process.stderr.write(
    `[memory-timing] q="${clean.slice(0, 40)}" total=${totalMs}ms ${stageTimings.join(' ')}\n`,
  )
  process.stderr.write(`[memory] recall q="${clean.slice(0, 40)}" intent=${intent.primary} hints=${lines.filter(l => l.startsWith('<hint ')).length}\n`)
  return ctx
}
