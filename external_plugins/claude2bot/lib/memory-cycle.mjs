/**
 * memory-cycle.mjs — Memory consolidation, compression, and summarize cycle.
 * Standalone memory consolidation module.
 */

import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { cleanMemoryText, getMemoryStore } from './memory.mjs'
import { embedText } from './embedding-provider.mjs'
import { callLLM } from './llm-provider.mjs'

const PLUGIN_DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'claude2bot-claude2bot')
const HISTORY_DIR = join(PLUGIN_DATA_DIR, 'history')
const CONFIG_PATH = join(PLUGIN_DATA_DIR, 'memory-cycle.json')

const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude'
const MAX_MEMORY_CONSOLIDATE_DAYS = 2
const MAX_MEMORY_CANDIDATES_PER_DAY = 40
const MAX_MEMORY_CONSOLIDATE_BATCHES_PER_DAY = 4
const MAX_MEMORY_CONTEXTUALIZE_ITEMS = 24
const MEMORY_FLUSH_DEFAULT_MAX_DAYS = 1
const MEMORY_FLUSH_DEFAULT_MAX_CANDIDATES = 20
const MEMORY_FLUSH_DEFAULT_MAX_BATCHES = 1
const MEMORY_FLUSH_DEFAULT_MIN_PENDING = 8

// Tier 2 (Auto-flush) thresholds
const AUTO_FLUSH_THRESHOLD = 15
const AUTO_FLUSH_INTERVAL_MS = 2 * 60 * 60 * 1000  // 2 hours

function getStore() {
  return getMemoryStore(PLUGIN_DATA_DIR)
}

function readCycleConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

function writeCycleConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

function resourceDir() {
  return process.env.CLAUDE_PLUGIN_ROOT || join(PLUGIN_DATA_DIR, '..', '..', 'cache', 'claude2bot', 'claude2bot', '0.0.1')
}

function claudeMemoryPromptArgs() {
  return [
    '-p',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--plugin-dir', join(tmpdir(), 'claude2bot-noplugin'),
    '--model', 'sonnet',
    '--effort', 'medium',
  ]
}

function execClaudePrompt(prompt, options = {}) {
  mkdirSync(join(tmpdir(), 'claude2bot-noplugin'), { recursive: true })
  return execFileSync(claudeCmd, [
    ...claudeMemoryPromptArgs(),
    '--cwd', options.cwd ?? process.cwd(),
    '--timeout-ms', String(Number(options.timeout ?? 120000)),
    '--prompt', prompt,
  ], {
    encoding: 'utf8',
    timeout: Number(options.timeout ?? 120000) + 2000,
    env: { ...process.env, CLAUDE2BOT_NO_CONNECT: '1', TRIB_SEARCH_SPAWNED: '1' },
  }).trim()
}

function spawnClaudePrompt(input, options = {}) {
  mkdirSync(join(tmpdir(), 'claude2bot-noplugin'), { recursive: true })
  return spawnSync(claudeCmd, [
    ...claudeMemoryPromptArgs(),
    '--cwd', options.cwd ?? process.cwd(),
    '--timeout-ms', String(Number(options.timeout ?? 600000)),
  ], {
    cwd: options.cwd,
    input,
    encoding: 'utf8',
    timeout: Number(options.timeout ?? 600000) + 2000,
    env: { ...process.env, CLAUDE2BOT_NO_CONNECT: '1', TRIB_SEARCH_SPAWNED: '1' },
  })
}

function extractJsonObject(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) } catch { return null }
}

function containsHangul(text) {
  return /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(String(text ?? ''))
}

function jsonPayloadContainsHangul(value) {
  if (typeof value === 'string') return containsHangul(value)
  if (Array.isArray(value)) return value.some(item => jsonPayloadContainsHangul(item))
  if (value && typeof value === 'object') return Object.values(value).some(item => jsonPayloadContainsHangul(item))
  return false
}

function normalizeJsonPayloadToEnglish(payload, ws, options = {}) {
  if (!payload || typeof payload !== 'object' || !jsonPayloadContainsHangul(payload)) return payload
  const label = String(options.label ?? 'memory payload').trim() || 'memory payload'
  const serialized = JSON.stringify(payload, null, 2)
  const prompt = `Rewrite every natural-language string value in this ${label} JSON object into concise English.\nRules:\n- Return JSON only.\n- Preserve the exact JSON shape, keys, arrays, nulls, booleans, and numbers.\n- Preserve proper nouns, product names, file paths, URLs, emails, IDs, numbers, code symbols.\n- Avoid Hangul unless it is part of an exact identifier or proper noun.\n\n${serialized}`
  try {
    const rewritten = extractJsonObject(execClaudePrompt(prompt, { cwd: ws, timeout: Number(options.timeout ?? 120000) }))
    return rewritten && typeof rewritten === 'object' ? rewritten : payload
  } catch { return payload }
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))))]
}

async function buildSemanticDayPlan(dayEpisodes) {
  const rows = dayEpisodes.map((ep, i) => ({ index: i, id: ep.id, role: ep.role, content: cleanMemoryText(ep.content ?? '') })).filter(r => r.content)
  if (rows.length <= 1) return { rows, segments: rows.length ? [{ start: 0, end: rows.length - 1 }] : [], threshold: 1 }
  const vectors = await Promise.all(rows.map(r => embedText(String(r.content).slice(0, 320))))
  const similarities = []
  for (let i = 0; i < vectors.length - 1; i++) similarities.push(cosineSimilarity(vectors[i], vectors[i + 1]))
  const threshold = Math.max(0.42, percentile(similarities, 35))
  const segments = []
  let start = 0
  for (let i = 0; i < similarities.length; i++) { if (similarities[i] < threshold) { segments.push({ start, end: i }); start = i + 1 } }
  segments.push({ start, end: rows.length - 1 })
  return { rows, segments, threshold }
}

function buildCandidateSpan(dayEpisodes, episodeId, semanticPlan) {
  const targetIndex = dayEpisodes.findIndex(item => Number(item.id) === Number(episodeId))
  if (targetIndex < 0) return ''
  let start = Math.max(0, targetIndex - 1), end = Math.min(dayEpisodes.length - 1, targetIndex + 2)
  if (semanticPlan?.rows?.length) {
    const si = semanticPlan.rows.findIndex(item => Number(item.id) === Number(episodeId))
    if (si >= 0) {
      const seg = semanticPlan.segments.find(s => si >= s.start && si <= s.end)
      if (seg) {
        const sr = semanticPlan.rows[Math.max(0, seg.start - 1)]
        const er = semanticPlan.rows[Math.min(semanticPlan.rows.length - 1, seg.end + 1)]
        if (sr) { const idx = dayEpisodes.findIndex(e => Number(e.id) === Number(sr.id)); if (idx >= 0) start = idx }
        if (er) { const idx = dayEpisodes.findIndex(e => Number(e.id) === Number(er.id)); if (idx >= 0) end = idx }
      }
    }
  }
  const rows = []
  for (let i = start; i <= end && rows.length < 6; i++) {
    const cleaned = cleanMemoryText(dayEpisodes[i]?.content ?? '')
    if (cleaned) rows.push(`${i === targetIndex ? '*' : '-'} ${dayEpisodes[i].role === 'user' ? 'user' : 'assistant'}: ${cleaned}`)
  }
  return rows.join('\n')
}

async function prepareConsolidationCandidates(candidates, maxPerBatch, dayEpisodes = []) {
  const seen = new Set()
  const prepared = []
  const plan = await buildSemanticDayPlan(dayEpisodes)
  for (const item of candidates) {
    const cleaned = cleanMemoryText(item?.content ?? '')
    if (!cleaned) continue
    const fp = cleaned.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!fp || seen.has(fp)) continue
    seen.add(fp)
    prepared.push({ ...item, content: cleaned, span_content: buildCandidateSpan(dayEpisodes, item?.episode_id, plan) || cleaned })
    if (prepared.length >= maxPerBatch) break
  }
  return prepared
}

// ── Public API ──

export async function consolidateCandidateDay(dayKey, ws, options = {}) {
  const store = getStore()
  const maxPerBatch = Math.max(1, Number(options.maxCandidatesPerBatch ?? MAX_MEMORY_CANDIDATES_PER_DAY))
  const maxBatches = Math.max(1, Number(options.maxBatches ?? MAX_MEMORY_CONSOLIDATE_BATCHES_PER_DAY))
  let processed = 0, mergedFacts = 0, mergedTasks = 0, mergedSignals = 0

  const promptPath = join(resourceDir(), 'defaults', 'memory-consolidate-prompt.md')
  const template = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : 'Output JSON only with facts/tasks/signals.'
  const dayEpisodes = store.getEpisodesForDate(dayKey)

  for (let batch = 0; batch < maxBatches; batch++) {
    const candidates = await prepareConsolidationCandidates(store.getCandidatesForDate(dayKey), maxPerBatch, dayEpisodes)
    if (candidates.length === 0) break
    const candidateText = candidates.map((item, i) => `#${i + 1} [${item.role}] score=${item.score}\nCandidate:\n${String(item.content).slice(0, 300)}\nContext:\n${String(item.span_content).slice(0, 800)}`).join('\n\n')
    const prompt = template.replace('{{DATE}}', dayKey).replace('{{CANDIDATES}}', candidateText)
    try {
      const raw = execClaudePrompt(prompt, { cwd: ws, timeout: 180000 })
      const parsed = extractJsonObject(raw)
      if (!parsed) { process.stderr.write(`[memory-cycle] consolidate ${dayKey}: invalid JSON\n`); break }
      const srcEp = candidates[0]?.episode_id ?? null
      const ts = `${dayKey}T23:59:59.000Z`
      store.upsertProfiles(parsed.profiles ?? [], ts, srcEp)
      await store.upsertFacts(parsed.facts ?? [], ts, srcEp)
      store.upsertTasks(parsed.tasks ?? [], ts, srcEp)
      store.upsertSignals(parsed.signals ?? [], srcEp, ts)
      store.upsertEntities(parsed.entities ?? [], ts, srcEp)
      store.upsertRelations(parsed.relations ?? [], ts, srcEp)
      store.markCandidateIdsConsolidated(candidates.map(item => item.id))
      processed += candidates.length
      mergedFacts += (parsed.facts ?? []).length
      mergedTasks += (parsed.tasks ?? []).length
      mergedSignals += (parsed.signals ?? []).length
    } catch (e) { process.stderr.write(`[memory-cycle] consolidate ${dayKey} failed: ${e.message}\n`); break }
  }
  if (processed > 0) process.stderr.write(`[memory-cycle] consolidated ${dayKey}: candidates=${processed}, facts=${mergedFacts}, tasks=${mergedTasks}, signals=${mergedSignals}\n`)
}

export async function consolidateRecent(dayKeys, ws, options = {}) {
  const targets = [...dayKeys].sort().reverse().slice(0, Math.max(1, Number(options.maxDays ?? MAX_MEMORY_CONSOLIDATE_DAYS))).sort()
  for (const dayKey of targets) await consolidateCandidateDay(dayKey, ws, options)
}

async function refreshEmbeddings(ws) {
  const store = getStore()
  // Contextualize items for better embeddings
  const promptPath = join(resourceDir(), 'defaults', 'memory-contextualize-prompt.md')
  let contextMap = new Map()
  if (existsSync(promptPath)) {
    const items = store.getEmbeddableItems({ perTypeLimit: Math.floor(MAX_MEMORY_CONTEXTUALIZE_ITEMS / 2) }).slice(0, MAX_MEMORY_CONTEXTUALIZE_ITEMS)
    if (items.length > 0) {
      const template = readFileSync(promptPath, 'utf8')
      const itemsText = items.map((item, i) => [`#${i + 1}`, `key=${item.key}`, `type=${item.entityType}`, item.subtype ? `subtype=${item.subtype}` : '', `content=${item.content}`].filter(Boolean).join('\n')).join('\n\n')
      try {
        const raw = execClaudePrompt(template.replace('{{ITEMS}}', itemsText), { cwd: ws, timeout: 180000 })
        const parsed = normalizeJsonPayloadToEnglish(extractJsonObject(raw), ws, { label: 'contextualization', timeout: 120000 })
        for (const row of parsed?.items ?? []) {
          if (row?.key && row?.context) contextMap.set(row.key, row.context)
        }
      } catch (e) { process.stderr.write(`[memory-cycle] contextualize failed: ${e.message}\n`) }
    }
  }
  const updated = await store.ensureEmbeddings({ perTypeLimit: Math.max(16, Math.floor(MAX_MEMORY_CONTEXTUALIZE_ITEMS / 2)), contextMap })
  process.stderr.write(`[memory-cycle] embeddings refreshed: ${updated}\n`)
}

export async function sleepCycle(ws) {
  const store = getStore()
  const now = Date.now()

  const config = readCycleConfig()
  const isFirstRun = !config.lastSleepAt && !existsSync(join(HISTORY_DIR, 'lifetime.md'))

  process.stderr.write(`[memory-cycle] Starting.${isFirstRun ? ' (FIRST RUN)' : ''}\n`)
  store.backfillProject(ws, { limit: 120 })

  mkdirSync(join(HISTORY_DIR, 'daily'), { recursive: true })

  // 1. Generate daily summaries
  const MAX_DAYS = 7
  const pendingDays = store.getPendingCandidateDays(MAX_DAYS, 1).map(d => d.day_key).sort()

  let generated = 0
  for (const date of pendingDays) {
    if (generated >= MAX_DAYS) break
    const dailyFile = join(HISTORY_DIR, 'daily', `${date}.md`)
    if (existsSync(dailyFile)) continue

    const episodes = store.getEpisodesForDate(date)
    const pingpong = episodes.filter(e => e.role === 'user' || e.role === 'assistant').map(e => `${e.role}: ${cleanMemoryText(e.content).slice(0, 400)}`).join('\n')
    if (!pingpong) continue

    const promptPath = join(resourceDir(), 'defaults', 'sleep-prompt.md')
    const template = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : 'Summarize the conversation below.'
    const prompt = template.replace('{{DATE}}', date).replace('{{HISTORY_DIR}}', HISTORY_DIR)
    try {
      const { status } = spawnClaudePrompt(prompt + '\n\n---\n\n' + pingpong, { cwd: ws, timeout: 600000 })
      if (status !== 0) throw new Error(`exit code ${status}`)
      generated++
      process.stderr.write(`[memory-cycle] Daily ${date} generated.\n`)
    } catch (e) { process.stderr.write(`[memory-cycle] daily failed for ${date}: ${e.message}\n`) }
  }

  // 2. Consolidation
  await consolidateRecent(pendingDays, ws)

  // 3. Sync + embeddings + context
  store.syncHistoryFromFiles()
  await refreshEmbeddings(ws)
  store.writeContextFile()

  // 4. Save timestamp
  writeCycleConfig({ ...config, lastSleepAt: now })
  process.stderr.write('[memory-cycle] Cycle complete.\n')
}

export async function summarizeOnly(ws) {
  const store = getStore()
  store.backfillProject(ws, { limit: 120 })
  const pendingDays = store.getPendingCandidateDays(3, 1).map(d => d.day_key).sort()
  for (const date of pendingDays) {
    const dailyFile = join(HISTORY_DIR, 'daily', `${date}.md`)
    if (existsSync(dailyFile)) continue
    mkdirSync(join(HISTORY_DIR, 'daily'), { recursive: true })
    const episodes = store.getEpisodesForDate(date)
    const pingpong = episodes.filter(e => e.role === 'user' || e.role === 'assistant').map(e => `${e.role}: ${cleanMemoryText(e.content).slice(0, 400)}`).join('\n')
    if (!pingpong) continue
    const promptPath = join(resourceDir(), 'defaults', 'sleep-prompt.md')
    const template = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : 'Summarize the conversation below.'
    try {
      spawnClaudePrompt(template.replace('{{DATE}}', date).replace('{{HISTORY_DIR}}', HISTORY_DIR) + '\n\n---\n\n' + pingpong, { cwd: ws, timeout: 600000 })
      process.stderr.write(`[memory-cycle] summarized ${date}\n`)
    } catch (e) { process.stderr.write(`[memory-cycle] summarize failed: ${e.message}\n`) }
  }
  // Consolidate candidates extracted during summarization
  const candidateDays = store.getPendingCandidateDays(3, 1).map(d => d.day_key).sort()
  if (candidateDays.length > 0) await consolidateRecent(candidateDays, ws)
  await refreshEmbeddings(ws)
  store.syncHistoryFromFiles()
  store.writeContextFile()
}

export async function memoryFlush(ws, options = {}) {
  const store = getStore()
  const maxDays = Math.max(1, Number(options.maxDays ?? MEMORY_FLUSH_DEFAULT_MAX_DAYS))
  const maxPerBatch = Math.max(1, Number(options.maxCandidatesPerBatch ?? MEMORY_FLUSH_DEFAULT_MAX_CANDIDATES))
  const maxBatches = Math.max(1, Number(options.maxBatches ?? MEMORY_FLUSH_DEFAULT_MAX_BATCHES))
  const minPending = Math.max(1, Number(options.minPending ?? MEMORY_FLUSH_DEFAULT_MIN_PENDING))
  const pendingDays = store.getPendingCandidateDays(maxDays * 3, minPending)
  if (!pendingDays.length) { process.stderr.write('[memory-cycle] no flushable batches.\n'); return }
  const targets = pendingDays.map(d => d.day_key).sort().slice(0, maxDays)
  for (const dayKey of targets) await consolidateCandidateDay(dayKey, ws, { maxCandidatesPerBatch: maxPerBatch, maxBatches })
  await refreshEmbeddings(ws)
  store.writeContextFile()
}

export async function rebuildAll(ws) {
  const store = getStore()
  store.backfillProject(ws, { limit: 400 })
  store.syncHistoryFromFiles()
  store.resetConsolidatedMemory()
  const dayKeys = store.getPendingCandidateDays(10000, 1).map(d => d.day_key).sort()
  if (!dayKeys.length) { process.stderr.write('[memory-cycle] no candidate days.\n'); return }
  for (const dayKey of dayKeys) await consolidateCandidateDay(dayKey, ws, { maxCandidatesPerBatch: MAX_MEMORY_CANDIDATES_PER_DAY, maxBatches: 999 })
  store.syncHistoryFromFiles()
  await refreshEmbeddings(ws)
  store.writeContextFile()
  process.stderr.write(`[memory-cycle] rebuilt ${dayKeys.length} day(s).\n`)
}

export async function rebuildRecent(ws, options = {}) {
  const store = getStore()
  store.backfillProject(ws, { limit: 240 })
  store.syncHistoryFromFiles()
  const maxDays = Math.max(1, Number(options.maxDays ?? 2))
  const dayKeys = store.getRecentCandidateDays(maxDays).map(d => d.day_key).sort()
  if (!dayKeys.length) { process.stderr.write('[memory-cycle] no recent days.\n'); return }
  store.resetConsolidatedMemoryForDays(dayKeys)
  for (const dayKey of dayKeys) await consolidateCandidateDay(dayKey, ws, options)
  store.syncHistoryFromFiles()
  await refreshEmbeddings(ws)
  store.writeContextFile()
  process.stderr.write(`[memory-cycle] rebuilt recent ${dayKeys.length} day(s).\n`)
}

export async function pruneToRecent(ws, options = {}) {
  const store = getStore()
  store.backfillProject(ws, { limit: 240 })
  store.syncHistoryFromFiles()
  const maxDays = Math.max(1, Number(options.maxDays ?? 5))
  const dayKeys = store.getRecentCandidateDays(maxDays).map(d => d.day_key).sort()
  if (!dayKeys.length) { process.stderr.write('[memory-cycle] no recent days.\n'); return }
  store.pruneConsolidatedMemoryOutsideDays(dayKeys)
  await refreshEmbeddings(ws)
  store.writeContextFile()
  process.stderr.write(`[memory-cycle] pruned to ${dayKeys.join(', ')}.\n`)
}

let _flushLock = false

export async function autoFlush(ws) {
  if (_flushLock) return { flushed: false, reason: 'locked' }
  const store = getStore()
  const config = readCycleConfig()
  const now = Date.now()
  const lastFlushAt = config.lastFlushAt ?? 0
  const pending = store.getPendingCandidateDays(100, 1)
  const totalPending = pending.reduce((sum, d) => sum + d.n, 0)
  if (totalPending === 0) return { flushed: false, candidates: 0 }

  const elapsed = now - lastFlushAt
  if (totalPending < AUTO_FLUSH_THRESHOLD && elapsed < AUTO_FLUSH_INTERVAL_MS) {
    return { flushed: false, candidates: totalPending }
  }

  _flushLock = true
  try {
    process.stderr.write(`[auto-flush] triggered: ${totalPending} pending, ${Math.round(elapsed / 60000)}min elapsed\n`)
    await memoryFlush(ws, { maxDays: 1, maxCandidatesPerBatch: 20, maxBatches: 2 })
    writeCycleConfig({ ...readCycleConfig(), lastFlushAt: now })
    return { flushed: true, candidates: totalPending }
  } finally {
    _flushLock = false
  }
}

export function getCycleStatus() {
  const config = readCycleConfig()
  const store = getStore()
  const pending = store.getPendingCandidateDays(100, 1)
  return {
    lastSleepAt: config.lastSleepAt ? new Date(config.lastSleepAt).toISOString() : null,
    lastCycle1At: config.lastCycle1At ? new Date(config.lastCycle1At).toISOString() : null,
    pendingDays: pending.length,
    pendingCandidates: pending.reduce((sum, d) => sum + d.n, 0),
  }
}

// ── Cycle1: Lightweight interval-based memory extraction ──

function looksLowSignalCycle1(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.includes('[Request interrupted by user]')) return true
  if (/<event-result[\s>]|<event\s/i.test(String(text ?? ''))) return true
  if (/^(read|list|show|count|find|tell me|summarize)\b/i.test(clean) && /(\/|\.jsonl\b|\.md\b|\.csv\b|\bfilenames?\b)/i.test(clean)) return true
  if (/^no response requested\.?$/i.test(clean)) return true
  if (/^stop hook error:/i.test(clean)) return true
  if (/return this exact shape:/i.test(clean)) return true
  const compact = clean.replace(/\s+/g, '')
  const hasKorean = /[\uAC00-\uD7AF]/.test(compact)
  if (compact.length < (hasKorean ? 4 : 8)) return true
  return false
}

function loadCycle1Prompt() {
  const promptPath = join(resourceDir(), 'defaults', 'memory-cycle1-prompt.md')
  if (existsSync(promptPath)) return readFileSync(promptPath, 'utf8')
  return 'Extract durable memory from candidates. Output JSON only with profiles/facts/tasks/signals/entities/relations.\n\n{{CANDIDATES}}'
}

const DEFAULT_CYCLE1_PROVIDER = { connection: 'codex', model: 'gpt-5.3-codex-spark', effort: 'medium' }
const MAX_CYCLE1_CANDIDATES_PER_BATCH = 50
const MAX_CYCLE1_BATCHES = 5

export async function runCycle1(ws, config) {
  const store = getStore()
  const cycleConfig = readCycleConfig()
  const lastRun = cycleConfig.lastCycle1At || 0

  // Get new episodes since last run
  const newEpisodes = store.getEpisodesSince(lastRun)
  if (!newEpisodes || newEpisodes.length === 0) return { extracted: 0 }

  // Filter: user messages only, clean + low-signal filter
  const allCandidates = newEpisodes
    .filter(e => e.role === 'user' && e.kind === 'message')
    .map(e => ({ ...e, content: cleanMemoryText(e.content) }))
    .filter(e => e.content && !looksLowSignalCycle1(e.content))

  if (allCandidates.length === 0) {
    writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() })
    return { extracted: 0 }
  }

  const maxPerBatch = Math.max(1, Number(config?.memory?.cycle1?.maxCandidatesPerBatch ?? MAX_CYCLE1_CANDIDATES_PER_BATCH))
  const maxBatches = Math.max(1, Number(config?.memory?.cycle1?.maxBatches ?? MAX_CYCLE1_BATCHES))
  const provider = config?.memory?.cycle1?.provider || DEFAULT_CYCLE1_PROVIDER
  const timeout = config?.memory?.cycle1?.timeout || 60000

  let totalExtracted = 0, totalFacts = 0, totalTasks = 0, totalSignals = 0

  for (let batch = 0; batch < maxBatches; batch++) {
    const start = batch * maxPerBatch
    if (start >= allCandidates.length) break
    const candidates = allCandidates.slice(start, start + maxPerBatch)

    // Build prompt
    const candidateText = candidates
      .map((c, i) => `#${i + 1} [${c.role}]: ${c.content.slice(0, 300)}`)
      .join('\n\n')

    const extractionPrompt = loadCycle1Prompt().replace('{{CANDIDATES}}', candidateText)

    // Call LLM via provider abstraction
    let raw
    try {
      raw = await callLLM(extractionPrompt, provider, { timeout, cwd: ws })
    } catch (e) {
      process.stderr.write(`[memory-cycle1] batch ${batch} LLM error: ${e.message}\n`)
      break
    }

    // Parse and upsert
    const parsed = extractJsonObject(raw)
    if (!parsed) {
      process.stderr.write(`[memory-cycle1] batch ${batch}: invalid JSON\n`)
      continue
    }

    const ts = new Date().toISOString()
    const srcEp = candidates[0]?.id ?? null
    if (parsed.profiles) store.upsertProfiles(parsed.profiles, ts, srcEp)
    if (parsed.facts) await store.upsertFacts(parsed.facts, ts, srcEp)
    if (parsed.tasks) store.upsertTasks(parsed.tasks, ts, srcEp)
    if (parsed.signals) store.upsertSignals(parsed.signals, srcEp, ts)
    if (parsed.entities) store.upsertEntities(parsed.entities, ts, srcEp)
    if (parsed.relations) store.upsertRelations(parsed.relations, ts, srcEp)

    totalExtracted += candidates.length
    totalFacts += (parsed.facts || []).length
    totalTasks += (parsed.tasks || []).length
    totalSignals += (parsed.signals || []).length
  }

  // Update context file + timestamp
  store.writeContextFile()
  writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() })

  const result = {
    extracted: totalExtracted,
    facts: totalFacts,
    tasks: totalTasks,
    signals: totalSignals,
  }
  if (totalExtracted > 0) {
    process.stderr.write(`[memory-cycle1] extracted=${result.extracted} facts=${result.facts} tasks=${result.tasks} signals=${result.signals}\n`)
  }
  return result
}

export function parseInterval(s) {
  const match = String(s).match(/^(\d+)(s|m|h)$/)
  if (!match) return 600000 // default 10m
  const [, num, unit] = match
  const multiplier = { s: 1000, m: 60000, h: 3600000 }
  return Number(num) * multiplier[unit]
}
