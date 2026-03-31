#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding, getEmbeddingDims, warmupEmbeddingProvider } from '../lib/embedding-provider.mjs'
import { consolidateRecent, readMainConfig } from '../lib/memory-cycle.mjs'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'claude2bot-claude2bot')
const DB_PATH = join(DATA_DIR, 'memory.sqlite')
const WAL_PATH = join(DATA_DIR, 'memory.sqlite-wal')
const SHM_PATH = join(DATA_DIR, 'memory.sqlite-shm')
const HISTORY_DIR = join(DATA_DIR, 'history')
const CYCLE_CONFIG_PATH = join(DATA_DIR, 'memory-cycle.json')
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const APPLY = process.argv.includes('--apply')
const backupDir = join(tmpdir(), `claude2bot-reset-backup-${process.pid}-${Date.now()}`)

const sourceDb = new DatabaseSync(DB_PATH)
const preservedEpisodes = sourceDb.prepare(`
  SELECT ts, backend, channel_id, user_id, user_name, session_id, role, kind, content, source_ref
  FROM episodes
  WHERE backend = 'discord'
    AND kind IN ('message', 'turn')
  ORDER BY ts, id
`).all()

const summary = {
  backupDir,
  preservedEpisodes: preservedEpisodes.length,
  preservedUserMessages: preservedEpisodes.filter(row => row.role === 'user' && row.kind === 'message').length,
  preservedAssistantTurns: preservedEpisodes.filter(row => row.role === 'assistant' && row.kind === 'turn').length,
}

process.stdout.write(`${JSON.stringify({ phase: 'dry-run', ...summary }, null, 2)}\n`)

if (!APPLY) {
  process.stdout.write('Run with --apply to rebuild from discord episodes only.\n')
  process.exit(0)
}

mkdirSync(backupDir, { recursive: true })
cpSync(DB_PATH, join(backupDir, 'memory.sqlite'))
if (existsSync(WAL_PATH)) cpSync(WAL_PATH, join(backupDir, 'memory.sqlite-wal'))
if (existsSync(SHM_PATH)) cpSync(SHM_PATH, join(backupDir, 'memory.sqlite-shm'))
if (existsSync(CONFIG_PATH)) cpSync(CONFIG_PATH, join(backupDir, 'config.json'))

sourceDb.close()

rmSync(DB_PATH, { force: true })
rmSync(WAL_PATH, { force: true })
rmSync(SHM_PATH, { force: true })
rmSync(HISTORY_DIR, { recursive: true, force: true })

configureEmbedding({ provider: 'local' })
await warmupEmbeddingProvider()
process.env.CLAUDE2BOT_FORCE_VEC_DIMS = String(getEmbeddingDims())

const originalConfigText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : '{}'
const originalConfig = JSON.parse(originalConfigText)
const tempConfig = {
  ...originalConfig,
  embedding: {
    ...(originalConfig.embedding || {}),
    provider: 'local',
  },
}
writeFileSync(CONFIG_PATH, JSON.stringify(tempConfig, null, 2) + '\n', 'utf8')

let finalSummary = null
try {
  const store = getMemoryStore(DATA_DIR)
  for (const episode of preservedEpisodes) {
    store.appendEpisode({
      ts: episode.ts,
      backend: episode.backend,
      channelId: episode.channel_id,
      userId: episode.user_id,
      userName: episode.user_name,
      sessionId: episode.session_id,
      role: episode.role,
      kind: episode.kind,
      content: episode.content,
      sourceRef: episode.source_ref,
    })
  }

  const pendingDays = store.getPendingCandidateDays(30, 1).map(item => item.day_key).sort()
  if (pendingDays.length > 0) {
    const mainConfig = readMainConfig()
    const cycle2Provider = mainConfig?.memory?.cycle2?.provider
    const consolidateOptions = cycle2Provider ? { provider: cycle2Provider } : {}
    await consolidateRecent(pendingDays, process.cwd(), consolidateOptions)
  }
  store.rebuildEntityLinks()
  await store.ensureEmbeddings({ all: true })
  store.writeContextFile()
  store.syncEmbeddingMetadata({ reason: 'reset_memory_from_discord' })
  writeFileSync(CYCLE_CONFIG_PATH, JSON.stringify({
    lastCycle1At: Date.now(),
    lastSleepAt: Date.now(),
    lastFlushAt: Date.now(),
  }, null, 2) + '\n', 'utf8')

  finalSummary = {
    phase: 'applied',
    backupDir,
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

process.stdout.write(`${JSON.stringify(finalSummary, null, 2)}\n`)
