import { DatabaseSync } from 'node:sqlite'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { createHash } from 'crypto'
import { embedText, getEmbeddingModelId, warmupEmbeddingProvider } from './embedding-provider.mjs'
let sqliteVec = null
try { sqliteVec = await import('sqlite-vec') } catch { /* sqlite-vec not available */ }

function vecToHex(vector) {
  return Buffer.from(new Float32Array(vector).buffer).toString('hex')
}

function parseTemporalHint(query) {
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const today = kst.toISOString().slice(0, 10)
  const daysAgo = (n) => new Date(kst.getTime() - n * 86400000).toISOString().slice(0, 10)
  if (/어제|yesterday/i.test(query)) return { start: daysAgo(1), end: daysAgo(1) }
  if (/그저께|그제|그그저께/i.test(query)) return { start: daysAgo(2), end: daysAgo(2) }
  if (/지난\s*주|last\s*week/i.test(query)) return { start: daysAgo(7), end: daysAgo(1) }
  if (/이번\s*주|this\s*week/i.test(query)) return { start: daysAgo(kst.getDay() || 7), end: today }
  if (/오늘|today/i.test(query)) return { start: today, end: today }
  if (/최근|recently/i.test(query)) return { start: daysAgo(3), end: today }
  const dateMatch = query.match(/(\d{1,2})월\s*(\d{1,2})일/)
  if (dateMatch) {
    const m = String(dateMatch[1]).padStart(2, '0')
    const d = String(dateMatch[2]).padStart(2, '0')
    const date = `${kst.getFullYear()}-${m}-${d}`
    return { start: date, end: date }
  }
  return null
}

const stores = new Map()
const INTENT_PROTOTYPES = {
  preference: [
    'user language tone response style preference',
    'how should the assistant speak, write, and address the user',
    'preferred language, tone, and communication style',
    '사용자의 언어 톤 응답 스타일 선호',
    '어떤 말투와 언어로 응답해야 하는가',
    '호칭 말투 응답 스타일 규칙',
  ],
  task: [
    'current active task work in progress next task',
    'what should be done next in the current workflow',
    'ongoing work and next session priorities',
    '현재 진행 중인 작업 다음 작업 우선순위',
    '지금 해야 할 일과 다음 세션 작업',
    '활성 작업과 진행 중인 일',
  ],
  decision: [
    'architecture decision design constraint rule limitation',
    'system design choice and implementation constraint',
    'agreed technical decision and structural direction',
    '설계 결정 구조 방향 제약 규칙',
    '아키텍처 결정과 기술 제약',
    '확정된 결정사항과 시스템 규칙',
  ],
  history: [
    'recent history what was discussed summary of recent work',
    'daily or weekly summary of recent conversations',
    'recent activity and discussed topics',
    '최근 대화 요약 무엇을 했는지',
    '최근 기록과 요약',
    '무슨 주제로 이야기했는지 최근 히스토리',
  ],
}
let intentPrototypeVectorsPromise = null

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

function workspaceToProjectSlug(workspacePath) {
  return resolve(workspacePath)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1')
    .replace(/\//g, '-')
}

function firstTextContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

export function cleanMemoryText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<memory-context>[\s\S]*?<\/memory-context>/gi, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, '')
    .replace(/<tool-use-id>[\s\S]*?<\/tool-use-id>/gi, '')
    .replace(/<output-file>[\s\S]*?<\/output-file>/gi, '')
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<channel[^>]*>\n?([\s\S]*?)\n?<\/channel>/g, '$1')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<schedule-context>[\s\S]*?<\/schedule-context>/g, '')
    .replace(/<teammate-message[\s\S]*?<\/teammate-message>/g, '')
    .replace(/^This session is being continued from a previous conversation[\s\S]*?(?=\n\n|$)/gim, '')
    .replace(/^\[[^\]\n]{1,140}\]\s*$/gm, '')
    .replace(/^\s*●\s.*$/gm, '')
    .replace(/^\s*Ran .*$/gm, '')
    .replace(/^\s*Command: .*$/gm, '')
    .replace(/^\s*Process exited .*$/gm, '')
    .replace(/^\s*Full transcript available at: .*$/gm, '')
    .replace(/^\s*Read the output file to retrieve the result: .*$/gm, '')
    .replace(/^\s*Original token count: .*$/gm, '')
    .replace(/^\s*Wall time: .*$/gm, '')
    .replace(/^\s*Chunk ID: .*$/gm, '')
    .replace(/^\s*tool_uses: .*$/gm, '')
    .replace(/^\s*menu item .*$/gm, '')
    .replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim()
}

function looksLowSignal(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.includes('[Request interrupted by user]')) return true
  if (/<event-result[\s>]|<event\s/i.test(String(text ?? ''))) return true
  if (/^(read|list|show|count|find|tell me|summarize)\b/i.test(clean) && /(\/|\.jsonl\b|\.md\b|\.csv\b|\bfilenames?\b)/i.test(clean)) return true
  if (/^no response requested\.?$/i.test(clean)) return true
  if (/^stop hook error:/i.test(clean)) return true
  if (/^you are consolidating high-signal long-term memory candidates/i.test(clean)) return true
  if (/^you are improving retrieval quality for a long-term memory system/i.test(clean)) return true
  if (/^analyze the conversation and output only markdown/i.test(clean)) return true
  if (/^you are analyzing (today's|a day's) conversation to generate/i.test(clean)) return true
  if (/^summarize the conversation below\.?/i.test(clean)) return true
  if (/^compress these summaries into a concise .* summary/i.test(clean)) return true
  if (/history directory:/i.test(clean) && /data sources/i.test(clean)) return true
  if (/use read tool/i.test(clean) && /existing files/i.test(clean)) return true
  if (/return this exact shape:/i.test(clean)) return true
  if (/^claude2bot setup\b/i.test(clean) && /parse the command arguments/i.test(clean)) return true
  if (/\b(chat_id|gmail_search_messages|newer_than:\d+[dh]|query:\s*")/i.test(clean)) return true
  if (/^new session started\./i.test(clean) && /one short message only/i.test(clean)) return true
  if (/^before starting any work/i.test(clean) && /tell the user/i.test(clean)) return true
  const compact = clean.replace(/\s+/g, '')
  const hasKorean = /[\uAC00-\uD7AF]/.test(compact)
  const minCompactLen = hasKorean ? 4 : 8
  if (compact.length < minCompactLen) return true
  const words = clean.split(/\s+/).filter(Boolean)
  if (words.length < 2 && compact.length < (hasKorean ? 4 : 16)) return true
  const symbolCount = (clean.match(/[^\p{L}\p{N}\s]/gu) ?? []).length
  if (symbolCount > clean.length * 0.45) return true
  return false
}

function tokenizeMemoryText(text) {
  return cleanMemoryText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2)
    .slice(0, 10)
}

function buildFtsQuery(text) {
  const tokens = tokenizeMemoryText(text)
  if (tokens.length === 0) return ''
  // trigram requires ≥3 chars; keep only tokens with 3+ chars for FTS
  const trigramTokens = [...new Set(tokens)].filter(t => t.length >= 3)
  if (trigramTokens.length === 0) return ''
  return trigramTokens.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

function getShortTokensForLike(text) {
  const tokens = tokenizeMemoryText(text)
  // return 2-char tokens that trigram can't handle
  return [...new Set(tokens)].filter(t => t.length === 2)
}

function candidateScore(text, role) {
  const clean = cleanMemoryText(text)
  if (!clean || looksLowSignal(clean)) return 0
  const compact = clean.replace(/\s+/g, '')
  const lenScore = Math.min(1, compact.length / 120)
  const wordCount = clean.split(/\s+/).filter(Boolean).length
  const lineCount = clean.split('\n').filter(Boolean).length
  const colonCount = (clean.match(/:/g) ?? []).length
  const pathCount = (String(text ?? '').match(/\/[A-Za-z0-9._-]+/g) ?? []).length
  const tagCount = (String(text ?? '').match(/<[^>]+>/g) ?? []).length
  if (role === 'assistant' && wordCount < 8) return 0
  const roleBoost = role === 'user' ? 0.25 : 0.08
  const structureBoost = /\n/.test(clean) ? 0.04 : 0
  const overlongPenalty = compact.length > 320
    ? Math.min(0.45, ((compact.length - 320) / 1200) * 0.45)
    : 0
  const proceduralPenalty = lineCount > 8 && colonCount >= 4 ? 0.18 : 0
  const artifactPenalty = pathCount >= 3 || tagCount >= 2 ? 0.14 : 0
  return Math.max(
    0,
    Math.min(
      1,
      Number((0.22 + lenScore * 0.45 + roleBoost + structureBoost - overlongPenalty - proceduralPenalty - artifactPenalty).toFixed(3)),
    ),
  )
}

function decayConfidence(confidence, lastSeen) {
  const base = Number(confidence ?? 0.5)
  if (!lastSeen) return base
  const ageDays = Math.max(0, (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24))
  const penalty = Math.min(0.25, ageDays / 180 * 0.25)
  return Math.max(0.15, Number((base - penalty).toFixed(3)))
}

function staleCutoffDays(kind) {
  switch (kind) {
    case 'decision': return 180
    case 'preference': return 120
    case 'constraint': return 180
    case 'fact': return 90
    default: return 120
  }
}

function decaySignalScore(score, lastSeen, kind = '') {
  const base = Number(score ?? 0.5)
  if (!lastSeen) return base
  const ageDays = Math.max(0, (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24))
  const cutoff =
    kind === 'language' || kind === 'tone' ? 180 :
    kind === 'cadence' ? 120 :
    90
  const penalty = Math.min(0.45, ageDays / cutoff * 0.25)
  return Math.max(0.15, Number((base - penalty).toFixed(3)))
}

function normalizeTaskStatus(status, details = '') {
  const raw = String(status ?? '').trim().toLowerCase()
  if (raw === 'done' || raw === 'completed' || raw === 'cancelled' || raw === 'paused' || raw === 'in_progress' || raw === 'active') {
    if (raw === 'active' && /\b(done|completed|resolved|finished|merged|shipped)\b/.test(String(details).toLowerCase())) {
      return 'done'
    }
    return raw === 'completed' ? 'done' : raw
  }
  const combined = `${raw} ${String(details).toLowerCase()}`
  if (/\b(done|completed|resolved|finished|merged|shipped)\b/.test(combined)) return 'done'
  if (/\b(cancelled|canceled|dropped|abandoned)\b/.test(combined)) return 'cancelled'
  if (/\b(paused|blocked|waiting|hold)\b/.test(combined)) return 'paused'
  if (/\b(in progress|progress|ongoing)\b/.test(combined)) return 'in_progress'
  return 'active'
}

function normalizeFactSlot(slot) {
  const value = String(slot ?? '').trim()
  return value ? value : ''
}

function normalizeWorkstream(value) {
  const clean = String(value ?? '').trim().toLowerCase()
  if (!clean) return ''
  return clean
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function normalizeFactType(factType) {
  const value = String(factType ?? '').trim().toLowerCase()
  return ['preference', 'constraint', 'decision', 'fact'].includes(value) ? value : 'fact'
}

function normalizeSignalKind(kind) {
  const value = String(kind ?? '').trim().toLowerCase()
  return ['language', 'tone', 'time_pref', 'interest', 'cadence'].includes(value) ? value : 'interest'
}

function normalizeTaskPriority(priority) {
  const value = String(priority ?? 'normal').trim().toLowerCase()
  return ['low', 'normal', 'high'].includes(value) ? value : 'normal'
}

function normalizeTaskStage(stage, details = '') {
  const raw = String(stage ?? '').trim().toLowerCase()
  if (['planned', 'investigating', 'implementing', 'wired', 'verified', 'done'].includes(raw)) {
    return raw
  }
  const combined = `${raw} ${String(details).toLowerCase()}`
  if (/\b(verified|tested|confirmed|working)\b/.test(combined)) return 'verified'
  if (/\b(wired|hooked|connected|registered|integrated)\b/.test(combined)) return 'wired'
  if (/\b(implementing|coding|building|refactoring|fixing)\b/.test(combined)) return 'implementing'
  if (/\b(investigating|researching|checking|exploring|surveying)\b/.test(combined)) return 'investigating'
  if (/\b(done|completed|resolved|finished|merged|shipped)\b/.test(combined)) return 'done'
  return 'planned'
}

function normalizeEvidenceLevel(value, details = '') {
  const raw = String(value ?? '').trim().toLowerCase()
  if (['claimed', 'implemented', 'verified'].includes(raw)) return raw
  const combined = `${raw} ${String(details).toLowerCase()}`
  if (/\b(verified|tested|confirmed|working)\b/.test(combined)) return 'verified'
  if (/\b(implemented|added|wired|registered|integrated|exists in code)\b/.test(combined)) return 'implemented'
  return 'claimed'
}

function taskStageRank(stage) {
  switch (String(stage ?? '').trim().toLowerCase()) {
    case 'planned': return 1
    case 'investigating': return 2
    case 'implementing': return 3
    case 'wired': return 4
    case 'verified': return 5
    case 'done': return 6
    default: return 0
  }
}

function taskEvidenceRank(level) {
  switch (String(level ?? '').trim().toLowerCase()) {
    case 'claimed': return 1
    case 'implemented': return 2
    case 'verified': return 3
    default: return 0
  }
}

function normalizeProfileKey(key) {
  const value = String(key ?? '').trim().toLowerCase()
  return ['language', 'tone', 'address', 'response_style', 'timezone'].includes(value) ? value : ''
}

function profileKeyForFact(factType, text = '', slot = '') {
  const combined = `${slot} ${text}`.toLowerCase()
  if (factType === 'preference' && /\b(address|call|name|nickname|호칭)\b/.test(combined)) return 'address'
  if (factType === 'preference' && /\b(response style|response-style|style|응답 스타일|말투)\b/.test(combined)) return 'response_style'
  if (factType === 'constraint' && /\btimezone|time zone|타임존|로컬 시간\b/.test(combined)) return 'timezone'
  return ''
}

function profileKeyForSignal(kind, value = '') {
  const combined = `${kind} ${value}`.toLowerCase()
  if (kind === 'language' || /\bkorean|english|한국어|영문|언어\b/.test(combined)) return 'language'
  if (kind === 'tone' || /\btone|말투|어조\b/.test(combined)) return 'tone'
  return ''
}

function compactClause(label, value) {
  const clean = cleanMemoryText(value)
  if (!clean) return ''
  return `${label}: ${clean}`
}

function tokenizedWorkstream(value) {
  return normalizeWorkstream(value).split('-').filter(Boolean)
}

function composeTaskDetails(task = {}) {
  const base = cleanMemoryText(task?.details ?? '')
  const extras = [
    compactClause('Goal', task?.goal),
    compactClause('Integration', task?.integration_point),
    compactClause('Blocked by', task?.blocked_by),
    compactClause('Next', task?.next_step),
    Array.isArray(task?.related_to) && task.related_to.length
      ? compactClause('Related', task.related_to.join(', '))
      : compactClause('Related', task?.related_to),
  ].filter(Boolean)
  if (!base && extras.length === 0) return ''
  if (!base) return extras.join(' | ')
  if (extras.length === 0) return base
  return `${base} | ${extras.join(' | ')}`
}

function shouldKeepFact(factType, text, confidence) {
  const clean = cleanMemoryText(text)
  if (!clean) return false
  const compact = clean.replace(/\s+/g, '')
  if (compact.length < 18) return false
  const words = clean.split(/\s+/).filter(Boolean).length
  if (words < 4) return false
  const score = Number(confidence ?? 0.6)
  const minScore =
    factType === 'decision' ? 0.82 :
    factType === 'constraint' ? 0.75 :
    factType === 'preference' ? 0.74 :
    0.86
  const minWords =
    factType === 'decision' || factType === 'fact' ? 6 : 5
  if (words < minWords) return false
  return score >= minScore
}

function shouldKeepSignal(kind, value, score) {
  const clean = cleanMemoryText(value)
  if (!clean) return false
  const compact = clean.replace(/\s+/g, '')
  if (compact.length < 18) return false
  const words = clean.split(/\s+/).filter(Boolean).length
  if (words < 5) return false
  return Number(score ?? 0.5) >= 0.72
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function averageVectors(vectors = []) {
  const rows = vectors.filter(vector => Array.isArray(vector) && vector.length > 0)
  if (rows.length === 0) return []
  const dims = rows[0].length
  const out = new Array(dims).fill(0)
  for (const vector of rows) {
    if (vector.length !== dims) continue
    for (let i = 0; i < dims; i += 1) out[i] += vector[i]
  }
  for (let i = 0; i < dims; i += 1) out[i] /= rows.length
  return out
}

function embeddingItemKey(entityType, entityId) {
  return `${entityType}:${entityId}`
}

function hashEmbeddingInput(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

async function getIntentPrototypeVectors() {
  if (!intentPrototypeVectorsPromise) {
    intentPrototypeVectorsPromise = (async () => {
      const entries = []
      for (const [intent, phrases] of Object.entries(INTENT_PROTOTYPES)) {
        const vectors = await Promise.all(phrases.map(phrase => embedText(phrase)))
        entries.push([intent, vectors.filter(vector => Array.isArray(vector) && vector.length > 0)])
      }
      return new Map(entries)
    })()
  }
  return intentPrototypeVectorsPromise
}

function contextualizeEmbeddingInput(item) {
  const entityType = String(item.entityType ?? '')
  const content = cleanMemoryText(item.content ?? '')
  if (!content) return ''

  if (entityType === 'fact') {
    const label = String(item.subtype ?? 'fact')
    const slot = item.slot ? ` slot=${item.slot}` : ''
    const workstream = item.workstream ? ` workstream=${item.workstream}` : ''
    return cleanMemoryText(`memory fact type=${label}${slot}${workstream}\n${content}`)
  }

  if (entityType === 'task') {
    const status = item.status ? ` status=${item.status}` : ''
    const priority = item.priority ? ` priority=${item.priority}` : ''
    const workstream = item.workstream ? ` workstream=${item.workstream}` : ''
    return cleanMemoryText(`memory task${status}${priority}${workstream}\n${content}`)
  }

  if (entityType === 'signal') {
    const kind = item.subtype ? ` kind=${item.subtype}` : ''
    return cleanMemoryText(`memory signal${kind}\n${content}`)
  }

  if (entityType === 'summary') {
    const level = item.subtype ? ` level=${item.subtype}` : ''
    const period = item.ref ? ` period=${item.ref}` : ''
    return cleanMemoryText(`memory summary${level}${period}\n${content}`)
  }

  return content
}

function compactRetrievalContent(item) {
  const raw = cleanMemoryText(item?.content ?? '')
  if (!raw) return ''
  if (item?.type === 'episode') {
    return raw.slice(0, 160)
  }
  if (item?.type === 'summary') {
    return raw.slice(0, 220)
  }
  return raw.slice(0, 260)
}

export class MemoryStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.historyDir = join(dataDir, 'history')
    this.dbPath = join(dataDir, 'memory.sqlite')
    ensureDir(dirname(this.dbPath))
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true })
    this.vecEnabled = false
    this._loadVecExtension()
    this.init()
    this.rebuildDerivedIndexes()
  }

  _loadVecExtension() {
    if (!sqliteVec) return
    try {
      sqliteVec.load(this.db)
      this.vecEnabled = true
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[384])`)
    } catch (e) {
      process.stderr.write(`[memory] sqlite-vec load failed: ${e.message}\n`)
    }
  }

  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `)

    // Migrate FTS tables from unicode61 to trigram for Korean support
    const ftsToMigrate = ['episodes_fts', 'summaries_fts', 'facts_fts', 'tasks_fts', 'signals_fts']
    for (const table of ftsToMigrate) {
      try {
        const info = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table)
        if (info?.sql && !info.sql.includes('trigram')) {
          this.db.exec(`DROP TABLE IF EXISTS ${table}`)
        }
      } catch { /* table may not exist yet */ }
    }

    this.db.exec(`

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        backend TEXT NOT NULL DEFAULT 'claude2bot',
        channel_id TEXT,
        user_id TEXT,
        user_name TEXT,
        session_id TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_ref TEXT UNIQUE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      DROP INDEX IF EXISTS idx_episodes_source_ref;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_source_ref ON episodes(source_ref);
      CREATE INDEX IF NOT EXISTS idx_episodes_day ON episodes(day_key, ts);
      CREATE INDEX IF NOT EXISTS idx_episodes_role ON episodes(role, ts);

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts
        USING fts5(content, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_day ON memory_candidates(day_key, status, score DESC);

      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY,
        level TEXT NOT NULL,
        period_key TEXT NOT NULL,
        content TEXT NOT NULL,
        source_range_start TEXT,
        source_range_end TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(level, period_key)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts
        USING fts5(content, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(kind, doc_key)
      );

      CREATE TABLE IF NOT EXISTS profiles (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_retrieved_at TEXT,
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY,
        fact_type TEXT NOT NULL,
        slot TEXT,
        workstream TEXT,
        text TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        mention_count INTEGER NOT NULL DEFAULT 1,
        UNIQUE(fact_type, text),
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
        USING fts5(text, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL UNIQUE,
        details TEXT,
        workstream TEXT,
        stage TEXT NOT NULL DEFAULT 'planned',
        evidence_level TEXT NOT NULL DEFAULT 'claimed',
        status TEXT NOT NULL DEFAULT 'active',
        priority TEXT NOT NULL DEFAULT 'normal',
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts
        USING fts5(title, details, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        stage TEXT,
        evidence_level TEXT,
        status TEXT,
        note TEXT,
        source_episode_id INTEGER,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS interests (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        score REAL NOT NULL DEFAULT 0,
        count INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        UNIQUE(kind, value),
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS signals_fts
        USING fts5(kind, value, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'thing',
        description TEXT,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        UNIQUE(name, entity_type)
      );

      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY,
        source_entity_id INTEGER NOT NULL REFERENCES entities(id),
        target_entity_id INTEGER NOT NULL REFERENCES entities(id),
        relation_type TEXT NOT NULL,
        description TEXT,
        confidence REAL DEFAULT 0.7,
        first_seen TEXT,
        last_seen TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        source_episode_id INTEGER,
        UNIQUE(source_entity_id, target_entity_id, relation_type)
      );

      CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);

      CREATE TABLE IF NOT EXISTS pending_embeds (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(entity_type, entity_id)
      );

      CREATE TABLE IF NOT EXISTS memory_vectors (
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_hash TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY(entity_type, entity_id, model)
      );
    `)

    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN slot TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN workstream TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN last_retrieved_at TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN last_retrieved_at TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN workstream TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'planned';`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'claimed';`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE summaries ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE summaries ADD COLUMN last_retrieved_at TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE signals ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE signals ADD COLUMN last_retrieved_at TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE memory_vectors ADD COLUMN content_hash TEXT;`)
    } catch { /* already present */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_slot ON facts(slot);`)

    this.insertEpisodeStmt = this.db.prepare(`
      INSERT OR IGNORE INTO episodes (
        ts, day_key, backend, channel_id, user_id, user_name, session_id,
        role, kind, content, source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertEpisodeFtsStmt = this.db.prepare(`
      INSERT INTO episodes_fts(rowid, content) VALUES (?, ?)
    `)
    this.getEpisodeBySourceStmt = this.db.prepare(`
      SELECT id FROM episodes WHERE source_ref = ?
    `)
    this.insertCandidateStmt = this.db.prepare(`
      INSERT INTO memory_candidates (episode_id, ts, day_key, role, content, score)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.clearCandidatesStmt = this.db.prepare(`DELETE FROM memory_candidates`)
    this.clearFactsStmt = this.db.prepare(`DELETE FROM facts`)
    this.clearTasksStmt = this.db.prepare(`DELETE FROM tasks`)
    this.clearSignalsStmt = this.db.prepare(`DELETE FROM signals`)
    this.clearFactsFtsStmt = this.db.prepare(`DELETE FROM facts_fts`)
    this.clearTasksFtsStmt = this.db.prepare(`DELETE FROM tasks_fts`)
    this.clearSignalsFtsStmt = this.db.prepare(`DELETE FROM signals_fts`)
    this.clearVectorsStmt = this.db.prepare(`DELETE FROM memory_vectors`)
    this.upsertSummaryStmt = this.db.prepare(`
      INSERT INTO summaries (level, period_key, content, source_range_start, source_range_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(level, period_key) DO UPDATE SET
        content = excluded.content,
        source_range_start = excluded.source_range_start,
        source_range_end = excluded.source_range_end,
        updated_at = unixepoch()
    `)
    this.upsertSummaryFtsDeleteStmt = this.db.prepare(`
      DELETE FROM summaries_fts WHERE rowid = ?
    `)
    this.insertSummaryFtsStmt = this.db.prepare(`
      INSERT INTO summaries_fts(rowid, content) VALUES (?, ?)
    `)
    this.getSummaryIdStmt = this.db.prepare(`
      SELECT id FROM summaries WHERE level = ? AND period_key = ?
    `)
    this.upsertDocumentStmt = this.db.prepare(`
      INSERT INTO documents (kind, doc_key, content, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(kind, doc_key) DO UPDATE SET
        content = excluded.content,
        updated_at = unixepoch()
    `)
    this.upsertProfileStmt = this.db.prepare(`
      INSERT INTO profiles (key, value, confidence, first_seen, last_seen, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        confidence = MAX(profiles.confidence, excluded.confidence),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, profiles.source_episode_id)
    `)
    this.bumpProfileRetrievalStmt = this.db.prepare(`
      UPDATE profiles
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE key = ?
    `)
    this.upsertFactStmt = this.db.prepare(`
      INSERT INTO facts (fact_type, slot, workstream, text, confidence, first_seen, last_seen, source_episode_id, status, mention_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)
      ON CONFLICT(fact_type, text) DO UPDATE SET
        slot = COALESCE(excluded.slot, facts.slot),
        workstream = COALESCE(excluded.workstream, facts.workstream),
        confidence = MAX(facts.confidence, excluded.confidence),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, facts.source_episode_id),
        status = 'active',
        mention_count = facts.mention_count + 1
    `)
    this.staleFactSlotStmt = this.db.prepare(`
      UPDATE facts
      SET status = 'stale'
      WHERE slot = ?
        AND text != ?
        AND status = 'active'
    `)
    this.getFactIdStmt = this.db.prepare(`
      SELECT id FROM facts WHERE fact_type = ? AND text = ?
    `)
    this.deleteFactFtsStmt = this.db.prepare(`DELETE FROM facts_fts WHERE rowid = ?`)
    this.insertFactFtsStmt = this.db.prepare(`INSERT INTO facts_fts(rowid, text) VALUES (?, ?)`)
    this.upsertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (title, details, workstream, stage, evidence_level, status, priority, confidence, first_seen, last_seen, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(title) DO UPDATE SET
        details = excluded.details,
        workstream = COALESCE(excluded.workstream, tasks.workstream),
        stage = excluded.stage,
        evidence_level = excluded.evidence_level,
        status = excluded.status,
        priority = excluded.priority,
        confidence = MAX(tasks.confidence, excluded.confidence),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, tasks.source_episode_id)
    `)
    this.getTaskRowStmt = this.db.prepare(`
      SELECT id, status, stage, evidence_level FROM tasks WHERE title = ?
    `)
    this.getTaskIdStmt = this.db.prepare(`
      SELECT id FROM tasks WHERE title = ?
    `)
    this.deleteTaskFtsStmt = this.db.prepare(`DELETE FROM tasks_fts WHERE rowid = ?`)
    this.insertTaskFtsStmt = this.db.prepare(`INSERT INTO tasks_fts(rowid, title, details) VALUES (?, ?, ?)`)
    this.insertTaskEventStmt = this.db.prepare(`
      INSERT INTO task_events (task_id, ts, event_kind, stage, evidence_level, status, note, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.getTaskEventsStmt = this.db.prepare(`
      SELECT ts, event_kind, stage, evidence_level, status, note
      FROM task_events
      WHERE task_id = ?
      ORDER BY ts ASC, id ASC
    `)
    this.updateTaskProjectionStmt = this.db.prepare(`
      UPDATE tasks
      SET stage = ?, evidence_level = ?, status = ?
      WHERE id = ?
    `)
    this.clearInterestsStmt = this.db.prepare(`DELETE FROM interests`)
    this.insertInterestStmt = this.db.prepare(`
      INSERT INTO interests (name, score, count, last_seen)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        score = excluded.score,
        count = excluded.count,
        last_seen = excluded.last_seen
    `)
    this.upsertSignalStmt = this.db.prepare(`
      INSERT INTO signals (kind, value, score, first_seen, last_seen, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, value) DO UPDATE SET
        score = MIN(1.5, MAX(signals.score, excluded.score) + 0.05),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, signals.source_episode_id)
    `)
    this.getSignalIdStmt = this.db.prepare(`
      SELECT id FROM signals WHERE kind = ? AND value = ?
    `)
    this.deleteSignalFtsStmt = this.db.prepare(`DELETE FROM signals_fts WHERE rowid = ?`)
    this.insertSignalFtsStmt = this.db.prepare(`INSERT INTO signals_fts(rowid, kind, value) VALUES (?, ?, ?)`)
    this.markFactsStaleStmt = this.db.prepare(`
      UPDATE facts
      SET status = 'stale'
      WHERE status = 'active'
        AND fact_type = ?
        AND last_seen IS NOT NULL
        AND julianday('now') - julianday(last_seen) > ?
        AND mention_count < 3
    `)
    this.reviveFactsStmt = this.db.prepare(`
      UPDATE facts
      SET status = 'active'
      WHERE status = 'stale'
        AND fact_type = ?
        AND text = ?
    `)
    this.markTasksStaleStmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'stale'
      WHERE status IN ('active', 'in_progress', 'paused')
        AND last_seen IS NOT NULL
        AND julianday('now') - julianday(last_seen) > 45
        AND confidence < 0.75
    `)
    this.bumpFactRetrievalStmt = this.db.prepare(`
      UPDATE facts
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.bumpTaskRetrievalStmt = this.db.prepare(`
      UPDATE tasks
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.bumpSummaryRetrievalStmt = this.db.prepare(`
      UPDATE summaries
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.bumpSignalRetrievalStmt = this.db.prepare(`
      UPDATE signals
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.upsertVectorStmt = this.db.prepare(`
      INSERT INTO memory_vectors (entity_type, entity_id, model, dims, vector_json, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(entity_type, entity_id, model) DO UPDATE SET
        dims = excluded.dims,
        vector_json = excluded.vector_json,
        content_hash = excluded.content_hash,
        updated_at = unixepoch()
    `)
    this.getVectorStmt = this.db.prepare(`
      SELECT entity_type, entity_id, model, dims, vector_json, content_hash
      FROM memory_vectors
      WHERE entity_type = ? AND entity_id = ? AND model = ?
    `)
    this.listDenseFactRowsStmt = this.db.prepare(`
      SELECT 'fact' AS type, f.fact_type AS subtype, f.id AS entity_id, f.workstream AS workstream, f.text AS content,
             unixepoch(f.last_seen) AS updated_at, f.retrieval_count AS retrieval_count,
             f.confidence AS quality_score,
             e.source_ref AS source_ref, e.ts AS source_ts, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN facts f ON f.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = f.source_episode_id
      WHERE mv.entity_type = 'fact'
        AND mv.model = ?
        AND f.status = 'active'
    `)
    this.listDenseTaskRowsStmt = this.db.prepare(`
      SELECT 'task' AS type, t.stage AS subtype, t.id AS entity_id, t.workstream AS workstream,
             trim(t.title || CASE WHEN t.details IS NOT NULL AND t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
             unixepoch(t.last_seen) AS updated_at, t.retrieval_count AS retrieval_count,
             t.confidence AS quality_score,
             t.stage AS stage, t.evidence_level AS evidence_level, t.status AS status,
             e.source_ref AS source_ref, e.ts AS source_ts, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN tasks t ON t.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = t.source_episode_id
      WHERE mv.entity_type = 'task'
        AND mv.model = ?
        AND t.status IN ('active', 'in_progress', 'paused')
    `)
    this.listDenseSignalRowsStmt = this.db.prepare(`
      SELECT 'signal' AS type, s.kind AS subtype, s.id AS entity_id, s.value AS content,
             unixepoch(s.last_seen) AS updated_at, s.retrieval_count AS retrieval_count,
             s.score AS quality_score,
             e.source_ref AS source_ref, e.ts AS source_ts, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN signals s ON s.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = s.source_episode_id
      WHERE mv.entity_type = 'signal'
        AND mv.model = ?
    `)
    this.listDenseSummaryRowsStmt = this.db.prepare(`
      SELECT 'summary' AS type, s.level AS subtype, s.id AS entity_id, s.content AS content,
             s.updated_at AS updated_at, s.retrieval_count AS retrieval_count,
             NULL AS source_ref, NULL AS source_ts, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN summaries s ON s.id = mv.entity_id
      WHERE mv.entity_type = 'summary'
        AND mv.model = ?
    `)
    this.listDenseEpisodeRowsStmt = this.db.prepare(`
      SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content AS content,
             e.created_at AS updated_at, 0 AS retrieval_count,
             e.source_ref AS source_ref, e.ts AS source_ts, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN episodes e ON e.id = mv.entity_id
      WHERE mv.entity_type = 'episode'
        AND mv.model = ?
    `)
  }

  rebuildDerivedIndexes() {
    this.clearFactsFtsStmt.run()
    this.clearTasksFtsStmt.run()
    this.clearSignalsFtsStmt.run()
    this.upsertSummaryFtsDeleteStmt.run(-1)

    const facts = this.db.prepare(`SELECT id, text FROM facts`).all()
    for (const row of facts) {
      this.insertFactFtsStmt.run(row.id, row.text)
    }

    const tasks = this.db.prepare(`SELECT id, title, details FROM tasks`).all()
    for (const row of tasks) {
      this.insertTaskFtsStmt.run(row.id, row.title, row.details ?? '')
    }

    const signals = this.db.prepare(`SELECT id, kind, value FROM signals`).all()
    for (const row of signals) {
      try {
        this.insertSignalFtsStmt.run(row.id, row.kind, row.value)
      } catch { /* best-effort rebuild */ }
    }

    const summaries = this.db.prepare(`SELECT id, content FROM summaries`).all()
    this.db.prepare(`DELETE FROM summaries_fts`).run()
    for (const row of summaries) {
      this.insertSummaryFtsStmt.run(row.id, row.content)
    }
  }

  appendEpisode(entry) {
    const clean = cleanMemoryText(entry.content)
    if (!clean) return null
    const ts = entry.ts || new Date().toISOString()
    const dayKey = ts.slice(0, 10)
    const sourceRef = entry.sourceRef || null
    this.insertEpisodeStmt.run(
      ts,
      dayKey,
      entry.backend || 'claude2bot',
      entry.channelId || null,
      entry.userId || null,
      entry.userName || null,
      entry.sessionId || null,
      entry.role,
      entry.kind || 'message',
      clean,
      sourceRef,
    )

    const episodeId = sourceRef ? this.getEpisodeBySourceStmt.get(sourceRef)?.id : null
    const finalEpisodeId = episodeId ?? this.db.prepare('SELECT last_insert_rowid() AS id').get().id
    if (finalEpisodeId) {
      try {
        this.insertEpisodeFtsStmt.run(finalEpisodeId, clean)
      } catch { /* duplicate rowid import */ }
      const shouldCandidate =
        entry.role === 'user' &&
        entry.kind !== 'schedule-inject' &&
        entry.kind !== 'event-inject'
      const score = shouldCandidate ? candidateScore(clean, entry.role) : 0
      if (score > 0) {
        this.insertCandidateStmt.run(finalEpisodeId, ts, dayKey, entry.role, clean, score)
      }

      // Inline embedding: immediately make this episode searchable via dense search
      if (shouldCandidate && clean.length >= 10 && clean.length <= 500 && !looksLowSignal(clean)) {
        this._embedEpisodeAsync(finalEpisodeId, clean)
      }
    }
    return finalEpisodeId ?? null
  }

  _embedEpisodeAsync(episodeId, content) {
    const model = getEmbeddingModelId()
    const contentHash = hashEmbeddingInput(content)
    const existing = this.getVectorStmt.get('episode', episodeId, model)
    if (existing?.content_hash === contentHash) return
    // Persist to DB queue for crash recovery
    try {
      this.db.prepare('INSERT OR IGNORE INTO pending_embeds (entity_type, entity_id, content) VALUES (?, ?, ?)').run('episode', episodeId, content.slice(0, 320))
    } catch {}
    // Process asynchronously
    const task = async () => {
      const vector = await embedText(content.slice(0, 320))
      if (!Array.isArray(vector) || vector.length === 0) return
      this.upsertVectorStmt.run('episode', episodeId, model, vector.length, JSON.stringify(vector), contentHash)
      this._syncToVecTable('episode', episodeId, vector)
      try { this.db.prepare('DELETE FROM pending_embeds WHERE entity_type = ? AND entity_id = ?').run('episode', episodeId) } catch {}
    }
    if (!this._embedQueue) this._embedQueue = Promise.resolve()
    this._embedQueue = this._embedQueue.then(task).catch(() => {})
  }

  async processPendingEmbeds() {
    const pending = this.db.prepare('SELECT entity_type, entity_id, content FROM pending_embeds ORDER BY id LIMIT 50').all()
    if (pending.length === 0) return 0
    const model = getEmbeddingModelId()
    let processed = 0
    for (const item of pending) {
      const vector = await embedText(item.content.slice(0, 320))
      if (!Array.isArray(vector) || vector.length === 0) continue
      const contentHash = hashEmbeddingInput(item.content)
      this.upsertVectorStmt.run(item.entity_type, item.entity_id, model, vector.length, JSON.stringify(vector), contentHash)
      this._syncToVecTable(item.entity_type, item.entity_id, vector)
      this.db.prepare('DELETE FROM pending_embeds WHERE entity_type = ? AND entity_id = ?').run(item.entity_type, item.entity_id)
      processed += 1
    }
    if (processed > 0) process.stderr.write(`[memory] recovered ${processed} pending embeds\n`)
    return processed
  }

  ingestTranscriptFile(transcriptPath) {
    if (!existsSync(transcriptPath)) return 0
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
    let count = 0
    let index = 0
    for (const line of lines) {
      index += 1
      try {
        const parsed = JSON.parse(line)
        const role = parsed.message?.role
        if (role !== 'user' && role !== 'assistant') continue
        const text = firstTextContent(parsed.message?.content)
        if (!text.trim()) continue
        const clean = cleanMemoryText(text)
        if (!clean || clean.includes('[Request interrupted by user]')) continue
        const ts = parsed.timestamp ?? parsed.ts ?? new Date(statSync(transcriptPath).mtimeMs).toISOString()
        const sessionId = parsed.sessionId ?? ''
        const sourceRef = `transcript:${sessionId || resolve(transcriptPath)}:${index}:${role}`
        const id = this.appendEpisode({
          ts,
          backend: 'claude-session',
          channelId: null,
          userId: role === 'user' ? 'session:user' : 'session:assistant',
          userName: role,
          sessionId: sessionId || null,
          role,
          kind: 'transcript',
          content: clean,
          sourceRef,
        })
        if (id) count += 1
      } catch { /* skip malformed lines */ }
    }
    return count
  }

  ingestTranscriptFiles(paths) {
    let total = 0
    for (const filePath of paths) {
      total += this.ingestTranscriptFile(filePath)
    }
    return total
  }

  getEpisodesForDate(dayKey) {
    return this.db.prepare(`
      SELECT id, ts, role, content
      FROM episodes
      WHERE day_key = ?
      ORDER BY ts, id
    `).all(dayKey)
  }

  countEpisodes() {
    return this.db.prepare(`SELECT count(*) AS n FROM episodes`).get().n
  }

  getCandidatesForDate(dayKey) {
    return this.db.prepare(`
      SELECT mc.id, mc.episode_id, mc.ts, mc.role, mc.content, mc.score
      FROM memory_candidates mc
      WHERE mc.day_key = ? AND mc.status = 'pending'
      ORDER BY mc.score DESC, mc.ts ASC
    `).all(dayKey)
  }

  getPendingCandidateDays(limit = 7, minCount = 1) {
    return this.db.prepare(`
      SELECT day_key, count(*) AS n
      FROM memory_candidates
      WHERE status = 'pending'
      GROUP BY day_key
      HAVING count(*) >= ?
      ORDER BY day_key DESC
      LIMIT ?
    `).all(minCount, limit)
  }

  getRecentCandidateDays(limit = 7) {
    return this.db.prepare(`
      SELECT day_key, count(*) AS n
      FROM memory_candidates
      GROUP BY day_key
      ORDER BY day_key DESC
      LIMIT ?
    `).all(limit)
  }

  countPendingCandidates(dayKey = null) {
    if (dayKey) {
      return this.db.prepare(`
        SELECT count(*) AS n
        FROM memory_candidates
        WHERE status = 'pending' AND day_key = ?
      `).get(dayKey).n
    }
    return this.db.prepare(`
      SELECT count(*) AS n
      FROM memory_candidates
      WHERE status = 'pending'
    `).get().n
  }

  rebuildCandidates() {
    this.clearCandidatesStmt.run()
    const rows = this.db.prepare(`
      SELECT id, ts, day_key, role, kind, content
      FROM episodes
      ORDER BY ts, id
    `).all()
    let created = 0
    for (const row of rows) {
      const clean = cleanMemoryText(row.content)
      if (!clean) continue
      const shouldCandidate =
        row.role === 'user' &&
        row.kind !== 'schedule-inject' &&
        row.kind !== 'event-inject'
      const score = shouldCandidate ? candidateScore(clean, row.role) : 0
      if (score > 0) {
        this.insertCandidateStmt.run(row.id, row.ts, row.day_key, row.role, clean, score)
        created += 1
      }
    }
    return created
  }

  resetConsolidatedMemory() {
    this.clearFactsStmt.run()
    this.clearTasksStmt.run()
    this.clearSignalsStmt.run()
    this.clearFactsFtsStmt.run()
    this.clearTasksFtsStmt.run()
    this.clearSignalsFtsStmt.run()
    this.clearVectorsStmt.run()
    this.db.prepare(`UPDATE memory_candidates SET status = 'pending'`).run()
  }

  resetConsolidatedMemoryForDays(dayKeys = []) {
    const keys = [...new Set(dayKeys.map(key => String(key).trim()).filter(Boolean))]
    if (keys.length === 0) return

    const placeholders = keys.map(() => '?').join(', ')
    const episodeIds = this.db.prepare(`
      SELECT id
      FROM episodes
      WHERE day_key IN (${placeholders})
    `).all(...keys).map(row => Number(row.id)).filter(Number.isFinite)

    if (episodeIds.length > 0) {
      const episodePlaceholders = episodeIds.map(() => '?').join(', ')

      const factIds = this.db.prepare(`
        SELECT id FROM facts WHERE source_episode_id IN (${episodePlaceholders})
      `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
      if (factIds.length > 0) {
        const factPlaceholders = factIds.map(() => '?').join(', ')
        for (const id of factIds) this.deleteFactFtsStmt.run(id)
        this.db.prepare(`DELETE FROM facts WHERE id IN (${factPlaceholders})`).run(...factIds)
        this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'fact' AND entity_id IN (${factPlaceholders})`).run(...factIds)
      }

      const taskIds = this.db.prepare(`
        SELECT id FROM tasks WHERE source_episode_id IN (${episodePlaceholders})
      `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
      if (taskIds.length > 0) {
        const taskPlaceholders = taskIds.map(() => '?').join(', ')
        for (const id of taskIds) this.deleteTaskFtsStmt.run(id)
        this.db.prepare(`DELETE FROM tasks WHERE id IN (${taskPlaceholders})`).run(...taskIds)
        this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'task' AND entity_id IN (${taskPlaceholders})`).run(...taskIds)
      }

      const signalIds = this.db.prepare(`
        SELECT id FROM signals WHERE source_episode_id IN (${episodePlaceholders})
      `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
      if (signalIds.length > 0) {
        const signalPlaceholders = signalIds.map(() => '?').join(', ')
        for (const id of signalIds) this.deleteSignalFtsStmt.run(id)
        this.db.prepare(`DELETE FROM signals WHERE id IN (${signalPlaceholders})`).run(...signalIds)
        this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'signal' AND entity_id IN (${signalPlaceholders})`).run(...signalIds)
      }
    }

    this.db.prepare(`
      UPDATE memory_candidates
      SET status = 'pending'
      WHERE day_key IN (${placeholders})
    `).run(...keys)
  }

  pruneConsolidatedMemoryOutsideDays(dayKeys = []) {
    const keys = [...new Set(dayKeys.map(key => String(key).trim()).filter(Boolean))]
    if (keys.length === 0) return

    const placeholders = keys.map(() => '?').join(', ')
    const keepEpisodeIds = this.db.prepare(`
      SELECT id
      FROM episodes
      WHERE day_key IN (${placeholders})
    `).all(...keys).map(row => Number(row.id)).filter(Number.isFinite)

    if (keepEpisodeIds.length === 0) return
    const keepPlaceholders = keepEpisodeIds.map(() => '?').join(', ')

    const staleFactIds = this.db.prepare(`
      SELECT id FROM facts
      WHERE source_episode_id IS NOT NULL
        AND source_episode_id NOT IN (${keepPlaceholders})
    `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (staleFactIds.length > 0) {
      const staleFactPlaceholders = staleFactIds.map(() => '?').join(', ')
      for (const id of staleFactIds) this.deleteFactFtsStmt.run(id)
      this.db.prepare(`DELETE FROM facts WHERE id IN (${staleFactPlaceholders})`).run(...staleFactIds)
      this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'fact' AND entity_id IN (${staleFactPlaceholders})`).run(...staleFactIds)
    }

    const staleTaskIds = this.db.prepare(`
      SELECT id FROM tasks
      WHERE source_episode_id IS NOT NULL
        AND source_episode_id NOT IN (${keepPlaceholders})
    `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (staleTaskIds.length > 0) {
      const staleTaskPlaceholders = staleTaskIds.map(() => '?').join(', ')
      for (const id of staleTaskIds) this.deleteTaskFtsStmt.run(id)
      this.db.prepare(`DELETE FROM tasks WHERE id IN (${staleTaskPlaceholders})`).run(...staleTaskIds)
      this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'task' AND entity_id IN (${staleTaskPlaceholders})`).run(...staleTaskIds)
    }

    const staleSignalIds = this.db.prepare(`
      SELECT id FROM signals
      WHERE source_episode_id IS NOT NULL
        AND source_episode_id NOT IN (${keepPlaceholders})
    `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (staleSignalIds.length > 0) {
      const staleSignalPlaceholders = staleSignalIds.map(() => '?').join(', ')
      for (const id of staleSignalIds) this.deleteSignalFtsStmt.run(id)
      this.db.prepare(`DELETE FROM signals WHERE id IN (${staleSignalPlaceholders})`).run(...staleSignalIds)
      this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'signal' AND entity_id IN (${staleSignalPlaceholders})`).run(...staleSignalIds)
    }

    this.db.prepare(`
      DELETE FROM profiles
      WHERE source_episode_id IS NOT NULL
        AND source_episode_id NOT IN (${keepPlaceholders})
    `).run(...keepEpisodeIds)
  }

  markCandidateIdsConsolidated(candidateIds = []) {
    const ids = [...new Set(candidateIds.map(id => Number(id)).filter(Number.isFinite))]
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const stmt = this.db.prepare(`
      UPDATE memory_candidates
      SET status = 'consolidated'
      WHERE status = 'pending'
        AND id IN (${placeholders})
    `)
    const result = stmt.run(...ids)
    return Number(result.changes ?? 0)
  }

  markCandidatesConsolidated(dayKey) {
    return Number(this.db.prepare(`
      UPDATE memory_candidates
      SET status = 'consolidated'
      WHERE day_key = ? AND status = 'pending'
    `).run(dayKey).changes ?? 0)
  }

  upsertSummary(level, periodKey, content, sourceRange = {}) {
    const clean = cleanMemoryText(content)
    if (!clean) return
    this.upsertSummaryStmt.run(
      level,
      periodKey,
      clean,
      sourceRange.start ?? null,
      sourceRange.end ?? null,
    )
    const row = this.getSummaryIdStmt.get(level, periodKey)
    if (row?.id) {
      this.upsertSummaryFtsDeleteStmt.run(row.id)
      this.insertSummaryFtsStmt.run(row.id, clean)
    }
  }

  upsertDocument(kind, docKey, content) {
    const clean = cleanMemoryText(content)
    if (!clean) return
    this.upsertDocumentStmt.run(kind, docKey, clean)
  }

  upsertProfiles(profiles = [], seenAt = null, sourceEpisodeId = null) {
    for (const profile of profiles) {
      const key = normalizeProfileKey(profile?.key)
      const value = cleanMemoryText(profile?.value)
      const confidence = Number(profile?.confidence ?? 0.6)
      if (!key || !value) continue
      this.upsertProfileStmt.run(key, value, confidence, seenAt, seenAt, sourceEpisodeId)
    }
  }

  projectTaskState(taskId) {
    const events = this.getTaskEventsStmt.all(taskId)
    if (!events.length) return null

    let stage = 'planned'
    let evidenceLevel = 'claimed'
    let status = 'active'
    let bestStageRank = taskStageRank(stage)
    let bestEvidenceRank = taskEvidenceRank(evidenceLevel)

    for (const event of events) {
      const nextStage = normalizeTaskStage(event.stage, event.note ?? '')
      const nextEvidence = normalizeEvidenceLevel(event.evidence_level, event.note ?? '')
      const nextStatus = normalizeTaskStatus(event.status, event.note ?? '')

      const stageRank = taskStageRank(nextStage)
      if (stageRank >= bestStageRank) {
        bestStageRank = stageRank
        stage = nextStage
      }

      const evidenceRank = taskEvidenceRank(nextEvidence)
      if (evidenceRank >= bestEvidenceRank) {
        bestEvidenceRank = evidenceRank
        evidenceLevel = nextEvidence
      }

      status = nextStatus
    }

    if (stage === 'done') status = 'done'
    return { stage, evidenceLevel, status }
  }

  async upsertFacts(facts = [], seenAt = null, sourceEpisodeId = null) {
    const model = getEmbeddingModelId()
    for (const fact of facts) {
      const text = cleanMemoryText(fact?.text)
      const factType = normalizeFactType(fact?.type)
      const confidence = Number(fact?.confidence ?? 0.6)
      if (!text || !factType || !shouldKeepFact(factType, text, confidence)) continue

      // Semantic dedup: check if a similar active fact already exists
      const existingExact = this.getFactIdStmt.get(factType, text)
      if (!existingExact) {
        const newVector = await embedText(text)
        if (Array.isArray(newVector) && newVector.length > 0) {
          const samTypeFacts = this.db.prepare(`
            SELECT f.id, f.text, f.confidence, mv.vector_json
            FROM facts f
            JOIN memory_vectors mv ON mv.entity_type = 'fact' AND mv.entity_id = f.id AND mv.model = ?
            WHERE f.fact_type = ? AND f.status = 'active'
          `).all(model, factType)

          let merged = false
          for (const existing of samTypeFacts) {
            try {
              const existingVector = JSON.parse(existing.vector_json)
              const similarity = cosineSimilarity(newVector, existingVector)
              if (similarity >= 0.85) {
                // Merge: update existing fact if new one has higher confidence, bump mention
                if (confidence > existing.confidence) {
                  this.db.prepare(`
                    UPDATE facts SET text = ?, confidence = ?, last_seen = ?, source_episode_id = COALESCE(?, source_episode_id), mention_count = mention_count + 1
                    WHERE id = ?
                  `).run(text, confidence, seenAt, sourceEpisodeId, existing.id)
                  this.deleteFactFtsStmt.run(existing.id)
                  this.insertFactFtsStmt.run(existing.id, text)
                } else {
                  this.db.prepare(`
                    UPDATE facts SET last_seen = ?, mention_count = mention_count + 1
                    WHERE id = ?
                  `).run(seenAt, existing.id)
                }
                merged = true
                break
              }
            } catch { /* ignore parse errors */ }
          }
          if (merged) continue
        }
      }

      this.reviveFactsStmt.run(factType, text)
      const slot = normalizeFactSlot(fact?.slot)
      const workstream = normalizeWorkstream(fact?.workstream)
      this.upsertFactStmt.run(
        factType,
        slot || null,
        workstream || null,
        text,
        confidence,
        seenAt,
        seenAt,
        sourceEpisodeId,
      )
      const row = this.getFactIdStmt.get(factType, text)
      if (row?.id) {
        this.deleteFactFtsStmt.run(row.id)
        this.insertFactFtsStmt.run(row.id, text)
      }
      if (slot) {
        this.staleFactSlotStmt.run(slot, text)
      } else if (row?.id) {
        // Contradiction detection for slot-less facts:
        // If a new fact is semantically similar (cosine > 0.75) but textually different
        // from an existing active fact of the same type, supersede the old one
        try {
          const newVector = await embedText(text)
          if (Array.isArray(newVector) && newVector.length > 0) {
            const sameFacts = this.db.prepare(`
              SELECT f.id, f.text, mv.vector_json
              FROM facts f
              JOIN memory_vectors mv ON mv.entity_type = 'fact' AND mv.entity_id = f.id AND mv.model = ?
              WHERE f.fact_type = ? AND f.status = 'active' AND f.id != ?
            `).all(getEmbeddingModelId(), factType, row.id)
            for (const old of sameFacts) {
              try {
                const oldVector = JSON.parse(old.vector_json)
                const sim = cosineSimilarity(newVector, oldVector)
                if (sim > 0.75 && old.text !== text) {
                  this.db.prepare(`UPDATE facts SET status = 'superseded' WHERE id = ?`).run(old.id)
                }
              } catch {}
            }
          }
        } catch {}
      }
      const profileKey = profileKeyForFact(factType, text, slot)
      if (profileKey) {
        this.upsertProfileStmt.run(profileKey, text, confidence, seenAt, seenAt, sourceEpisodeId)
      }
    }
    for (const kind of ['decision', 'preference', 'constraint', 'fact']) {
      this.markFactsStaleStmt.run(kind, staleCutoffDays(kind))
    }
  }

  upsertTasks(tasks = [], seenAt = null, sourceEpisodeId = null) {
    for (const task of tasks) {
      const title = cleanMemoryText(task?.title)
      if (!title) continue
      const details = composeTaskDetails(task)
      const workstream = normalizeWorkstream(task?.workstream)
      const stage = normalizeTaskStage(task?.stage, details)
      const evidenceLevel = normalizeEvidenceLevel(task?.evidence_level, details)
      const prev = this.getTaskRowStmt.get(title)
      this.upsertTaskStmt.run(
        title,
        details || null,
        workstream || null,
        stage,
        evidenceLevel,
        normalizeTaskStatus(task?.status, details),
        normalizeTaskPriority(task?.priority),
        Number(task?.confidence ?? 0.6),
        seenAt,
        seenAt,
        sourceEpisodeId,
      )
      const row = this.getTaskIdStmt.get(title)
      if (row?.id) {
        this.deleteTaskFtsStmt.run(row.id)
        this.insertTaskFtsStmt.run(row.id, title, details)
        const changed =
          !prev ||
          prev.status !== normalizeTaskStatus(task?.status, details) ||
          prev.stage !== stage ||
          prev.evidence_level !== evidenceLevel
        if (changed) {
          this.insertTaskEventStmt.run(
            row.id,
            seenAt ?? new Date().toISOString(),
            prev ? 'state_update' : 'task_created',
            stage,
            evidenceLevel,
            normalizeTaskStatus(task?.status, details),
            details || null,
            sourceEpisodeId,
          )
          const projected = this.projectTaskState(row.id)
          if (projected) {
            this.updateTaskProjectionStmt.run(projected.stage, projected.evidenceLevel, projected.status, row.id)
          }
        }
      }
    }
    this.markTasksStaleStmt.run()
  }

  replaceInterests(interests = []) {
    this.clearInterestsStmt.run()
    for (const item of interests) {
      if (!item?.name) continue
      this.insertInterestStmt.run(
        String(item.name).trim(),
        Number(item.score ?? item.count ?? 1),
        Number(item.count ?? Math.max(1, Math.round(Number(item.score ?? 1) * 10))),
        item.last_seen ?? item.last ?? null,
      )
    }
  }

  upsertSignals(signals = [], sourceEpisodeId = null, seenAt = null) {
    const seenKeys = new Set()
    for (const signal of signals) {
      if (!signal?.kind || !signal?.value) continue
      const kind = normalizeSignalKind(signal.kind)
      const value = String(signal.value).trim()
      const normalizedValue = cleanMemoryText(value)
      const score = Number(signal.score ?? 0.5)
      if (!shouldKeepSignal(kind, normalizedValue, score)) continue
      if (!normalizedValue) continue
      const dedupeKey = `${kind}:${normalizedValue.toLowerCase()}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)
      this.upsertSignalStmt.run(
        kind,
        normalizedValue,
        score,
        seenAt,
        seenAt,
        sourceEpisodeId,
      )
      const row = this.getSignalIdStmt.get(kind, normalizedValue)
      if (row?.id) {
        this.deleteSignalFtsStmt.run(row.id)
        this.insertSignalFtsStmt.run(row.id, kind, normalizedValue)
      }
      const profileKey = profileKeyForSignal(kind, normalizedValue)
      if (profileKey) {
        this.upsertProfileStmt.run(profileKey, normalizedValue, score, seenAt, seenAt, sourceEpisodeId)
      }
    }
  }

  syncHistoryFromFiles() {
    ensureDir(this.historyDir)

    for (const docKey of ['identity', 'ongoing', 'lifetime', 'context']) {
      const filePath = join(this.historyDir, `${docKey}.md`)
      if (!existsSync(filePath)) continue
      this.upsertDocument(docKey, docKey, readFileSync(filePath, 'utf8'))
    }

    const summaryLevels = ['daily', 'weekly', 'monthly', 'yearly']
    for (const level of summaryLevels) {
      const dir = join(this.historyDir, level)
      if (!existsSync(dir)) continue
      const files = readdirSync(dir).filter(file => file.endsWith('.md')).sort()
      for (const file of files) {
        const content = readFileSync(join(dir, file), 'utf8')
        this.upsertSummary(level, file.replace(/\.md$/, ''), content)
      }
    }

    const lifetimePath = join(this.historyDir, 'lifetime.md')
    if (existsSync(lifetimePath)) {
      this.upsertSummary('lifetime', 'lifetime', readFileSync(lifetimePath, 'utf8'))
    }

    const interestsPath = join(this.historyDir, 'interests.json')
    if (existsSync(interestsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(interestsPath, 'utf8'))
        const items = Object.entries(parsed).map(([name, value]) => ({
          name,
          score: typeof value?.count === 'number' ? value.count : 1,
          count: typeof value?.count === 'number' ? value.count : 1,
          last_seen: value?.last ?? null,
        }))
        this.replaceInterests(items)
      } catch { /* ignore malformed interests */ }
    }
  }

  backfillProject(workspacePath, options = {}) {
    const limit = Number(options.limit ?? 50)
    const projectDir = join(process.env.HOME || '', '.claude', 'projects', workspaceToProjectSlug(workspacePath))
    if (!existsSync(projectDir)) return 0
    const files = readdirSync(projectDir)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
      .map(file => ({
        path: join(projectDir, file),
        mtime: statSync(join(projectDir, file)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(item => item.path)
      .reverse()
    return this.ingestTranscriptFiles(files)
  }

  buildContextText() {
    const parts = []
    const profileRows = this.db.prepare(`
      SELECT key, value
      FROM profiles
      ORDER BY confidence DESC, retrieval_count DESC, last_seen DESC
    `).all()
    if (profileRows.length > 0) {
      parts.push(`## Profile\n${profileRows.map(item => `- [${item.key}] ${item.value}`).join('\n')}`)
    }

    const coreFacts = this.db.prepare(`
      SELECT fact_type, text
      FROM facts
      WHERE status = 'active'
        AND fact_type IN ('preference', 'constraint')
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT 6
    `).all()
    if (coreFacts.length > 0 && profileRows.length === 0) {
      parts.push(`## Core Memory\n${coreFacts.map(item => `- [${item.fact_type}] ${item.text}`).join('\n')}`)
    }

    const durableFacts = this.db.prepare(`
      SELECT fact_type, text, confidence, last_seen, retrieval_count
      FROM facts
      WHERE status = 'active'
        AND fact_type IN ('decision', 'fact')
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT 6
    `).all()
    if (durableFacts.length > 0) {
      const grouped = new Map()
      for (const row of durableFacts) {
        const bucket = grouped.get(row.fact_type) ?? []
        bucket.push(row)
        grouped.set(row.fact_type, bucket)
      }
      const lines = []
      for (const [factType, values] of grouped.entries()) {
        const label = factType[0].toUpperCase() + factType.slice(1)
        lines.push(`### ${label}\n${values.map(value => `- ${value.text}`).join('\n')}`)
      }
      parts.push(`## Decisions\n${lines.join('\n\n')}`)
    }

    const workingTasks = this.db.prepare(`
      SELECT title, details, status, stage, evidence_level
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
      ORDER BY last_seen DESC, retrieval_count DESC
      LIMIT 4
    `).all()
    if (workingTasks.length > 0) {
      parts.push(`## Working Set\n${workingTasks.map(task => {
        const detail = task.details ? ` — ${task.details}` : ''
        return `- [${task.status}/${task.stage}/${task.evidence_level}] ${task.title}${detail}`
      }).join('\n')}`)
    }

    if (profileRows.length === 0 && coreFacts.length === 0 && durableFacts.length === 0) {
      const identity = this.db.prepare(`
        SELECT content FROM documents WHERE kind = 'identity' AND doc_key = 'identity'
      `).get()
      if (identity?.content) parts.push(`## Identity\n${identity.content}`)
    }

    let history = this.db.prepare(`
      SELECT content FROM summaries WHERE level = 'lifetime' ORDER BY updated_at DESC LIMIT 1
    `).get()?.content ?? ''
    if (!history) {
      const rows = this.db.prepare(`
        SELECT content FROM summaries
        WHERE level IN ('yearly', 'monthly', 'weekly', 'daily')
        ORDER BY CASE level
          WHEN 'yearly' THEN 1
          WHEN 'monthly' THEN 2
          WHEN 'weekly' THEN 3
          ELSE 4
        END, updated_at DESC
        LIMIT 3
      `).all()
      if (rows.length > 0) history = rows.map(row => row.content).join('\n\n')
    }
    if (history) parts.push(`## History\n${history}`)

    const interests = this.db.prepare(`
      SELECT name, count FROM interests
      ORDER BY score DESC, count DESC, last_seen DESC
      LIMIT 10
    `).all()
    if (interests.length > 0) {
      parts.push(`## Interests\n${interests.map(item => `${item.name}(${item.count})`).join(', ')}`)
    }

    const signals = this.db.prepare(`
      SELECT kind, value, score, last_seen, retrieval_count
      FROM signals
      ORDER BY score DESC, retrieval_count DESC, last_seen DESC
      LIMIT 8
    `).all()
    const activeSignals = signals
      .map(item => ({
        ...item,
        effectiveScore: decaySignalScore(item.score, item.last_seen, item.kind),
      }))
      .filter(item => item.effectiveScore >= 0.35)
      .slice(0, 5)
    if (activeSignals.length > 0) {
      parts.push(`## Signals\n${activeSignals.map(item => `- [${item.kind}] ${item.value}`).join('\n')}`)
    }

    const tasks = this.db.prepare(`
      SELECT title, details, status, priority, confidence, last_seen, retrieval_count, stage, evidence_level
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        retrieval_count DESC,
        last_seen DESC
      LIMIT 8
    `).all()
    if (tasks.length > 0) {
      const lines = tasks.map(task => {
        const detail = task.details ? ` — ${task.details}` : ''
        return `- [${task.status}/${task.stage}/${task.evidence_level}] ${task.title}${detail}`
      })
      parts.push(`## Ongoing\n${lines.join('\n')}`)
    } else {
      const ongoing = this.db.prepare(`
        SELECT content FROM documents WHERE kind = 'ongoing' AND doc_key = 'ongoing'
      `).get()
      if (ongoing?.content) parts.push(`## Ongoing\n${ongoing.content}`)
    }

    const recent = this.db.prepare(`
      SELECT level, period_key, content
      FROM summaries
      WHERE level IN ('daily', 'weekly')
      ORDER BY period_key DESC
      LIMIT 4
    `).all()
    if (recent.length > 0) {
      parts.push(`## Recent Summaries\n${recent.map(row => `### ${row.level}:${row.period_key}\n${row.content}`).join('\n\n')}`)
    }

    if (parts.length === 0) {
      const recentEpisodes = this.db.prepare(`
        SELECT role, content
        FROM episodes
        ORDER BY ts DESC, id DESC
        LIMIT 12
      `).all().reverse()
      if (recentEpisodes.length > 0) {
        const body = recentEpisodes
          .map(row => `${row.role === 'user' ? 'u' : 'a'}: ${row.content}`)
          .join('\n')
        parts.push(`## Recent Dialogues\n${body}`)
      }
    }

    return parts.join('\n\n').trim()
  }

  writeContextFile() {
    const contextPath = join(this.historyDir, 'context.md')
    ensureDir(this.historyDir)
    const content = this.buildContextText()
    writeFileSync(contextPath, `<!-- Auto-generated by memory store -->\n\n${content}\n`)
    return contextPath
  }

  async warmupEmbeddings() {
    await warmupEmbeddingProvider()
  }

  getEmbeddableItems(options = {}) {
    const perTypeLimit = Math.max(1, Number(options.perTypeLimit ?? 64))
    const items = []

    const factRows = this.db.prepare(`
      SELECT id, fact_type AS subtype, slot, workstream, text AS content
      FROM facts
      WHERE status = 'active'
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(perTypeLimit)
    for (const row of factRows) {
      items.push({
        key: embeddingItemKey('fact', row.id),
        entityType: 'fact',
        entityId: row.id,
        subtype: row.subtype,
        slot: row.slot,
        workstream: row.workstream,
        content: row.content,
      })
    }

    const taskRows = this.db.prepare(`
      SELECT id, status, priority, stage, evidence_level, workstream,
             trim(title || CASE WHEN details IS NOT NULL AND details != '' THEN ' — ' || details ELSE '' END) AS content
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(perTypeLimit)
    for (const row of taskRows) {
      items.push({
        key: embeddingItemKey('task', row.id),
        entityType: 'task',
        entityId: row.id,
        status: row.status,
        priority: row.priority,
        stage: row.stage,
        evidenceLevel: row.evidence_level,
        workstream: row.workstream,
        content: row.content,
      })
    }

    const signalRows = this.db.prepare(`
      SELECT id, kind AS subtype, value AS content
      FROM signals
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(Math.max(8, Math.floor(perTypeLimit * 0.75)))
    for (const row of signalRows) {
      items.push({
        key: embeddingItemKey('signal', row.id),
        entityType: 'signal',
        entityId: row.id,
        subtype: row.subtype,
        content: row.content,
      })
    }

    const summaryRows = this.db.prepare(`
      SELECT id, level AS subtype, period_key AS ref, content
      FROM summaries
      WHERE level IN ('daily', 'weekly', 'monthly', 'yearly', 'lifetime')
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(8, perTypeLimit))
    for (const row of summaryRows) {
      items.push({
        key: embeddingItemKey('summary', row.id),
        entityType: 'summary',
        entityId: row.id,
        subtype: row.subtype,
        ref: row.ref,
        content: row.content,
      })
    }

    const episodeLimit = Math.max(8, Math.floor(perTypeLimit / 2))
    const episodeRows = this.db.prepare(`
      SELECT id, role AS subtype, day_key AS ref, content
      FROM episodes
      WHERE role = 'user'
        AND kind NOT IN ('schedule-inject', 'event-inject')
        AND LENGTH(content) BETWEEN 10 AND 500
        AND content NOT LIKE 'You are consolidating%'
        AND content NOT LIKE 'You are improving%'
        AND content NOT LIKE 'Answer using live%'
        AND content NOT LIKE 'Use the ai_search%'
        AND content NOT LIKE 'Say only%'
        AND ts >= datetime('now', '-7 days')
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(episodeLimit)
    for (const row of episodeRows) {
      items.push({
        key: embeddingItemKey('episode', row.id),
        entityType: 'episode',
        entityId: row.id,
        subtype: row.subtype,
        ref: row.ref,
        content: row.content,
      })
    }

    return items
  }

  async ensureEmbeddings(options = {}) {
    const model = getEmbeddingModelId()
    const candidates = this.getEmbeddableItems(options)
    const contextMap = options.contextMap instanceof Map ? options.contextMap : new Map()

    let updated = 0
    for (const item of candidates) {
      const contextText = contextMap.get(item.key)
      const embedInput = contextText
        ? cleanMemoryText(`${contextText}\n${item.content}`)
        : contextualizeEmbeddingInput(item)
      if (!embedInput) continue
      const contentHash = hashEmbeddingInput(embedInput)
      const existing = this.getVectorStmt.get(item.entityType, item.entityId, model)
      if (existing?.content_hash === contentHash) continue
      const vector = await embedText(embedInput)
      if (!Array.isArray(vector) || vector.length === 0) continue
      this.upsertVectorStmt.run(
        item.entityType,
        item.entityId,
        model,
        vector.length,
        JSON.stringify(vector),
        contentHash,
      )
      this._syncToVecTable(item.entityType, item.entityId, vector)
      updated += 1
    }
    this._pruneOldEpisodeVectors()
    return updated
  }

  _syncToVecTable(entityType, entityId, vector) {
    if (!this.vecEnabled) return
    const rowid = this._vecRowId(entityType, entityId)
    try {
      const hex = vecToHex(vector)
      this.db.exec(`INSERT OR REPLACE INTO vec_memory(rowid, embedding) VALUES (${rowid}, X'${hex}')`)
    } catch { /* ignore */ }
  }

  _vecRowId(entityType, entityId) {
    // Pack entity type + id into a single integer rowid
    const typePrefix = { fact: 1, task: 2, signal: 3, summary: 4, episode: 5 }
    return (typePrefix[entityType] ?? 9) * 10000000 + Number(entityId)
  }

  _vecRowToEntity(rowid) {
    const typeMap = { 1: 'fact', 2: 'task', 3: 'signal', 4: 'summary', 5: 'episode' }
    const typeNum = Math.floor(rowid / 10000000)
    return { entityType: typeMap[typeNum] ?? 'unknown', entityId: rowid % 10000000 }
  }

  _pruneOldEpisodeVectors() {
    // TTL: remove episode vectors older than 30 days
    try {
      const cutoff = this.db.prepare(`
        SELECT id FROM episodes
        WHERE ts < datetime('now', '-30 days')
          AND id IN (SELECT entity_id FROM memory_vectors WHERE entity_type = 'episode')
      `).all()
      for (const { id } of cutoff) {
        this.db.prepare('DELETE FROM memory_vectors WHERE entity_type = ? AND entity_id = ?').run('episode', id)
        if (this.vecEnabled) {
          const rowid = this._vecRowId('episode', id)
          try { this.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
        }
      }
      if (cutoff.length > 0) {
        process.stderr.write(`[memory] pruned ${cutoff.length} old episode vectors\n`)
      }
    } catch { /* ignore */ }
  }

  async classifyQueryIntent(query, queryVector = null) {
    const clean = cleanMemoryText(query)
    if (!clean) {
      return { primary: 'decision', scores: { preference: 0, task: 0, decision: 0, history: 0 } }
    }

    const vector = queryVector ?? await embedText(clean)
    const prototypeVectors = await getIntentPrototypeVectors()
    const scores = {
      preference: 0,
      task: 0,
      decision: 0,
      history: 0,
    }

    for (const [intent, vectors] of prototypeVectors.entries()) {
      let best = 0
      for (const candidate of vectors) {
        best = Math.max(best, cosineSimilarity(vector, candidate))
      }
      scores[intent] = best
    }

    const primary = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'decision'

    return { primary, scores }
  }

  async buildRecentFocusVector(options = {}) {
    const maxEpisodes = Math.max(1, Number(options.maxEpisodes ?? 8))
    const sinceDays = Math.max(1, Number(options.sinceDays ?? 3))
    const channelId = String(options.channelId ?? '').trim()
    const userId = String(options.userId ?? '').trim()
    let rows = []

    if (channelId) {
      rows = this.db.prepare(`
        SELECT content
        FROM episodes
        WHERE role = 'user'
          AND kind NOT IN ('schedule-inject', 'event-inject')
          AND channel_id = ?
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(channelId, `-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0 && userId) {
      rows = this.db.prepare(`
        SELECT content
        FROM episodes
        WHERE role = 'user'
          AND kind NOT IN ('schedule-inject', 'event-inject')
          AND user_id = ?
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(userId, `-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0) {
      rows = this.db.prepare(`
        SELECT content
        FROM episodes
        WHERE role = 'user'
          AND kind NOT IN ('schedule-inject', 'event-inject')
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(`-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0) return []
    const vectors = await Promise.all(
      rows.map(row => embedText(String(cleanMemoryText(row.content)).slice(0, 320))),
    )
    return averageVectors(vectors)
  }

  async rankIntentSeedItems(rows, query = '', queryVector = null, options = {}) {
    if (!rows.length) return []
    const vector = query ? (queryVector ?? await embedText(query)) : null
    const tokens = new Set(tokenizeMemoryText(query))
    const minSimilarity = Number(options.minSimilarity ?? 0)

    const scored = await Promise.all(rows.map(async row => {
      const content = cleanMemoryText(row.content ?? '')
      const contentTokens = tokenizeMemoryText(`${row.subtype ?? ''} ${content}`)
      const overlapCount = contentTokens.reduce((count, token) => count + (tokens.has(token) ? 1 : 0), 0)
      const semanticSimilarity = vector
        ? cosineSimilarity(vector, await embedText(String(`${row.subtype ?? ''} ${content}`).slice(0, 320)))
        : 0
      return {
        ...row,
        semanticSimilarity,
        overlapCount,
        seedRank: semanticSimilarity * 4 + overlapCount * 2 + Number(row.quality_score ?? 0.5),
      }
    }))

    return scored
      .filter(item => item.overlapCount > 0 || item.semanticSimilarity >= minSimilarity || minSimilarity <= 0)
      .sort((a, b) => Number(b.seedRank) - Number(a.seedRank))
  }

  async getSeedResultsForIntent(intent, query = '', queryVector = null, limit = 4) {
    const seedLimit = Math.max(1, Number(limit))
    if (intent === 'preference') {
      const facts = this.db.prepare(`
        SELECT 'fact' AS type, fact_type AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id,
               confidence AS quality_score, retrieval_count
        FROM facts
        WHERE status = 'active'
          AND fact_type IN ('preference', 'constraint')
        ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(Math.max(1, seedLimit - 1))
      const signals = this.db.prepare(`
        SELECT 'signal' AS type, kind AS subtype, CAST(id AS TEXT) AS ref, value AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id,
               score AS quality_score, retrieval_count
        FROM signals
        WHERE kind IN ('language', 'tone')
        ORDER BY score DESC, retrieval_count DESC, last_seen DESC
        LIMIT 2
      `).all()
      const ranked = await this.rankIntentSeedItems([...facts, ...signals], query, queryVector, { minSimilarity: 0.18 })
      return ranked.slice(0, seedLimit).map(item => ({ ...item, score: -9.2 }))
    }

    if (intent === 'task') {
      const tasks = this.db.prepare(`
        SELECT 'task' AS type, status AS subtype, CAST(id AS TEXT) AS ref,
               trim(title || CASE WHEN details IS NOT NULL AND details != '' THEN ' — ' || details ELSE '' END) AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id,
               confidence AS quality_score, retrieval_count
        FROM tasks
        WHERE status IN ('active', 'in_progress', 'paused')
        ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, retrieval_count DESC, last_seen DESC
        LIMIT ?
      `).all(seedLimit)
      const ranked = await this.rankIntentSeedItems(tasks, query, queryVector, { minSimilarity: 0.12 })
      return (ranked.length > 0 ? ranked : tasks).slice(0, seedLimit).map(item => ({ ...item, score: -9.1 }))
    }

    if (intent === 'decision') {
      const facts = this.db.prepare(`
        SELECT 'fact' AS type, fact_type AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id,
               confidence AS quality_score, retrieval_count
        FROM facts
        WHERE status = 'active'
          AND fact_type IN ('decision', 'constraint')
        ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(seedLimit)
      const ranked = await this.rankIntentSeedItems(facts, query, queryVector, { minSimilarity: 0.14 })
      return (ranked.length > 0 ? ranked : facts).slice(0, seedLimit).map(item => ({ ...item, score: -9.1 }))
    }

    if (intent === 'history') {
      const summaries = this.db.prepare(`
        SELECT 'summary' AS type, level AS subtype, period_key AS ref, content,
               updated_at, id AS entity_id, retrieval_count
        FROM summaries
        WHERE level IN ('daily', 'weekly')
        ORDER BY period_key DESC
        LIMIT ?
      `).all(Math.max(1, seedLimit - 1))
      const ranked = await this.rankIntentSeedItems(summaries, query, queryVector, { minSimilarity: 0.08 })
      return (ranked.length > 0 ? ranked : summaries).slice(0, seedLimit).map(item => ({ ...item, score: -8.2 }))
    }

    return []
  }

  searchRelevant(query, limit = 8) {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    return this.combineRetrievalResults(clean, this.searchRelevantSparse(clean, limit * 2), [], limit)
  }

  async searchRelevantHybrid(query, limit = 8, options = {}) {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    const queryVector = options.queryVector ?? await embedText(clean)
    const intent = options.intent ?? await this.classifyQueryIntent(clean, queryVector)
    const focusVector = options.focusVector ?? await this.buildRecentFocusVector({
      channelId: options.channelId,
      userId: options.userId,
    })
    const temporal = parseTemporalHint(clean)
    const dense = await this.searchRelevantDense(clean, limit * 2, queryVector, focusVector)
    const seeded = await this.getSeedResultsForIntent(intent.primary, clean, queryVector, Math.min(4, limit))
    const sparse = [...seeded, ...this.searchRelevantSparse(clean, limit * 2)]

    // Temporal search: add date-matching summaries and episodes directly
    if (temporal) {
      try {
        const temporalSummaries = this.db.prepare(`
          SELECT 'summary' AS type, level AS subtype, period_key AS ref, content,
                 -2.0 AS score, updated_at, id AS entity_id, retrieval_count
          FROM summaries
          WHERE period_key >= ? AND period_key <= ? AND level = 'daily'
        `).all(temporal.start, temporal.end)
        sparse.push(...temporalSummaries)
      } catch {}
      try {
        const temporalEpisodes = this.db.prepare(`
          SELECT 'episode' AS type, role AS subtype, CAST(id AS TEXT) AS ref, content,
                 -1.5 AS score, created_at AS updated_at, id AS entity_id, 0 AS retrieval_count
          FROM episodes
          WHERE day_key >= ? AND day_key <= ?
            AND role = 'user'
            AND kind NOT IN ('schedule-inject', 'event-inject')
            AND content NOT LIKE 'You are consolidating%'
            AND LENGTH(content) >= 10
          ORDER BY ts DESC
          LIMIT 6
        `).all(temporal.start, temporal.end)
        sparse.push(...temporalEpisodes)
      } catch {}
    }

    return this.combineRetrievalResults(clean, sparse, dense, limit, intent)
  }

  searchRelevantSparse(query, limit = 8) {
    const ftsQuery = buildFtsQuery(query)
    const shortTokens = getShortTokensForLike(query)
    if (!ftsQuery && shortTokens.length === 0) return []
    const results = []
    const runFts = Boolean(ftsQuery)

    try {
      if (!runFts) throw 0
      const summaryHits = this.db.prepare(`
        SELECT 'summary' AS type, s.level AS subtype, s.period_key AS ref, s.content AS content,
               bm25(summaries_fts) AS score, s.updated_at AS updated_at, s.id AS entity_id,
               s.retrieval_count AS retrieval_count
        FROM summaries_fts
        JOIN summaries s ON s.id = summaries_fts.rowid
        WHERE summaries_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
      results.push(...summaryHits)
    } catch { /* ignore */ }

    try {
      if (!runFts) throw 0
      const factHits = this.db.prepare(`
        SELECT 'fact' AS type, f.fact_type AS subtype, CAST(f.id AS TEXT) AS ref, f.workstream AS workstream, f.text AS content,
               bm25(facts_fts) AS score, unixepoch(f.last_seen) AS updated_at, f.id AS entity_id,
               f.confidence AS quality_score,
               f.retrieval_count AS retrieval_count,
               e.source_ref AS source_ref,
               e.ts AS source_ts
        FROM facts_fts
        JOIN facts f ON f.id = facts_fts.rowid
        LEFT JOIN episodes e ON e.id = f.source_episode_id
        WHERE facts_fts MATCH ?
          AND f.status = 'active'
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
      results.push(...factHits)
    } catch { /* ignore */ }

    try {
      if (!runFts) throw 0
      const taskHits = this.db.prepare(`
        SELECT 'task' AS type, t.stage AS subtype, CAST(t.id AS TEXT) AS ref, t.workstream AS workstream,
               trim(t.title || CASE WHEN t.details IS NOT NULL AND t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
               bm25(tasks_fts) AS score, unixepoch(t.last_seen) AS updated_at, t.id AS entity_id,
               t.confidence AS quality_score,
               t.stage AS stage, t.evidence_level AS evidence_level, t.status AS status,
               t.retrieval_count AS retrieval_count,
               e.source_ref AS source_ref,
               e.ts AS source_ts
        FROM tasks_fts
        JOIN tasks t ON t.id = tasks_fts.rowid
        LEFT JOIN episodes e ON e.id = t.source_episode_id
        WHERE tasks_fts MATCH ?
          AND t.status IN ('active', 'in_progress', 'paused')
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
      results.push(...taskHits)
    } catch { /* ignore */ }

    try {
      if (!runFts) throw 0
      const signalHits = this.db.prepare(`
        SELECT 'signal' AS type, s.kind AS subtype, CAST(s.id AS TEXT) AS ref,
               s.value AS content, bm25(signals_fts) AS score,
               unixepoch(s.last_seen) AS updated_at, s.id AS entity_id, s.retrieval_count AS retrieval_count,
               s.score AS quality_score,
               e.source_ref AS source_ref,
               e.ts AS source_ts
        FROM signals_fts
        JOIN signals s ON s.id = signals_fts.rowid
        LEFT JOIN episodes e ON e.id = s.source_episode_id
        WHERE signals_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
      results.push(...signalHits)
    } catch { /* ignore */ }

    try {
      if (!runFts) throw 0
      const episodeHits = this.db.prepare(`
        SELECT 'episode' AS type, e.role AS subtype, CAST(e.id AS TEXT) AS ref,
               e.content AS content, bm25(episodes_fts) AS score,
               e.created_at AS updated_at, e.id AS entity_id, 0 AS retrieval_count,
               NULL AS quality_score,
               e.source_ref AS source_ref,
               e.ts AS source_ts
        FROM episodes_fts
        JOIN episodes e ON e.id = episodes_fts.rowid
        WHERE episodes_fts MATCH ?
          AND e.role = 'user'
          AND e.kind NOT IN ('schedule-inject', 'event-inject')
          AND e.content NOT LIKE 'You are consolidating%'
          AND e.content NOT LIKE 'You are improving%'
          AND e.content NOT LIKE 'You are analyzing%'
          AND e.content NOT LIKE 'Answer using live%'
          AND e.content NOT LIKE 'Use the ai_search%'
          AND e.content NOT LIKE 'Say only%'
          AND e.content NOT LIKE 'Compress these summaries%'
          AND e.content NOT LIKE 'Summarize the conversation%'
          AND LENGTH(e.content) >= 10
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, Math.min(limit, 6))
      results.push(...episodeHits)
    } catch { /* ignore */ }

    // LIKE fallback for 2-char Korean tokens that trigram can't index
    if (shortTokens.length > 0 && results.length < limit) {
      const seen = new Set(results.map(r => `${r.type}:${r.entity_id}`))
      const likeConditions = shortTokens.map(() => 'f.text LIKE ?').join(' OR ')
      const likeParams = shortTokens.map(t => `%${t}%`)
      try {
        const likeFacts = this.db.prepare(`
          SELECT 'fact' AS type, f.fact_type AS subtype, CAST(f.id AS TEXT) AS ref, f.text AS content,
                 0 AS score, unixepoch(f.last_seen) AS updated_at, f.id AS entity_id,
                 f.confidence AS quality_score, f.retrieval_count AS retrieval_count,
                 NULL AS source_ref, NULL AS source_ts
          FROM facts f
          WHERE f.status = 'active' AND (${likeConditions})
          LIMIT ?
        `).all(...likeParams, Math.min(limit, 4))
        for (const hit of likeFacts) {
          if (seen.has(`fact:${hit.entity_id}`)) continue
          // score proportional to how many short tokens match
          const matchCount = shortTokens.filter(t => hit.content.includes(t)).length
          hit.score = -(matchCount / shortTokens.length) * 1.5
          results.push(hit)
        }
      } catch { /* ignore */ }
      try {
        const likeTasks = this.db.prepare(`
          SELECT 'task' AS type, t.stage AS subtype, CAST(t.id AS TEXT) AS ref,
                 trim(t.title || CASE WHEN t.details IS NOT NULL AND t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
                 0 AS score, unixepoch(t.last_seen) AS updated_at, t.id AS entity_id,
                 t.confidence AS quality_score, t.retrieval_count AS retrieval_count,
                 NULL AS source_ref, NULL AS source_ts
          FROM tasks t
          WHERE t.status IN ('active', 'in_progress', 'paused')
            AND (${shortTokens.map(() => '(t.title LIKE ? OR t.details LIKE ?)').join(' OR ')})
          LIMIT ?
        `).all(...shortTokens.flatMap(t => [`%${t}%`, `%${t}%`]), Math.min(limit, 4))
        for (const hit of likeTasks) {
          if (seen.has(`task:${hit.entity_id}`)) continue
          const matchCount = shortTokens.filter(t => hit.content.includes(t)).length
          hit.score = -(matchCount / shortTokens.length) * 1.5
          results.push(hit)
        }
      } catch { /* ignore */ }
    }

    return results
  }

  async searchRelevantDense(query, limit = 8, queryVector = null, focusVector = null) {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    const model = getEmbeddingModelId()
    await this.ensureEmbeddings({ perTypeLimit: Math.max(limit * 4, 12) })
    const vector = queryVector ?? await embedText(clean)
    if (!Array.isArray(vector) || vector.length === 0) return []

    // sqlite-vec KNN path
    if (this.vecEnabled) {
      try {
        const hex = vecToHex(vector)
        const knnRows = this.db.prepare(`
          SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?
        `).all(limit * 3)

        const results = []
        for (const knn of knnRows) {
          const { entityType, entityId } = this._vecRowToEntity(knn.rowid)
          const meta = this._getEntityMeta(entityType, entityId, model)
          if (!meta) continue
          const similarity = 1 - knn.distance  // L2 distance → approximate similarity
          const focusSimilarity = Array.isArray(focusVector) ? (() => {
            try {
              const rv = JSON.parse(meta.vector_json)
              return rv.length === focusVector.length ? cosineSimilarity(focusVector, rv) : 0
            } catch { return 0 }
          })() : 0
          results.push({
            ...meta,
            ref: String(entityId),
            score: -similarity,
            focus_similarity: focusSimilarity,
          })
        }
        return results.sort((a, b) => Number(a.score) - Number(b.score)).slice(0, limit)
      } catch (e) {
        process.stderr.write(`[memory] vec KNN failed, falling back: ${e.message}\n`)
      }
    }

    // Fallback: JS cosine scan
    const rows = [
      ...this.listDenseFactRowsStmt.all(model),
      ...this.listDenseTaskRowsStmt.all(model),
      ...this.listDenseSignalRowsStmt.all(model),
      ...this.listDenseSummaryRowsStmt.all(model),
      ...this.listDenseEpisodeRowsStmt.all(model),
    ]

    return rows
      .map(row => {
        try {
          const rowVector = JSON.parse(row.vector_json)
          const similarity = cosineSimilarity(vector, rowVector)
          const focusSimilarity =
            Array.isArray(focusVector) && focusVector.length === rowVector.length
              ? cosineSimilarity(focusVector, rowVector)
              : 0
          return {
            ...row,
            ref: String(row.entity_id),
            score: -similarity,
            focus_similarity: focusSimilarity,
          }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.score) - Number(b.score))
      .slice(0, limit)
  }

  _getEntityMeta(entityType, entityId, model) {
    const stmtMap = {
      fact: this.listDenseFactRowsStmt,
      task: this.listDenseTaskRowsStmt,
      signal: this.listDenseSignalRowsStmt,
      summary: this.listDenseSummaryRowsStmt,
      episode: this.listDenseEpisodeRowsStmt,
    }
    const stmt = stmtMap[entityType]
    if (!stmt) return null
    const rows = stmt.all(model)
    return rows.find(r => Number(r.entity_id) === entityId) ?? null
  }

  combineRetrievalResults(query, sparseResults, denseResults, limit = 8, intent = null) {
    const now = Date.now()
    const merged = new Map()
    const queryTokens = new Set(tokenizeMemoryText(query))
    const queryTokenCount = queryTokens.size
    const primaryIntent = intent?.primary ?? 'decision'

    for (const item of sparseResults) {
      const key = `${item.type}:${item.subtype}:${item.ref}`
      merged.set(key, {
        ...item,
        sparse_score: Number(item.score),
        dense_score: null,
      })
    }

    for (const item of denseResults) {
      const key = `${item.type}:${item.subtype}:${item.ref}`
      const prev = merged.get(key)
      if (prev) {
        prev.dense_score = Number(item.score)
      } else {
        merged.set(key, {
          ...item,
          sparse_score: null,
          dense_score: Number(item.score),
        })
      }
    }

    const scored = [...merged.values()]
      .map(item => {
        const sparse = item.sparse_score ?? 0
        const dense = item.dense_score ?? 0
        const ageSeconds = item.updated_at ? Math.max(0, now / 1000 - Number(item.updated_at)) : 0
        const recencyPenalty = Math.min(0.35, ageSeconds / (60 * 60 * 24 * 30) * 0.05)
        const contentTokens = tokenizeMemoryText(`${item.subtype ?? ''} ${item.content}`)
        const overlapCount = contentTokens.reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0)
        const retrievalBoost = -Math.min(0.08, Number(item.retrieval_count ?? 0) * 0.01)
        const focusBoost =
          primaryIntent === 'task' || primaryIntent === 'decision'
            ? -Math.min(0.14, Math.max(0, Number(item.focus_similarity ?? 0)) * 0.12)
            : 0
        const qualityBoost =
          item.type === 'fact' || item.type === 'task'
            ? -Math.min(0.12, Math.max(0, Number(item.quality_score ?? 0.5) - 0.5) * 0.3)
            : item.type === 'signal'
              ? -Math.min(0.08, Math.max(0, Number(item.quality_score ?? 0.5) - 0.5) * 0.2)
              : 0
        const typeBoost =
          item.type === 'fact'
            ? (
                item.subtype === 'preference' ? -0.16 :
                item.subtype === 'constraint' ? -0.15 :
                item.subtype === 'decision' ? -0.11 :
                -0.09
              )
            : item.type === 'task' ? -0.10 :
            item.type === 'signal'
              ? (
                  item.subtype === 'tone' ? -0.08 :
                  item.subtype === 'language' ? -0.08 :
                  -0.04
                )
              : item.type === 'summary' ? -0.06 :
              item.type === 'episode' ? -0.04 :
              0
        const intentBoost =
          primaryIntent === 'preference'
            ? (
                item.type === 'fact' && (item.subtype === 'preference' || item.subtype === 'constraint') ? -0.18 :
                item.type === 'signal' && (item.subtype === 'tone' || item.subtype === 'language') ? -0.14 :
                item.type === 'task' ? 0.10 :
                item.type === 'summary' ? 0.08 :
                item.type === 'episode' ? 0.12 :
                0
              )
            : primaryIntent === 'task'
              ? (
                  item.type === 'task' ? -0.18 :
                  item.type === 'fact' && item.subtype === 'decision' ? -0.06 :
                  item.type === 'signal' ? 0.08 :
                  item.type === 'summary' ? 0.06 :
                  item.type === 'episode' ? 0.04 :
                  0
                )
              : primaryIntent === 'history'
                ? (
                    item.type === 'summary' ? -0.16 :
                    item.type === 'episode' ? -0.12 :
                    item.type === 'task' ? -0.04 :
                    item.type === 'signal' ? 0.06 :
                    0
                  )
                : (
                    item.type === 'fact' && item.subtype === 'decision' ? -0.10 :
                    item.type === 'fact' && item.subtype === 'constraint' ? -0.08 :
                    item.type === 'task' ? -0.05 :
                    item.type === 'summary' ? 0.04 :
                    0
                  )
        const densityPenalty =
          item.type === 'signal' && overlapCount === 0 ? 0.12 :
          item.type === 'summary' && overlapCount === 0 ? 0.08 :
          item.type === 'episode' && overlapCount === 0 ? 0.10 :
          0
        return {
          ...item,
          content: compactRetrievalContent(item),
          overlapCount,
          weighted_score: sparse + dense + recencyPenalty + typeBoost + intentBoost + retrievalBoost + focusBoost + qualityBoost + densityPenalty,
        }
      })
    const positiveCoreMatches = scored.filter(item =>
      Number(item.overlapCount) > 0 &&
      (item.type === 'fact' || item.type === 'task' || item.type === 'summary'),
    ).length
    const hasPositiveOverlap = scored.some(item => Number(item.overlapCount) > 0)
    const ranked = scored
      .map(item => {
        const overlapAdjustment =
          Number(item.overlapCount) > 0
            ? -Math.min(0.2, Number(item.overlapCount) * 0.06)
            : hasPositiveOverlap ? 0.28 : 0.08
        return {
          ...item,
          weighted_score: Number(item.weighted_score) + overlapAdjustment,
        }
      })
      .filter(item => {
        if (positiveCoreMatches < 2) return true
        if (Number(item.overlapCount) > 0) return true
        return item.type === 'signal'
      })
      .sort((a, b) => Number(a.weighted_score) - Number(b.weighted_score))

    const hasCoreResult = ranked.some(item => item.type === 'fact' || item.type === 'task')
    const conciseQuery = queryTokenCount <= 4
    const hasTaskCandidate = ranked.some(item => item.type === 'task')
    const typeCaps =
      primaryIntent === 'preference'
        ? new Map([['fact', 3], ['task', 0], ['summary', 0], ['signal', 2], ['episode', 0]])
        : primaryIntent === 'task'
          ? new Map([['fact', 1], ['task', hasTaskCandidate ? 4 : 2], ['summary', 0], ['signal', 0], ['episode', 1]])
          : primaryIntent === 'history'
            ? new Map([['fact', 1], ['task', 1], ['summary', 3], ['signal', 0], ['episode', 2]])
            : new Map([
                ['fact', 4],
                ['task', 3],
                ['summary', hasCoreResult ? (conciseQuery ? 0 : 1) : 1],
                ['signal', 0],
                ['episode', 1],
              ])
    const typeCounts = new Map()
    const selected = []
    const rerankThreshold = -0.5
    const rerankPool = ranked.slice(0, Math.max(limit * 2, 10))
      .map(item => {
        const subtypeBonus =
          primaryIntent === 'preference'
            ? (
                item.type === 'fact' && item.subtype === 'preference' ? -0.10 :
                item.type === 'fact' && item.subtype === 'constraint' ? -0.08 :
                item.type === 'signal' && (item.subtype === 'tone' || item.subtype === 'language') ? -0.08 :
                0
              )
            : primaryIntent === 'task'
              ? (item.type === 'task' ? -0.10 : 0)
              : primaryIntent === 'history'
                ? (item.type === 'summary' ? -0.08 : item.type === 'episode' ? -0.06 : 0)
                : (item.type === 'fact' && item.subtype === 'decision' ? -0.06 : 0)
        return {
          ...item,
          rerank_score: Number(item.weighted_score) + subtypeBonus,
        }
      })
      .filter(item => {
        if (primaryIntent === 'preference') {
          return item.type === 'fact' || item.type === 'signal'
        }
        if (primaryIntent === 'task' && hasTaskCandidate) {
          return item.type === 'task' || (item.type === 'fact' && item.subtype === 'decision')
        }
        if (primaryIntent === 'decision') {
          return item.type === 'fact' || item.type === 'task'
        }
        return true
      })
      .sort((a, b) => Number(a.rerank_score) - Number(b.rerank_score))

    for (const item of rerankPool) {
      if (Number(item.rerank_score) > rerankThreshold) continue
      const type = String(item.type)
      const cap = typeCaps.get(type) ?? 2
      const count = typeCounts.get(type) ?? 0
      if (count >= cap) continue
      selected.push(item)
      typeCounts.set(type, count + 1)
      if (selected.length >= limit) break
    }
    return selected
  }

  recordRetrieval(results = []) {
    const now = new Date().toISOString()
    for (const item of results) {
      const entityId = Number(item?.entity_id)
      if (!Number.isFinite(entityId) || entityId <= 0) continue
      if (item.type === 'fact') {
        this.bumpFactRetrievalStmt.run(now, entityId)
      } else if (item.type === 'task') {
        this.bumpTaskRetrievalStmt.run(now, entityId)
      } else if (item.type === 'summary') {
        this.bumpSummaryRetrievalStmt.run(now, entityId)
      } else if (item.type === 'signal') {
        this.bumpSignalRetrievalStmt.run(now, entityId)
      } else if (item.type === 'profile') {
        this.bumpProfileRetrievalStmt.run(now, String(item.subtype))
      }
    }
  }

  async getCoreMemoryItems(query = '', intent = null, queryVector = null) {
    const queryTokens = new Set(tokenizeMemoryText(query))
    const primaryIntent = intent?.primary ?? 'decision'
    const vector = query ? (queryVector ?? await embedText(query)) : null
    const profileRows = this.db.prepare(`
      SELECT 'profile' AS type, key AS subtype, value AS content, confidence, last_seen
      FROM profiles
      ORDER BY confidence DESC, retrieval_count DESC, last_seen DESC
      LIMIT 8
    `).all()

    const coreFacts = this.db.prepare(`
      SELECT 'fact' AS type, fact_type AS subtype, text AS content, confidence, last_seen
      FROM facts
      WHERE status = 'active'
        AND fact_type IN ('preference', 'constraint')
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT 10
    `).all()

    const coreSignals = this.db.prepare(`
      SELECT 'signal' AS type, kind AS subtype, value AS content, score AS confidence, last_seen
      FROM signals
      WHERE kind IN ('language', 'tone')
      ORDER BY score DESC, retrieval_count DESC, last_seen DESC
      LIMIT 6
    `).all()
      .map(item => ({
        ...item,
        effectiveScore: decaySignalScore(item.confidence, item.last_seen, item.subtype),
      }))
      .filter(item => item.effectiveScore >= 0.45)

    const dedupe = new Set()
    const items = []
    const combined = [...profileRows, ...coreFacts, ...coreSignals]
    const semanticScores = vector
      ? await Promise.all(combined.map(async item => {
          const itemVector = await embedText(`${item.subtype} ${item.content}`.slice(0, 320))
          return cosineSimilarity(vector, itemVector)
        }))
      : combined.map(() => 0)

    for (let i = 0; i < combined.length; i += 1) {
      const item = combined[i]
      const key = `${item.type}:${item.subtype}:${item.content}`
      if (dedupe.has(key)) continue
      dedupe.add(key)
      const contentTokens = tokenizeMemoryText(`${item.subtype} ${item.content}`)
      const overlapCount = contentTokens.reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0)
      const typeBoost =
        item.type === 'profile'
          ? 3
          : item.type === 'signal'
          ? (item.subtype === 'language' || item.subtype === 'tone' ? 2 : 1)
          : item.subtype === 'preference'
            ? 2
            : 1
      const intentBoost =
        primaryIntent === 'preference'
          ? typeBoost
          : primaryIntent === 'task'
            ? (item.subtype === 'constraint' ? 1 : 0)
            : 0
      const semanticBoost = vector ? semanticScores[i] * 3 : 0
      items.push({
        ...item,
        overlapCount,
        rankScore: overlapCount * 3 + intentBoost + semanticBoost + Number(item.confidence ?? item.effectiveScore ?? 0.5),
      })
    }
    const limit =
      primaryIntent === 'preference' ? 4 :
      primaryIntent === 'decision' ? 3 :
      primaryIntent === 'task' ? 1 :
      primaryIntent === 'history' ? 1 :
      2
    return items
      .filter(item => {
        // profiles always pass (language, tone, etc.)
        if (item.type === 'profile') return true
        // preference intent: all core memory relevant
        if (primaryIntent === 'preference') return true
        // others: require keyword overlap or semantic relevance
        return Number(item.overlapCount) > 0 || Number(item.rankScore) > 4.5
      })
      .sort((a, b) => Number(b.rankScore) - Number(a.rankScore))
      .slice(0, limit)
  }

  async getPriorityTasks(query = '', options = {}) {
    const queryVector = query ? await embedText(query) : []
    const focusVector = options.focusVector ?? await this.buildRecentFocusVector({
      channelId: options.channelId,
      userId: options.userId,
    })
    const workstreamHint = normalizeWorkstream(options.workstreamHint)
    const hintTokens = tokenizedWorkstream(workstreamHint)

    const rows = this.db.prepare(`
      SELECT id, title, details, workstream, status, priority, confidence, last_seen, retrieval_count, stage, evidence_level
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
      ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, retrieval_count DESC, last_seen DESC
      LIMIT 12
    `).all()

    const scored = await Promise.all(rows.map(async row => {
      const content = cleanMemoryText(`${row.title} ${row.details ?? ''}`)
      const taskVector = await embedText(content.slice(0, 320))
      const querySimilarity =
        Array.isArray(queryVector) && queryVector.length === taskVector.length
          ? cosineSimilarity(queryVector, taskVector)
          : 0
      const focusSimilarity =
        Array.isArray(focusVector) && focusVector.length === taskVector.length
          ? cosineSimilarity(focusVector, taskVector)
          : 0
      const priorityBoost =
        row.priority === 'high' ? 0.35 :
        row.priority === 'normal' ? 0.18 :
        0
      const workstreamMatch =
        hintTokens.length > 0
          ? tokenizedWorkstream(row.workstream).filter(token => hintTokens.includes(token)).length
          : 0
      const recencyBoost = Math.min(0.18, Number(row.retrieval_count ?? 0) * 0.01)
      return {
        ...row,
        priority_score: querySimilarity * 4 + focusSimilarity * 3 + priorityBoost + workstreamMatch * 1.2 + recencyBoost + Number(row.confidence ?? 0.5),
      }
    }))

    return scored
      .sort((a, b) => Number(b.priority_score) - Number(a.priority_score))
      .slice(0, Math.max(1, Number(options.limit ?? 3)))
  }

  async buildInboundMemoryContext(query, options = {}) {
    const clean = cleanMemoryText(query)
    if (!clean || looksLowSignal(clean)) return ''

    const limit = Number(options.limit ?? 6)
    const lines = []
    const queryVector = await embedText(clean)
    const focusVector = await this.buildRecentFocusVector({
      channelId: options.channelId,
      userId: options.userId,
    })
    const intent = await this.classifyQueryIntent(clean, queryVector)
    const topTaskHint = this.db.prepare(`
      SELECT workstream
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
        AND workstream IS NOT NULL
        AND workstream != ''
      ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, retrieval_count DESC, last_seen DESC
      LIMIT 1
    `).get()?.workstream ?? ''
    const coreMemory = await this.getCoreMemoryItems(clean, intent, queryVector)
    if (coreMemory.length > 0) {
      lines.push('Core memory:')
      for (const item of coreMemory) {
        lines.push(`- [${item.type}:${item.subtype}] ${String(item.content).slice(0, 180)}`)
      }
    }

    if (intent.primary === 'task') {
      const priorityTasks = await this.getPriorityTasks(clean, {
        channelId: options.channelId,
        userId: options.userId,
        focusVector,
        workstreamHint: topTaskHint,
        limit: 3,
      })
      if (priorityTasks.length > 0) {
        lines.push('Priority tasks:')
        for (const task of priorityTasks) {
          const detail = task.details ? ` — ${task.details}` : ''
          lines.push(`- [${task.status}/${task.stage}/${task.evidence_level}] ${task.title}${detail}`)
        }
      }
    } else if (intent.primary === 'decision') {
      const decisions = this.db.prepare(`
        SELECT fact_type, text
        FROM facts
        WHERE status = 'active'
          AND fact_type IN ('decision', 'constraint')
        ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
        LIMIT 3
      `).all()
      if (decisions.length > 0) {
        lines.push('Key decisions:')
        for (const item of decisions) {
          lines.push(`- [${item.fact_type}] ${item.text}`)
        }
      }
    }

    let relevant = await this.searchRelevantHybrid(clean, limit, {
      queryVector,
      intent,
      focusVector,
      channelId: options.channelId,
      userId: options.userId,
    })
    // typeCaps in combineRetrievalResults already controls type distribution per intent
    // only apply minimal filtering for strongest-signal intents
    if (intent.primary === 'preference') {
      relevant = relevant.filter(item => item.type === 'fact' || item.type === 'signal')
    }
    relevant = relevant.slice(0, Math.max(3, limit - 1))

    if (relevant.length > 0) {
      this.recordRetrieval(relevant)
      lines.push('Relevant memory:')
      for (const item of relevant) {
        if (item.type === 'task') {
          lines.push(`- [task:${item.subtype}/${item.evidence_level ?? 'claimed'}] ${String(item.content).slice(0, 180)}`)
        } else {
          lines.push(`- [${item.type}:${item.subtype}] ${String(item.content).slice(0, 180)}`)
        }
      }

      const hasSignal = intent.primary === 'preference' && relevant.some(item => item.type === 'signal')
      if (hasSignal) {
        const seenSignals = new Set(
          relevant
            .filter(item => item.type === 'signal')
            .map(item => `${item.subtype}:${item.content}`),
        )
        const extraSignals = this.db.prepare(`
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
        if (extraSignals.length > 0) {
          lines.push('Signal hints:')
          for (const signal of extraSignals) {
            lines.push(`- [${signal.kind}] ${signal.value}`)
          }
        }
      }
    } else {
      const facts = this.db.prepare(`
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
      if (facts.length > 0) {
        lines.push('Memory hints:')
        for (const fact of facts) {
          const confidence = decayConfidence(fact.confidence, fact.last_seen)
          if (confidence < 0.25) continue
          lines.push(`- [${fact.fact_type}] ${fact.text}`)
        }
      }

      const tasks = this.db.prepare(`
        SELECT title, status, confidence, last_seen
        FROM tasks
        WHERE status IN ('active', 'in_progress', 'paused')
        ORDER BY
          CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          last_seen DESC
        LIMIT 3
      `).all()
      if (tasks.length > 0) {
        lines.push('Task hints:')
        for (const task of tasks) {
          const confidence = decayConfidence(task.confidence, task.last_seen)
          if (confidence < 0.25) continue
          lines.push(`- [${task.status}] ${task.title}`)
        }
      }

      const signals = this.db.prepare(`
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
      if (activeSignals.length > 0) {
        lines.push('Signal hints:')
        for (const signal of activeSignals) {
          lines.push(`- [${signal.kind}] ${signal.value}`)
        }
      }
    }

    if (lines.length === 0) return ''
    return `<memory-context>\n${lines.join('\n')}\n</memory-context>`
  }
}

export function getMemoryStore(dataDir) {
  const key = resolve(dataDir)
  const existing = stores.get(key)
  if (existing) return existing
  const store = new MemoryStore(key)
  stores.set(key, store)
  return store
}
