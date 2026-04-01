#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding } from '../lib/embedding-provider.mjs'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'trib-channels-trib-channels')
const DB_PATH = join(DATA_DIR, 'memory.sqlite')
const WAL_PATH = join(DATA_DIR, 'memory.sqlite-wal')
const SHM_PATH = join(DATA_DIR, 'memory.sqlite-shm')
const APPLY = process.argv.includes('--apply')
const backupDir = join(tmpdir(), `trib-channels-transcript-cleanup-${process.pid}-${Date.now()}`)

try {
  const config = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8'))
  const embeddingConfig = config?.embedding ?? {}
  if (embeddingConfig.provider || embeddingConfig.ollamaModel) {
    configureEmbedding({
      provider: embeddingConfig.provider,
      ollamaModel: embeddingConfig.ollamaModel,
    })
  }
} catch {}

function logJson(label, payload) {
  process.stdout.write(`\n[${label}]\n${JSON.stringify(payload, null, 2)}\n`)
}

function countBySource(db, table, transcriptIds = []) {
  if (transcriptIds.length === 0) return 0
  const placeholders = transcriptIds.map(() => '?').join(', ')
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE source_episode_id IN (${placeholders})`).get(...transcriptIds)?.n ?? 0)
}

function promptLikeCount(db) {
  return Number(db.prepare(`
    SELECT count(*) AS n
    FROM episodes
    WHERE kind = 'transcript'
      AND (
        LENGTH(content) >= 10000
        OR content LIKE 'You are analyzing%'
        OR content LIKE 'You are consolidating%'
        OR content LIKE 'You are improving%'
        OR content LIKE 'Summarize the conversation%'
      )
  `).get()?.n ?? 0)
}

const previewDb = new DatabaseSync(DB_PATH)
const transcriptIds = previewDb.prepare(`
  SELECT id
  FROM episodes
  WHERE kind = 'transcript'
  ORDER BY id
`).all().map(row => Number(row.id)).filter(Number.isFinite)

const duplicateSummary = previewDb.prepare(`
  WITH grouped AS (
    SELECT lower(trim(content)) AS normalized,
           SUM(CASE WHEN kind = 'message' THEN 1 ELSE 0 END) AS msg_count,
           SUM(CASE WHEN kind = 'transcript' THEN 1 ELSE 0 END) AS transcript_count
    FROM episodes
    WHERE role = 'user'
      AND kind IN ('message', 'transcript')
    GROUP BY lower(trim(content))
  )
  SELECT COUNT(*) AS duplicate_groups,
         SUM(MIN(msg_count, transcript_count)) AS duplicate_pairs
  FROM grouped
  WHERE msg_count > 0 AND transcript_count > 0
`).get() ?? {}

const dryRunSummary = {
  dataDir: DATA_DIR,
  backupDir,
  transcriptEpisodes: transcriptIds.length,
  transcriptPromptLikeEpisodes: promptLikeCount(previewDb),
  transcriptFacts: countBySource(previewDb, 'facts', transcriptIds),
  transcriptTasks: countBySource(previewDb, 'tasks', transcriptIds),
  transcriptSignals: countBySource(previewDb, 'signals', transcriptIds),
  transcriptPropositions: countBySource(previewDb, 'propositions', transcriptIds),
  transcriptProfiles: countBySource(previewDb, 'profiles', transcriptIds),
  transcriptEntities: countBySource(previewDb, 'entities', transcriptIds),
  transcriptRelations: countBySource(previewDb, 'relations', transcriptIds),
  duplicateGroups: Number(duplicateSummary.duplicate_groups ?? 0),
  duplicatePairs: Number(duplicateSummary.duplicate_pairs ?? 0),
}

logJson('dry-run-summary', dryRunSummary)
previewDb.close()

if (!APPLY) {
  process.stdout.write('\nRun with --apply to backup DB and remove transcript-derived memory.\n')
  process.exit(0)
}

mkdirSync(backupDir, { recursive: true })
cpSync(DB_PATH, join(backupDir, 'memory.sqlite'))
if (existsSync(WAL_PATH)) cpSync(WAL_PATH, join(backupDir, 'memory.sqlite-wal'))
if (existsSync(SHM_PATH)) cpSync(SHM_PATH, join(backupDir, 'memory.sqlite-shm'))

const store = getMemoryStore(DATA_DIR)
const db = store.db

db.exec('BEGIN')
try {
  if (transcriptIds.length > 0) {
    const placeholders = transcriptIds.map(() => '?').join(', ')

    const factIds = db.prepare(`SELECT id FROM facts WHERE source_episode_id IN (${placeholders})`).all(...transcriptIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (factIds.length > 0) {
      const ids = factIds.map(() => '?').join(', ')
      db.prepare(`DELETE FROM facts_fts WHERE rowid IN (${ids})`).run(...factIds)
      db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'fact' AND entity_id IN (${ids})`).run(...factIds)
      db.prepare(`DELETE FROM facts WHERE id IN (${ids})`).run(...factIds)
    }

    const taskIds = db.prepare(`SELECT id FROM tasks WHERE source_episode_id IN (${placeholders})`).all(...transcriptIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (taskIds.length > 0) {
      const ids = taskIds.map(() => '?').join(', ')
      db.prepare(`DELETE FROM tasks_fts WHERE rowid IN (${ids})`).run(...taskIds)
      db.prepare(`DELETE FROM task_events WHERE task_id IN (${ids})`).run(...taskIds)
      db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'task' AND entity_id IN (${ids})`).run(...taskIds)
      db.prepare(`DELETE FROM tasks WHERE id IN (${ids})`).run(...taskIds)
    }

    const signalIds = db.prepare(`SELECT id FROM signals WHERE source_episode_id IN (${placeholders})`).all(...transcriptIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (signalIds.length > 0) {
      const ids = signalIds.map(() => '?').join(', ')
      db.prepare(`DELETE FROM signals_fts WHERE rowid IN (${ids})`).run(...signalIds)
      db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'signal' AND entity_id IN (${ids})`).run(...signalIds)
      db.prepare(`DELETE FROM signals WHERE id IN (${ids})`).run(...signalIds)
    }

    const propositionIds = db.prepare(`SELECT id FROM propositions WHERE source_episode_id IN (${placeholders})`).all(...transcriptIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (propositionIds.length > 0) {
      const ids = propositionIds.map(() => '?').join(', ')
      db.prepare(`DELETE FROM propositions_fts WHERE rowid IN (${ids})`).run(...propositionIds)
      db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'proposition' AND entity_id IN (${ids})`).run(...propositionIds)
      db.prepare(`DELETE FROM propositions WHERE id IN (${ids})`).run(...propositionIds)
    }

    const entityIds = db.prepare(`SELECT id FROM entities WHERE source_episode_id IN (${placeholders})`).all(...transcriptIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (entityIds.length > 0) {
      const ids = entityIds.map(() => '?').join(', ')
      db.prepare(`
        DELETE FROM relations
        WHERE source_entity_id IN (${ids})
           OR target_entity_id IN (${ids})
      `).run(...entityIds, ...entityIds)
      db.prepare(`DELETE FROM entities WHERE id IN (${ids})`).run(...entityIds)
    }

    db.prepare(`DELETE FROM relations WHERE source_episode_id IN (${placeholders})`).run(...transcriptIds)
    db.prepare(`DELETE FROM profiles WHERE source_episode_id IN (${placeholders})`).run(...transcriptIds)
    db.prepare(`DELETE FROM entity_links`).run()
    db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'episode' AND entity_id IN (${placeholders})`).run(...transcriptIds)
    db.prepare(`DELETE FROM pending_embeds WHERE entity_type = 'episode' AND entity_id IN (${placeholders})`).run(...transcriptIds)
    db.prepare(`DELETE FROM episodes_fts WHERE rowid IN (${placeholders})`).run(...transcriptIds)
    db.prepare(`DELETE FROM episodes WHERE id IN (${placeholders})`).run(...transcriptIds)
  }

  store.clearCandidatesStmt.run()
  store.rebuildCandidates()
  store.rebuildDerivedIndexes()
  store.rebuildEntityLinks()

  const vectorRows = db.prepare(`
    SELECT entity_type, entity_id, vector_json
    FROM memory_vectors
    ORDER BY entity_type, entity_id
  `).all()
  if (store.vecEnabled) {
    try { db.exec('DELETE FROM vec_memory') } catch {}
    for (const row of vectorRows) {
      try {
        store._syncToVecTable(row.entity_type, row.entity_id, JSON.parse(row.vector_json))
      } catch {}
    }
  }

  store.writeContextFile()
  store.syncEmbeddingMetadata({ reason: 'cleanup_transcript_memory' })
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}

const after = {
  episodes: store.countEpisodes(),
  transcriptEpisodes: Number(db.prepare(`SELECT count(*) AS n FROM episodes WHERE kind = 'transcript'`).get()?.n ?? 0),
  facts: Number(db.prepare(`SELECT count(*) AS n FROM facts`).get()?.n ?? 0),
  tasks: Number(db.prepare(`SELECT count(*) AS n FROM tasks`).get()?.n ?? 0),
  signals: Number(db.prepare(`SELECT count(*) AS n FROM signals`).get()?.n ?? 0),
  propositions: Number(db.prepare(`SELECT count(*) AS n FROM propositions`).get()?.n ?? 0),
  profiles: Number(db.prepare(`SELECT count(*) AS n FROM profiles`).get()?.n ?? 0),
  pendingCandidates: store.countPendingCandidates(),
}

logJson('after-cleanup', after)
