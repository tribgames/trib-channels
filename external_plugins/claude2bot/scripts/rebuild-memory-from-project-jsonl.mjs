#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { cleanMemoryText, getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding, getEmbeddingDims, warmupEmbeddingProvider } from '../lib/embedding-provider.mjs'
import { runCycle1 } from '../lib/memory-cycle.mjs'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'claude2bot-claude2bot')
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const DB_PATH = join(DATA_DIR, 'memory.sqlite')
const WAL_PATH = join(DATA_DIR, 'memory.sqlite-wal')
const SHM_PATH = join(DATA_DIR, 'memory.sqlite-shm')
const HISTORY_DIR = join(DATA_DIR, 'history')
const CYCLE_CONFIG_PATH = join(DATA_DIR, 'memory-cycle.json')

function parseArg(name, fallback = '') {
  const prefix = `${name}=`
  const hit = process.argv.find(arg => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

function workspaceToProjectSlug(workspacePath) {
  return resolve(workspacePath)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1-')
    .replace(/\//g, '-')
}

function splitIntoShards(items, shardCount) {
  const shards = Array.from({ length: shardCount }, () => [])
  items.forEach((item, index) => {
    shards[index % shardCount].push(item)
  })
  return shards
}

const APPLY = process.argv.includes('--apply')
const DAYS = Math.max(1, Number(parseArg('--days', '30')) || 30)
const SHARDS = Math.max(1, Number(parseArg('--shards', '6')) || 6)
const WORKSPACE = parseArg('--workspace', '/Users/jyp/Project/claude2bot')
const PROJECT_DIR = join(homedir(), '.claude', 'projects', workspaceToProjectSlug(WORKSPACE))
const backupDir = join(tmpdir(), `claude2bot-project-rebuild-${process.pid}-${Date.now()}`)

function firstTextContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return String(part.text ?? '')
        return ''
      })
      .join('')
  }
  if (content?.type === 'text') return String(content.text ?? '')
  return ''
}

function shouldSkipSessionContent(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.length > 2000 && /(?:^|\n)[ua]:\s/.test(clean)) return true
  if (/^you are summarizing a day's conversation\b/i.test(clean)) return true
  if (/^you are compressing summaries\b/i.test(clean)) return true
  if (/below is the cleaned conversation log/i.test(clean)) return true
  if (/output only the summary/i.test(clean) && /what tasks were worked on/i.test(clean)) return true
  if (/summarize in ~?\d+ lines/i.test(clean) && /date:\s*\d{4}-\d{2}-\d{2}/i.test(clean)) return true
  if (/^you are answering a user question\b/i.test(clean)) return true
  if (clean.includes('<memory-context>')) return true
  if (/^relevant memory:/i.test(clean)) return true
  if (/^signal hints:/i.test(clean)) return true
  if (/^user question:/i.test(clean)) return true
  return false
}

if (!existsSync(PROJECT_DIR)) {
  process.stderr.write(`Project transcript dir not found: ${PROJECT_DIR}\n`)
  process.exit(1)
}

const cutoffMs = Date.now() - DAYS * 86400000
const files = await (async () => {
  const { readdirSync, statSync } = await import('fs')
  return readdirSync(PROJECT_DIR)
    .filter(name => name.endsWith('.jsonl') && !name.startsWith('agent-'))
    .map(name => {
      const fullPath = join(PROJECT_DIR, name)
      const stat = statSync(fullPath)
      return {
        path: fullPath,
        name,
        mtimeMs: stat.mtimeMs,
        mtime: new Date(stat.mtimeMs).toISOString(),
      }
    })
    .filter(item => item.mtimeMs >= cutoffMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
})()

const shards = splitIntoShards(files, Math.min(SHARDS, Math.max(1, files.length)))
const dryRun = {
  apply: APPLY,
  workspace: WORKSPACE,
  projectDir: PROJECT_DIR,
  dataDir: DATA_DIR,
  days: DAYS,
  shardCount: shards.length,
  fileCount: files.length,
  oldest: files[0]?.mtime ?? null,
  newest: files.at(-1)?.mtime ?? null,
  shards: shards.map((items, index) => ({
    shard: index + 1,
    count: items.length,
    first: items[0]?.mtime ?? null,
    last: items.at(-1)?.mtime ?? null,
    sample: items.slice(0, 3).map(item => basename(item.path)),
  })),
}

process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`)

if (!APPLY) {
  process.stdout.write('Run with --apply to rebuild memory from recent project jsonl files.\n')
  process.exit(0)
}

if (files.length === 0) {
  process.stdout.write('No jsonl files matched the requested date range.\n')
  process.exit(0)
}

mkdirSync(backupDir, { recursive: true })
if (existsSync(DB_PATH)) cpSync(DB_PATH, join(backupDir, 'memory.sqlite'))
if (existsSync(WAL_PATH)) cpSync(WAL_PATH, join(backupDir, 'memory.sqlite-wal'))
if (existsSync(SHM_PATH)) cpSync(SHM_PATH, join(backupDir, 'memory.sqlite-shm'))
if (existsSync(CONFIG_PATH)) cpSync(CONFIG_PATH, join(backupDir, 'config.json'))

const originalConfigText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : '{}'
const originalConfig = JSON.parse(originalConfigText)
const tempConfig = {
  ...originalConfig,
  embedding: {
    ...(originalConfig.embedding || {}),
    provider: 'local',
  },
}

rmSync(DB_PATH, { force: true })
rmSync(WAL_PATH, { force: true })
rmSync(SHM_PATH, { force: true })
rmSync(HISTORY_DIR, { recursive: true, force: true })
rmSync(CYCLE_CONFIG_PATH, { force: true })

configureEmbedding({ provider: 'local' })
await warmupEmbeddingProvider()
process.env.CLAUDE2BOT_FORCE_VEC_DIMS = String(getEmbeddingDims())
writeFileSync(CONFIG_PATH, JSON.stringify(tempConfig, null, 2) + '\n', 'utf8')

let summary = null
try {
  const store = getMemoryStore(DATA_DIR)
  let ingested = 0
  let rebuilt = 0
  for (const [index, shard] of shards.entries()) {
    let shardCount = 0
    for (const item of shard) {
      const lines = readFileSync(item.path, 'utf8').split('\n').filter(Boolean)
      let lineNo = 0
      for (const line of lines) {
        lineNo += 1
        try {
          const parsed = JSON.parse(line)
          const role = parsed.message?.role
          if (role !== 'user' && role !== 'assistant') continue
          const text = firstTextContent(parsed.message?.content)
          if (!text.trim()) continue
          if (shouldSkipSessionContent(text)) continue
          const clean = cleanMemoryText(text)
          if (!clean) continue
          const ts = parsed.timestamp ?? parsed.ts ?? item.mtime
          const sessionId = parsed.sessionId ?? basename(item.path, '.jsonl')
          const kind = role === 'user' ? 'message' : 'turn'
          const id = store.appendEpisode({
            ts,
            backend: 'claude-session',
            channelId: null,
            userId: role === 'user' ? 'session:user' : 'session:assistant',
            userName: role,
            sessionId,
            role,
            kind,
            content: clean,
            sourceRef: `rebuild:${sessionId}:${lineNo}:${role}:${kind}`,
          })
          if (id) {
            shardCount += 1
            rebuilt += 1
          }
        } catch {
          // skip malformed lines
        }
      }
    }
    ingested += shardCount
    process.stdout.write(`[rebuild] shard ${index + 1}/${shards.length}: files=${shard.length} episodes=${shardCount}\n`)
  }

  writeFileSync(CYCLE_CONFIG_PATH, JSON.stringify({
    lastCycle1At: 0,
    lastSleepAt: 0,
    lastFlushAt: 0,
  }, null, 2) + '\n', 'utf8')

  await runCycle1(WORKSPACE, tempConfig, { skipWaterfall: true })

  writeFileSync(CYCLE_CONFIG_PATH, JSON.stringify({
    lastCycle1At: Date.now(),
    lastSleepAt: Date.now(),
    lastFlushAt: Date.now(),
  }, null, 2) + '\n', 'utf8')

  summary = {
    phase: 'applied',
    backupDir,
    files: files.length,
    ingestedEpisodes: ingested,
    rebuiltEpisodes: rebuilt,
    episodes: store.countEpisodes(),
    facts: store.db.prepare(`SELECT count(*) AS n FROM facts`).get().n,
    tasks: store.db.prepare(`SELECT count(*) AS n FROM tasks`).get().n,
    signals: store.db.prepare(`SELECT count(*) AS n FROM signals`).get().n,
    profiles: store.db.prepare(`SELECT count(*) AS n FROM profiles`).get().n,
    entities: store.db.prepare(`SELECT count(*) AS n FROM entities`).get().n,
    relations: store.db.prepare(`SELECT count(*) AS n FROM relations`).get().n,
    propositions: store.db.prepare(`SELECT count(*) AS n FROM propositions`).get().n,
  }
} finally {
  writeFileSync(CONFIG_PATH, originalConfigText, 'utf8')
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
