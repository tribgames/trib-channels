#!/usr/bin/env node
/**
 * memory-service.mjs — MCP server + HTTP hybrid memory service.
 *
 * Single Node.js process providing:
 *   MCP (stdio)  — recall_memory, memory_cycle tools for Claude Code
 *   HTTP (tcp)   — /hints, /episode, /health for hooks + internal use
 *
 * Owns the MemoryStore singleton exclusively.
 * Port: 3350-3357 (written to $TMPDIR/claude2bot/memory-port)
 */

import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding } from '../lib/embedding-provider.mjs'
import {
  sleepCycle,
  memoryFlush,
  rebuildRecent,
  pruneToRecent,
  getCycleStatus,
  runCycle1,
  buildSemanticDayPlan,
  readMainConfig,
} from '../lib/memory-cycle.mjs'

// ── Configuration ────────────────────────────────────────────────────

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || process.argv[2]
if (!DATA_DIR) {
  process.stderr.write('[memory-service] CLAUDE_PLUGIN_DATA or argv[2] required\n')
  process.exit(1)
}

const PORT_FILE = path.join(os.tmpdir(), 'claude2bot', 'memory-port')
const BASE_PORT = 3350
const MAX_PORT = 3357

// ── Temporal parser (optional Python dateparser) ─────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const venvPythonUnix = path.join(__dirname, '.venv', 'bin', 'python3')
const venvPythonWin = path.join(__dirname, '.venv', 'Scripts', 'python.exe')
const mlPython = fs.existsSync(venvPythonUnix) ? venvPythonUnix : fs.existsSync(venvPythonWin) ? venvPythonWin : null
let temporalProcess = null
if (mlPython) {
  try {
    temporalProcess = spawn(mlPython, [path.join(__dirname, 'ml-service.py')], { stdio: 'ignore' })
    temporalProcess.on('exit', (code) => process.stderr.write(`[temporal] exited code=${code}\n`))
    process.stderr.write(`[temporal] spawned with ${mlPython}\n`)
  } catch (e) {
    process.stderr.write(`[temporal] spawn failed: ${e.message}\n`)
  }
} else {
  process.stderr.write(`[temporal] python venv not found, temporal parsing disabled\n`)
}

// ── Store initialization ─────────────────────────────────────────────

const mainConfig = readMainConfig()
const embeddingConfig = mainConfig?.embedding
if (embeddingConfig?.provider || embeddingConfig?.ollamaModel) {
  configureEmbedding({
    provider: embeddingConfig.provider,
    ollamaModel: embeddingConfig.ollamaModel,
  })
}

const store = getMemoryStore(DATA_DIR)
store.syncHistoryFromFiles()
if (store.countEpisodes() === 0) {
  try { store.backfillProject(process.cwd(), { limit: 80 }) } catch { /* best effort */ }
}
void store.warmupEmbeddings()
  .then(() => store.ensureEmbeddings({ perTypeLimit: 12 }))
  .catch(err => process.stderr.write(`[memory-service] embedding warmup failed: ${err}\n`))

// ── Cycle schedulers ─────────────────────────────────────────────────

// cycle1: fast extraction at configured interval (default 5m)
const cycle1Config = mainConfig?.memory?.cycle1 ?? {}
const cycle1IntervalStr = cycle1Config.interval || '5m'
const cycle1Ms = (() => {
  const m = cycle1IntervalStr.match(/^(\d+)(s|m|h)$/)
  if (!m) return 300_000
  const n = Number(m[1])
  return m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3600_000
})()

let cycle1Timer = null
function startCycle1Scheduler() {
  if (cycle1Timer) return
  cycle1Timer = setInterval(async () => {
    try {
      await runCycle1(store, mainConfig)
      process.stderr.write(`[cycle1] completed at ${new Date().toISOString()}\n`)
    } catch (e) {
      process.stderr.write(`[cycle1] error: ${e.message}\n`)
    }
  }, cycle1Ms)
  process.stderr.write(`[cycle1] scheduler started: interval=${cycle1IntervalStr} (${cycle1Ms}ms)\n`)
}

// cycle2: daily consolidation at configured time (default 03:00)
const cycle2Config = mainConfig?.memory?.cycle2 ?? {}
const cycle2Schedule = cycle2Config.schedule || '03:00'
const [cycle2Hour, cycle2Min] = cycle2Schedule.split(':').map(Number)
let lastCycle2Date = ''

function checkCycle2() {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  if (today === lastCycle2Date) return
  if (now.getHours() === cycle2Hour && now.getMinutes() >= cycle2Min) {
    lastCycle2Date = today
    sleepCycle(store, mainConfig).then(() => {
      process.stderr.write(`[cycle2] completed at ${now.toISOString()}\n`)
    }).catch(e => {
      process.stderr.write(`[cycle2] error: ${e.message}\n`)
    })
  }
}

// Check cycle2 every minute
setInterval(checkCycle2, 60_000)

// Start cycle1 after brief delay (let store warm up)
setTimeout(startCycle1Scheduler, 5000)

// ══════════════════════════════════════════════════════════════════════
//  SHARED HELPERS (used by both MCP and HTTP)
// ══════════════════════════════════════════════════════════════════════

function addUtcDays(value, days) {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

function monthRange(value) {
  const match = String(value).trim().match(/^(\d{4})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null
  const start = `${match[1]}-${match[2]}-01`
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
  const endDate = new Date(Date.UTC(nextMonth.year, nextMonth.month - 1, 1))
  endDate.setUTCDate(endDate.getUTCDate() - 1)
  return { start, end: endDate.toISOString().slice(0, 10) }
}

function parseTimerange(timerangeArg) {
  if (!timerangeArg) return { trStart: null, trEnd: null }
  const now = new Date()
  const localDate = (value) => {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  const today = localDate(now)
  const weekdayOffset = (now.getDay() + 6) % 7
  const weekStart = localDate(addUtcDays(now, -weekdayOffset))
  const lastWeekStart = localDate(addUtcDays(now, -(weekdayOffset + 7)))
  const lastWeekEnd = localDate(addUtcDays(now, -(weekdayOffset + 1)))
  const daysAgo = (n) => localDate(addUtcDays(now, -n))
  const normalized = String(timerangeArg).trim().toLowerCase()

  const dMatch = normalized.match(/^(\d+)d$/)
  const wMatch = normalized.match(/^(\d+)w$/)
  const rangeMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/)
  const dateMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})$/)
  const mRange = monthRange(normalized)

  if (dMatch) return { trStart: daysAgo(Number(dMatch[1])), trEnd: today }
  if (wMatch) return { trStart: daysAgo(Number(wMatch[1]) * 7), trEnd: today }
  if (normalized === 'today' || normalized === '오늘') return { trStart: today, trEnd: today }
  if (normalized === 'yesterday' || normalized === '어제') return { trStart: daysAgo(1), trEnd: daysAgo(1) }
  if (['this-week', 'this week', 'this_week', '이번주', '이번 주'].includes(normalized)) return { trStart: weekStart, trEnd: today }
  if (['last-week', 'last week', 'last_week', '지난주', '지난 주'].includes(normalized)) return { trStart: lastWeekStart, trEnd: lastWeekEnd }
  if (rangeMatch) return { trStart: rangeMatch[1], trEnd: rangeMatch[2] }
  if (mRange) return { trStart: mRange.start, trEnd: mRange.end }
  if (dateMatch) return { trStart: dateMatch[1], trEnd: dateMatch[1] }
  return { trStart: null, trEnd: null }
}

function buildSourceParts(row) {
  return [
    row.source_ref ? String(row.source_ref) : null,
    row.source_ts ? `ts:${String(row.source_ts)}` : null,
    row.source_kind ? `kind:${String(row.source_kind)}` : null,
    row.source_backend ? `backend:${String(row.source_backend)}` : null,
  ].filter(Boolean)
}

function formatEpisodeLine(ep, marker = ' ', useCompact = true, includeSource = false) {
  const role = useCompact ? (ep.role === 'user' ? 'u' : ep.role === 'assistant' ? 'a' : ep.role) : ep.role
  const ts = useCompact ? String(ep.ts ?? '').replace(/:\d{2}\.\d+/, '') : String(ep.ts ?? '')
  const sourceParts = includeSource ? buildSourceParts(ep) : []
  const sourceSuffix = sourceParts.length > 0 ? ` [source ${sourceParts.join(' | ')}]` : ''
  const markerPrefix = marker && marker !== ' ' ? `${marker}` : ''
  return `${markerPrefix}[${ts}] ${role}: ${String(ep.content ?? '')}${sourceSuffix}`
}

function formatDirectRows(rows) {
  if (rows.length === 0) return '(no matching memories found)'
  return rows.map(row => {
    const ts = String(row.last_seen ?? row.updated_at ?? row.ts ?? '').trim()
    const content = String(row.content ?? row.text ?? row.value ?? row.title ?? '').trim()
    const type = String(row.type ?? '')
    const subtype = String(row.subtype ?? '')
    const confidence = row.confidence ?? row.score ?? row.quality_score
    const meta = [
      type,
      subtype,
      confidence != null ? `conf:${Number(confidence).toFixed(2)}` : null,
    ].filter(Boolean).join(', ')
    const sourceParts = buildSourceParts(row)
    const source = sourceParts.length > 0 ? ` [source ${sourceParts.join(' | ')}]` : ''
    return `[${ts}] ${content} (${meta})${source}`
  }).join('\n')
}

// ── Recall handler (all modes) ───────────────────────────────────────

async function handleRecall(args) {
  const mode = String(args.mode ?? 'search')
  const query = String(args.query ?? '')
  const typeFilter = String(args.type ?? 'all')
  const limit = Number(args.limit ?? 5)
  const includeSource = Boolean(args.source ?? false)
  const contextArg = args.context
  const debug = Boolean(args.debug)
  const trace = Boolean(args.trace)
  const metadataFilters = {
    memory_kind: args.memory_kind,
    task_status: args.task_status,
    source_type: args.source_type,
    session_id: args.session_id,
  }
  const useCompact = args.compact !== false

  const { trStart, trEnd } = parseTimerange(args.timerange)
  const queryLower = query.toLowerCase().trim()
  const ftsQuery = query.replace(/['"*\-(){}[\]^~:]/g, ' ').replace(/\b(OR|AND|NOT|NEAR)\b/gi, '').trim()

  const filterRowsByMetadata = async (rows) => {
    return await store.applyMetadataFilters(rows, metadataFilters)
  }

  const inferredIntent = query
    ? await store.classifyQueryIntent(query)
    : { primary: 'decision', scores: {} }

  let effectiveMode = mode
  let effectiveType = typeFilter
  if (mode === 'search' && typeFilter === 'all' && query) {
    if (inferredIntent.primary === 'event' || (trStart && trEnd && inferredIntent.primary === 'history')) {
      effectiveMode = 'episodes'
      effectiveType = 'episodes'
    } else if (inferredIntent.primary === 'task') {
      effectiveMode = 'tasks'
      effectiveType = 'tasks'
    } else if (inferredIntent.primary === 'profile') {
      effectiveMode = 'profile'
      effectiveType = 'profiles'
    } else if (inferredIntent.primary === 'policy' || inferredIntent.primary === 'security') {
      effectiveMode = 'policy'
      effectiveType = 'facts'
    }
  }

  const loadProfileRows = async () => {
    return filterRowsByMetadata(store.getProfileRecallRows(query, limit))
  }

  const loadPolicyRows = async () => {
    const hybrid = await store.searchRelevantHybrid(query || '', limit, {
      intent: { primary: 'policy', scores: {} },
      filters: metadataFilters,
      recordRetrieval: false,
    })
    const rows = Array.isArray(hybrid) ? hybrid : (hybrid?.results ?? [])
    return filterRowsByMetadata(rows)
  }

  const loadEntityRows = async () => {
    return filterRowsByMetadata(store.getEntityRecallRows(query, limit))
  }

  const loadRelationRows = async () => {
    return filterRowsByMetadata(store.getRelationRecallRows(query, limit))
  }

  const loadDirectTypeRows = async (kind) => {
    if (kind === 'profiles') return await loadProfileRows()
    if (kind === 'entities') return await loadEntityRows()
    if (kind === 'relations') return await loadRelationRows()
    if (kind === 'facts') return await loadPolicyRows()
    return []
  }

  // ── mode: verify ──
  if (effectiveMode === 'verify') {
    if (!query) return { text: '(query required for verify mode)', isError: true }
    const { embedText } = await import('../lib/embedding-provider.mjs')
    const vector = await embedText(query)
    const verifyLimit = Math.min(limit, 3)
    const matches = await store.verifyMemoryClaim(query, {
      limit: verifyLimit,
      queryVector: vector,
      ftsQuery,
    })
    const best = matches[0]
    if (!best || !best.accepted) {
      return {
        text: JSON.stringify({
          matched: false,
          fact: null,
          query,
          best_candidate: best ? {
            fact: best.text ?? best.content ?? '',
            confidence: Number(best.confidence ?? best.similarity ?? 0).toFixed(2),
            lexical_overlap: Number(best.lexical_overlap ?? 0).toFixed(2),
            verify_score: Number(best.verify_score ?? 0).toFixed(2),
          } : null,
        }),
      }
    }
    return {
      text: JSON.stringify({
        matched: true,
        fact: best.text ?? best.content ?? '',
        mention_count: best.mention_count ?? 0,
        last_seen: best.last_seen ?? null,
        confidence: Number(best.confidence ?? best.similarity ?? 0).toFixed(2),
        lexical_overlap: Number(best.lexical_overlap ?? 0).toFixed(2),
        verify_score: Number(best.verify_score ?? 0).toFixed(2),
        status: best.status ?? 'active',
        all_matches: matches.map(m => ({
          fact: m.text ?? m.content ?? '',
          mention_count: m.mention_count ?? 0,
          confidence: Number(m.confidence ?? m.similarity ?? 0).toFixed(2),
          lexical_overlap: Number(m.lexical_overlap ?? 0).toFixed(2),
          verify_score: Number(m.verify_score ?? 0).toFixed(2),
        })),
      }),
    }
  }

  // ── mode: episodes ──
  if (effectiveMode === 'episodes') {
    if (!query && !(trStart && trEnd)) {
      const latestEpisodes = store.db.prepare(`
        SELECT id, ts, day_key, role, kind, content, source_ref, backend AS source_backend
        FROM episodes
        WHERE kind IN ('message', 'turn')
        ORDER BY ts DESC
        LIMIT ?
      `).all(limit)
      if (latestEpisodes.length === 0) return { text: '(no episodes found)' }
      return { text: latestEpisodes.map(ep => formatEpisodeLine(ep, ' ', useCompact, includeSource)).join('\n') }
    }

    let startDate, endDate
    if (trStart && trEnd) {
      startDate = trStart
      endDate = trEnd
    } else {
      const now = new Date()
      const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
      endDate = kst.toISOString().slice(0, 10)
      startDate = new Date(kst.getTime() - 3 * 86400000).toISOString().slice(0, 10)
    }

    const { embedText } = await import('../lib/embedding-provider.mjs')
    const vector = query ? await embedText(query) : []
    const episodes = await store.getEpisodeRecallRows({
      query,
      startDate,
      endDate,
      limit,
      queryVector: vector,
      ftsQuery,
      includeTranscripts: debug || metadataFilters.source_type === 'transcript',
    })

    if (episodes.length === 0) return { text: '(no episodes found in date range)' }
    const lines = episodes.map(ep => formatEpisodeLine(ep, ' ', useCompact, includeSource))
    const contextBlocks = []

    if (query && contextArg !== undefined) {
      for (const matched of episodes) {
        const matchedId = Number(matched.id ?? matched.entity_id ?? 0)
        if (!matchedId || !matched.day_key) continue
        const dayEpisodes = store.getEpisodesForDate(String(matched.day_key), {
          includeTranscripts: debug || metadataFilters.source_type === 'transcript',
        }).map(ep => ({
          ...ep,
          day_key: matched.day_key,
          source_ref: matched.source_ref ?? null,
          source_backend: matched.source_backend ?? null,
        }))
        if (contextArg === 'semantic') {
          const plan = await buildSemanticDayPlan(dayEpisodes)
          const idx = plan.rows.findIndex(row => Number(row.id) === matchedId)
          if (idx >= 0) {
            const seg = plan.segments.find(s => idx >= s.start && idx <= s.end)
            if (seg) {
              contextBlocks.push(`--- context (semantic, ${matched.day_key}) ---`)
              for (let i = seg.start; i <= seg.end; i += 1) {
                const row = dayEpisodes.find(ep => Number(ep.id) === Number(plan.rows[i]?.id))
                if (!row) continue
                contextBlocks.push(formatEpisodeLine(row, Number(row.id) === matchedId ? '*' : ' ', useCompact, includeSource))
              }
            }
          }
        } else {
          const n = Math.max(1, Number(contextArg))
          const matchIdx = dayEpisodes.findIndex(ep => Number(ep.id) === matchedId)
          if (matchIdx >= 0) {
            const start = Math.max(0, matchIdx - n)
            const end = Math.min(dayEpisodes.length - 1, matchIdx + n)
            contextBlocks.push(`--- context (+-${n}, ${matched.day_key}) ---`)
            for (let i = start; i <= end; i += 1) {
              contextBlocks.push(formatEpisodeLine(dayEpisodes[i], i === matchIdx ? '*' : ' ', useCompact, includeSource))
            }
          }
        }
      }
    }

    const output = contextBlocks.length > 0
      ? `--- matches ---\n${lines.join('\n')}\n\n${contextBlocks.join('\n')}`
      : lines.join('\n')
    return { text: output }
  }

  // ── mode: bulk ──
  if (effectiveMode === 'bulk') {
    const hints = args.hints
    if (!Array.isArray(hints) || hints.length === 0) {
      return { text: '(hints array required for bulk mode)', isError: true }
    }
    const { embedText: embedFn } = await import('../lib/embedding-provider.mjs')
    const summary = await store.bulkVerifyHints(hints, { embedFn })
    return { text: JSON.stringify(summary, null, useCompact ? 0 : 2) }
  }

  // ── mode: tasks ──
  if (effectiveMode === 'tasks') {
    const tasks = await filterRowsByMetadata(await store.getPriorityTasks(query, { limit }))
    store.recordRetrieval(tasks)
    const rows = tasks.map(task => ({
      type: 'task',
      subtype: task.stage,
      status: task.status,
      content: `${task.title}${task.details ? ` \u2014 ${task.details}` : ''}`,
      confidence: task.confidence,
      last_seen: task.last_seen,
    }))
    return { text: formatDirectRows(rows) }
  }

  // ── mode: policy ──
  if (effectiveMode === 'policy') {
    const rows = await loadPolicyRows()
    store.recordRetrieval(rows)
    return { text: formatDirectRows(rows) }
  }

  // ── mode: profile ──
  if (effectiveMode === 'profile') {
    const rows = await loadProfileRows()
    store.recordRetrieval(rows)
    return { text: formatDirectRows(rows) }
  }

  // ── mode: search (default) ──
  // Special query shortcuts
  if (['all', 'facts', 'episodes', 'profiles', 'tasks', 'signals', 'entities', 'relations'].includes(queryLower)) {
    const rows = await filterRowsByMetadata(
      store.getRecallShortcutRows(queryLower, limit, { startDate: trStart, endDate: trEnd }),
    )
    if (rows.length === 0) return { text: `(no ${queryLower} found)` }
    const lines = rows.map(r => {
      const ts = r.last_seen ?? ''
      const meta = [r.type, r.subtype, r.confidence ? `conf:${Number(r.confidence).toFixed(2)}` : null].filter(Boolean).join(', ')
      return `[${ts}] ${r.content} (${meta})`
    })
    return { text: lines.join('\n') }
  }

  // Special query: "hints"
  if (queryLower === 'hints') {
    const ctx = await store.buildInboundMemoryContext('general context check', {})
    return { text: ctx || '(no hints generated)' }
  }

  // Special query: "hint:1,3"
  const hintIdxMatch = queryLower.match(/^hint:(\d+(?:,\d+)*)$/)
  if (hintIdxMatch) {
    const ctx = await store.buildInboundMemoryContext('general context check', {})
    if (!ctx) return { text: '(no hints generated)' }
    const allHints = ctx.split('\n').filter(l => l.startsWith('<hint '))
    const indices = hintIdxMatch[1].split(',').map(Number)
    const selected = indices.filter(i => i >= 0 && i < allHints.length).map(i => allHints[i])
    return { text: selected.length > 0 ? selected.join('\n') : `(no hints at indices: ${indices.join(',')})` }
  }

  if (!query) return { text: '(query required for search mode)', isError: true }

  if (['profiles', 'entities', 'relations'].includes(effectiveType)) {
    const directRows = await loadDirectTypeRows(effectiveType)
    store.recordRetrieval(directRows)
    return { text: formatDirectRows(directRows) }
  }

  const hybrid = await store.searchRelevantHybrid(query, limit * 2, { debug, trace, filters: metadataFilters })
  const results = Array.isArray(hybrid) ? hybrid : (hybrid?.results ?? [])
  const debugPayload = !Array.isArray(hybrid) ? hybrid?.debug : null

  if (!results || results.length === 0) return { text: '(no matching memories found)' }

  const typeMap = { fact: 'facts', task: 'tasks', signal: 'signals', episode: 'episodes' }
  const filtered = results
    .filter(r => effectiveType === 'all' || typeMap[r.type] === effectiveType || r.type === effectiveType)
    .slice(0, limit)

  // Context expansion
  let contextEpisodes = []
  if (contextArg !== undefined) {
    const episodeResults = filtered.filter(r => r.type === 'episode')
    for (const r of episodeResults) {
      const matchedId = Number(r.entity_id ?? r.id ?? 0)
      if (!matchedId) continue
      const dayKey = store.getEpisodeDayKey(matchedId)
      if (!dayKey) continue
      const dayEpisodes = store.getEpisodesForDate(dayKey, {
        includeTranscripts: debug || metadataFilters.source_type === 'transcript',
      })
      if (contextArg === 'semantic') {
        const plan = await buildSemanticDayPlan(dayEpisodes)
        const idx = plan.rows.findIndex(row => Number(row.id) === matchedId)
        if (idx >= 0) {
          const seg = plan.segments.find(s => idx >= s.start && idx <= s.end)
          if (seg) {
            const startIdx = dayEpisodes.findIndex(e => Number(e.id) === Number(plan.rows[seg.start]?.id))
            const endIdx = dayEpisodes.findIndex(e => Number(e.id) === Number(plan.rows[seg.end]?.id))
            if (startIdx >= 0 && endIdx >= 0) {
              const slice = dayEpisodes.slice(startIdx, endIdx + 1)
              contextEpisodes.push(`--- context (semantic segment, ${dayKey}) ---`)
              for (const ep of slice) {
                const role = useCompact ? (ep.role === 'user' ? 'u' : 'a') : ep.role
                const ts = useCompact ? String(ep.ts ?? '').replace(/:\d{2}\.\d+/, '') : String(ep.ts ?? '')
                contextEpisodes.push(`[${ts}] ${role}: ${ep.content}`)
              }
            }
          }
        }
      } else {
        const n = Math.max(1, Number(contextArg))
        const matchIdx = dayEpisodes.findIndex(e => Number(e.id) === matchedId)
        if (matchIdx >= 0) {
          const start = Math.max(0, matchIdx - n)
          const end = Math.min(dayEpisodes.length - 1, matchIdx + n)
          contextEpisodes.push(`--- context (+-${n}, ${dayKey}) ---`)
          for (let i = start; i <= end; i++) {
            const ep = dayEpisodes[i]
            const role = useCompact ? (ep.role === 'user' ? 'u' : 'a') : ep.role
            const ts = useCompact ? String(ep.ts ?? '').replace(/:\d{2}\.\d+/, '') : String(ep.ts ?? '')
            const marker = i === matchIdx ? '*' : ' '
            contextEpisodes.push(`${marker}[${ts}] ${role}: ${ep.content}`)
          }
        }
      }
    }
  }

  const formatted = filtered.map(r => {
    const ts = r.updated_at ?? r.source_ts
    const date = ts ? new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts).toLocaleString() : 'unknown'
    const meta = [
      r.type,
      r.subtype ? `subtype:${String(r.subtype)}` : null,
      r.retrieval_count ? `retrieved:${r.retrieval_count}` : null,
    ].filter(Boolean).join(', ')
    let line = `[${date}] ${r.content || r.text || ''} (${meta})`
    if (includeSource) {
      const sourceParts = buildSourceParts(r)
      if (sourceParts.length > 0) line += `\n  \u2514 source: ${sourceParts.join(' | ')}`
    }
    return line
  }).join('\n')

  const output = contextEpisodes.length > 0
    ? `${formatted}\n\n${contextEpisodes.join('\n')}`
    : formatted

  const finalText = debug && debugPayload
    ? `${output || '(no matching memories found)'}\n\n--- debug ---\n${JSON.stringify(debugPayload, null, useCompact ? 0 : 2)}`
    : (output || '(no matching memories found)')

  return { text: finalText }
}

// ── Cycle handler ────────────────────────────────────────────────────

async function handleCycle(args) {
  const action = String(args.action ?? '')
  const ws = process.cwd()
  const config = readMainConfig()

  if (action === 'status') {
    return { text: JSON.stringify(getCycleStatus(), null, 2) }
  }
  if (action === 'sleep') {
    await sleepCycle(ws)
    return { text: 'Memory cycle completed.' }
  }
  if (action === 'flush') {
    await memoryFlush(ws, { maxDays: Number(args.maxDays ?? 1) })
    return { text: 'Memory flush completed.' }
  }
  if (action === 'rebuild') {
    await rebuildRecent(ws, { maxDays: Number(args.maxDays ?? 2) })
    return { text: 'Memory rebuild completed.' }
  }
  if (action === 'prune') {
    await pruneToRecent(ws, { maxDays: Number(args.maxDays ?? 5) })
    return { text: 'Memory prune completed.' }
  }
  if (action === 'cycle1') {
    const c1result = await runCycle1(ws, config)
    return { text: `Cycle1 completed: ${JSON.stringify(c1result)}` }
  }
  return { text: `unknown memory action: ${action}`, isError: true }
}

// ══════════════════════════════════════════════════════════════════════
//  MCP SERVER (stdio transport — Claude Code tools)
// ══════════════════════════════════════════════════════════════════════

const mcp = new Server(
  { name: 'memory-service', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

// ── Tool definitions (copied from server.ts) ─────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_cycle',
      annotations: { title: 'Memory Cycle' },
      description: 'Run memory management operations: sleep (merged update), flush (consolidate pending), rebuild (recent), prune (cleanup), cycle1 (fast update), status.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['sleep', 'flush', 'rebuild', 'prune', 'cycle1', 'status'], description: 'Memory operation to run' },
          maxDays: { type: 'number', description: 'Max days to process (default varies by action)' },
        },
        required: ['action'],
      },
    },
    {
      name: 'recall_memory',
      annotations: { title: 'Memory Recall' },
      description: 'Search memory DB for relevant facts, tasks, signals, profiles, entities, relations, and episodes. Use silently.\n\nParameters:\n- mode: search | verify | episodes | bulk | tasks | policy | profile\n- query: target fact/event/rule/profile/work description; optional for episodes when timerange-only browsing is intended\n- timerange: optional date filter for all modes, formats: "today", "this-week", "3d", "1w", "2026-03", "2026-03-28", "2026-03-25~2026-03-28"\n- type: optional search-only filter\n- hints: bulk-only\n- source/context: episodes-only when trace or nearby turns are needed\n\nSearch guide:\n- date-only recall -> episodes + timerange\n- event/topic recall -> episodes + query (+ timerange if known)\n- rule/restriction recall -> verify or policy\n- current work recall -> tasks\n- language/tone/address recall -> profile\n\nCanonical calls:\n- recall_memory(mode="episodes", timerange="2026-03-28")\n- recall_memory(mode="episodes", query="event", timerange="2026-03-28", context=2, source=true)\n- recall_memory(mode="policy", query="rule or restriction")\n- recall_memory(mode="tasks", query="current work")\n- recall_memory(mode="profile", query="language or tone")\n- recall_memory(mode="verify", query="claim")',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text or shortcut. Shortcuts: "all", "hints", "hint:0,2", "facts", "episodes", "profiles", "tasks", "signals", "entities", "relations". Free text for normal recall. Optional in episodes mode if timerange-only browsing is intended.' },
          mode: { type: 'string', enum: ['search', 'verify', 'episodes', 'bulk', 'tasks', 'policy', 'profile'], default: 'search', description: 'Recall strategy.' },
          type: { type: 'string', enum: ['all', 'facts', 'tasks', 'signals', 'episodes', 'profiles', 'entities', 'relations'], default: 'all', description: 'Search-only memory type filter.' },
          timerange: { type: 'string', description: 'Time filter for all modes. Formats: "today", "this-week", "3d"(days), "1w"(weeks), "2026-03"(month), "2026-03-28"(date), "2026-03-25~2026-03-28"(range)' },
          limit: { type: 'number', default: 5, description: 'Max results' },
          source: { type: 'boolean', default: false, description: 'Episodes-only: include source trace.' },
          context: { type: ['number', 'string'], description: 'Episodes-only: surrounding turns count or "semantic".' },
          compact: { type: 'boolean', default: true, description: 'Use u/a shorthand for episodes' },
          memory_kind: { type: 'string', enum: ['fact', 'task', 'signal', 'profile', 'entity', 'relation', 'episode', 'proposition'], description: 'Optional metadata filter for a specific memory kind.' },
          task_status: { type: 'string', enum: ['active', 'in_progress', 'paused', 'done'], description: 'Optional metadata filter for task status.' },
          source_type: { type: 'string', description: 'Optional metadata filter for source kind/backend, e.g. message, transcript, discord, claude-session.' },
          session_id: { type: 'string', description: 'Optional metadata filter for a specific source session id.' },
          trace: { type: 'boolean', default: false, description: 'Persist a retrieval trace JSONL record under history for later inspection.' },
          debug: { type: 'boolean', default: false, description: 'Include query plan / candidate / rerank debug summary for inspection.' },
          hints: { type: 'array', items: { type: 'string' }, description: 'Bulk-only: hint list to verify.' },
        },
        required: [],
      },
    },
  ],
}))

// ── Tool call handler ────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const toolName = req.params.name
  const args = req.params.arguments ?? {}

  try {
    if (toolName === 'recall_memory') {
      const result = await handleRecall(args)
      return {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError || false,
      }
    }

    if (toolName === 'memory_cycle') {
      const result = await handleCycle(args)
      return {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError || false,
      }
    }

    return {
      content: [{ type: 'text', text: `unknown tool: ${toolName}` }],
      isError: true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${toolName} failed: ${msg}` }],
      isError: true,
    }
  }
})

// ══════════════════════════════════════════════════════════════════════
//  HTTP SERVER (tcp — hooks + internal use)
// ══════════════════════════════════════════════════════════════════════

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 0)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res, msg, status = 500) {
  sendJson(res, { error: msg }, status)
}

const httpServer = http.createServer(async (req, res) => {
  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    try {
      const episodeCount = store.countEpisodes()
      const factsCount = store.db.prepare('SELECT COUNT(*) AS n FROM facts WHERE status = ?').get('active')?.n ?? 0
      const tasksCount = store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE status IN (?, ?, ?)').get('active', 'in_progress', 'paused')?.n ?? 0
      const signalsCount = store.db.prepare('SELECT COUNT(*) AS n FROM signals').get()?.n ?? 0
      sendJson(res, { status: 'ok', episodeCount, factsCount, tasksCount, signalsCount })
    } catch (e) {
      sendError(res, e.message)
    }
    return
  }

  // GET /hints (query string — for UserPromptSubmit hook compatibility)
  if (req.method === 'GET' && req.url?.startsWith('/hints')) {
    const url = new URL(req.url, 'http://localhost')
    const q = url.searchParams.get('q') || ''
    if (!q || q.length < 3) {
      sendJson(res, { hints: '' })
      return
    }
    try {
      const ctx = await store.buildInboundMemoryContext(q, { skipLowSignal: true })
      sendJson(res, { hints: ctx || '' })
    } catch {
      sendJson(res, { hints: '' })
    }
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, { error: 'Method not allowed' }, 405)
    return
  }

  const body = await readBody(req)

  try {
    // POST /hints (JSON body)
    if (req.url === '/hints') {
      const q = String(body.query ?? '').trim()
      if (!q || q.length < 3) {
        sendJson(res, { hints: '' })
        return
      }
      const ctx = await store.buildInboundMemoryContext(q, body.options ?? { skipLowSignal: true })
      sendJson(res, { hints: ctx || '' })
      return
    }

    // POST /episode
    if (req.url === '/episode') {
      const id = store.appendEpisode({
        ts: body.ts || new Date().toISOString(),
        backend: body.backend || 'claude2bot',
        channelId: body.channelId || null,
        userId: body.userId || null,
        userName: body.userName || null,
        sessionId: body.sessionId || null,
        role: body.role || 'user',
        kind: body.kind || 'message',
        content: body.content || '',
        sourceRef: body.sourceRef || null,
      })
      sendJson(res, { ok: true, id })
      return
    }

    // POST /context
    if (req.url === '/context') {
      store.writeContextFile()
      sendJson(res, { ok: true })
      return
    }

    // POST /ingest-transcript
    if (req.url === '/ingest-transcript') {
      const filePath = body.filePath
      if (!filePath) {
        sendJson(res, { error: 'filePath required' }, 400)
        return
      }
      try {
        store.ingestTranscriptFile(filePath)
        sendJson(res, { ok: true })
      } catch (e) {
        sendJson(res, { error: e.message }, 500)
      }
      return
    }

    sendJson(res, { error: 'Not found' }, 404)
  } catch (e) {
    process.stderr.write(`[memory-service] ${req.url} error: ${e.stack || e.message}\n`)
    sendError(res, e.message)
  }
})

// ══════════════════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════════════════

// ── HTTP port binding ────────────────────────────────────────────────

function writePortFile(port) {
  const dir = path.dirname(PORT_FILE)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  fs.writeFileSync(PORT_FILE, String(port))
}

function removePortFile() {
  try { fs.unlinkSync(PORT_FILE) } catch {}
}

let activePort = BASE_PORT
function tryListen() {
  httpServer.listen(activePort, '127.0.0.1', () => {
    writePortFile(activePort)
    process.stderr.write(`[memory-service] HTTP listening on 127.0.0.1:${activePort}\n`)
  })
}

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && activePort < MAX_PORT) {
    activePort++
    tryListen()
  } else {
    process.stderr.write(`[memory-service] HTTP fatal: ${err.message}\n`)
    process.exit(1)
  }
})

tryListen()

// ── MCP stdio transport ──────────────────────────────────────────────

const transport = new StdioServerTransport()
await mcp.connect(transport)
process.stderr.write('[memory-service] MCP stdio connected\n')

// ── Graceful shutdown ────────────────────────────────────────────────

function shutdown() {
  process.stderr.write('[memory-service] shutting down...\n')
  try { temporalProcess?.kill() } catch {}
  removePortFile()
  void mcp.close()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
