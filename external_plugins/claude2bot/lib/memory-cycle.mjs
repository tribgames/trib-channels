/**
 * memory-cycle.mjs — Memory consolidation, compression, and summarize cycle.
 * Standalone memory consolidation module.
 */

import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { cleanMemoryText, getMemoryStore } from './memory.mjs'
import { embedText } from './embedding-provider.mjs'

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

function normalizeTextToEnglish(text, ws, options = {}) {
  const raw = String(text ?? '').trim()
  if (!raw || !containsHangul(raw)) return raw
  const label = String(options.label ?? 'memory artifact').trim() || 'memory artifact'
  const format = options.format === 'json' ? 'JSON' : 'Markdown'
  const prompt = `Rewrite this ${label} into concise English.\nRules:\n- Return ${format} only.\n- Translate natural-language content to English.\n- Preserve proper nouns, product names, file paths, URLs, emails, IDs, numbers, code symbols, and identifiers as-is.\n- Avoid Hangul unless it is part of an exact identifier or proper noun.\n\n${raw}`
  return execClaudePrompt(prompt, { cwd: ws, timeout: Number(options.timeout ?? 120000) }).trim()
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

function normalizeSleepArtifacts(date, ws) {
  const targets = [
    { path: join(HISTORY_DIR, 'daily', `${date}.md`), format: 'markdown', label: `daily summary for ${date}` },
    { path: join(HISTORY_DIR, 'lifetime.md'), format: 'markdown', label: 'lifetime summary' },
    { path: join(HISTORY_DIR, 'identity.md'), format: 'markdown', label: 'identity profile' },
    { path: join(HISTORY_DIR, 'ongoing.md'), format: 'markdown', label: 'ongoing tasks' },
    { path: join(HISTORY_DIR, 'interests.json'), format: 'json', label: 'interest keywords' },
  ]
  for (const target of targets) {
    if (!existsSync(target.path)) continue
    try {
      const content = readFileSync(target.path, 'utf8').trim()
      if (!content || !containsHangul(content)) continue
      const normalized = target.format === 'json'
        ? JSON.stringify(normalizeJsonPayloadToEnglish(JSON.parse(content), ws, { label: target.label, timeout: 180000 }), null, 2)
        : normalizeTextToEnglish(content, ws, { label: target.label, timeout: 180000 })
      if (normalized?.trim()) writeFileSync(target.path, normalized.trim() + '\n')
    } catch (e) {
      process.stderr.write(`[memory-cycle] normalize failed for ${target.path}: ${e.message}\n`)
    }
  }
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
      const parsed = normalizeJsonPayloadToEnglish(extractJsonObject(raw), ws, { label: `consolidation for ${dayKey}`, timeout: 120000 })
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

function collectDailiesForWeek(weekNum, year) {
  const dailyDir = join(HISTORY_DIR, 'daily')
  if (!existsSync(dailyDir)) return ''
  return readdirSync(dailyDir).filter(f => f.endsWith('.md')).sort().map(f => {
    const d = new Date(f.replace('.md', ''))
    const w = getWeekNumber(d)
    return w === weekNum && String(d.getFullYear()) === String(year) ? readFileSync(join(dailyDir, f), 'utf8') : ''
  }).filter(Boolean).join('\n\n---\n\n')
}

function collectFilesForPeriod(dir, level, year, month) {
  const srcDir = join(HISTORY_DIR, level)
  if (!existsSync(srcDir)) return ''
  return readdirSync(srcDir).filter(f => f.endsWith('.md') && f.startsWith(`${year}-${month ? month : ''}`))
    .sort().map(f => readFileSync(join(srcDir, f), 'utf8')).filter(Boolean).join('\n\n---\n\n')
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
}

function runRollup(level, key, content) {
  const outFile = join(HISTORY_DIR, level, `${key}.md`)
  try {
    const summary = execClaudePrompt(`Compress these summaries into a concise ${level} summary. Write in English except proper nouns. Output only the summary:\n\n${content}`, { timeout: 120000 })
    const normalized = normalizeTextToEnglish(summary, process.cwd(), { label: `${level} summary`, timeout: 120000 })
    writeFileSync(outFile, `# ${key}\n\n${normalized}\n`)
    process.stderr.write(`[memory-cycle] ${level} ${key} generated.\n`)
  } catch (e) { process.stderr.write(`[memory-cycle] ${level} rollup failed: ${e.message}\n`) }
}

function generateLifetimeMerge() {
  const lifetimePath = join(HISTORY_DIR, 'lifetime.md')
  const sources = ['yearly', 'monthly', 'weekly', 'daily']
  const parts = []
  for (const level of sources) {
    const dir = join(HISTORY_DIR, level)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 3)) {
      parts.push(readFileSync(join(dir, f), 'utf8'))
    }
  }
  if (existsSync(lifetimePath)) parts.push(readFileSync(lifetimePath, 'utf8'))
  if (!parts.length) return
  const mergeInput = parts.join('\n\n---\n\n')
  try {
    const merged = execClaudePrompt(`Merge and compress this into a single lifetime summary. Remove duplicates, keep only the most important history and patterns. Write in English except proper nouns. Output only the summary:\n\n${mergeInput}`, { timeout: 120000 })
    const normalized = normalizeTextToEnglish(merged, process.cwd(), { label: 'lifetime summary', timeout: 120000 })
    writeFileSync(lifetimePath, normalized + '\n')
    process.stderr.write('[memory-cycle] lifetime.md updated.\n')
  } catch (e) { process.stderr.write(`[memory-cycle] lifetime merge failed: ${e.message}\n`) }
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
  const today = new Date().toISOString().slice(0, 10)
  const [year, month] = today.split('-')
  const weekNum = getWeekNumber(new Date())
  const weekKey = `${year}-W${String(weekNum).padStart(2, '0')}`

  const config = readCycleConfig()
  const isFirstRun = !config.lastSleepAt && !existsSync(join(HISTORY_DIR, 'lifetime.md'))
  const lastSleepAt = isFirstRun ? 0 : (config.lastSleepAt ?? (now - 86400000))

  process.stderr.write(`[memory-cycle] Starting.${isFirstRun ? ' (FIRST RUN)' : ''}\n`)
  store.backfillProject(ws, { limit: 120 })

  for (const d of ['daily', 'weekly', 'monthly', 'yearly']) mkdirSync(join(HISTORY_DIR, d), { recursive: true })

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
      normalizeSleepArtifacts(date, ws)
      generated++
      process.stderr.write(`[memory-cycle] Daily ${date} generated.\n`)
    } catch (e) { process.stderr.write(`[memory-cycle] daily failed for ${date}: ${e.message}\n`) }
  }

  // 2. Consolidation
  await consolidateRecent(pendingDays, ws)

  // 3. Rollups
  const weeklyDir = join(HISTORY_DIR, 'weekly')
  if ((existsSync(weeklyDir) ? readdirSync(weeklyDir).filter(f => f.endsWith('.md')).length : 0) < 4) {
    const weeklyFile = join(weeklyDir, `${weekKey}.md`)
    if (!existsSync(weeklyFile)) { const c = collectDailiesForWeek(weekNum, year); if (c) runRollup('weekly', weekKey, c) }
  }
  const monthKey = `${year}-${month}`
  const monthlyDir = join(HISTORY_DIR, 'monthly')
  if ((existsSync(monthlyDir) ? readdirSync(monthlyDir).filter(f => f.endsWith('.md')).length : 0) < 12) {
    const monthlyFile = join(monthlyDir, `${monthKey}.md`)
    if (!existsSync(monthlyFile)) { const c = collectFilesForPeriod(HISTORY_DIR, 'weekly', year, month); if (c) runRollup('monthly', monthKey, c) }
  }
  const yearlyDir = join(HISTORY_DIR, 'yearly')
  if ((existsSync(yearlyDir) ? readdirSync(yearlyDir).filter(f => f.endsWith('.md')).length : 0) < 3) {
    const yearlyFile = join(yearlyDir, `${year}.md`)
    if (!existsSync(yearlyFile)) { const c = collectFilesForPeriod(HISTORY_DIR, 'monthly', year, ''); if (c) runRollup('yearly', year, c) }
  }

  // 4. Lifetime merge
  generateLifetimeMerge()

  // 5. Sync + embeddings + context
  store.syncHistoryFromFiles()
  await refreshEmbeddings(ws)
  store.writeContextFile()

  // 6. Save timestamp
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
      normalizeSleepArtifacts(date, ws)
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
    pendingDays: pending.length,
    pendingCandidates: pending.reduce((sum, d) => sum + d.n, 0),
  }
}
