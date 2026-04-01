#!/usr/bin/env node

import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding } from '../lib/embedding-provider.mjs'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'trib-channels-trib-channels')
const APPLY = process.argv.includes('--apply')

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

function shouldKeepProfileValue(key, value) {
  const clean = String(value ?? '').trim()
  if (!key || !clean) return false
  if (key === 'timezone') return clean.length <= 64
  if (clean.length > 160) return false
  if (clean.length > 48 && /\b(?:on|as of)\s+\d{4}-\d{2}-\d{2}\b/i.test(clean)) return false
  if (clean.length > 48 && /\b(requested|asked|stated|reported|mentioned|clarified)\b/i.test(clean)) return false
  if (clean.length > 48 && /(요청|지시|말씀|언급|보고|설명)/.test(clean)) return false
  return true
}

function logJson(label, payload) {
  process.stdout.write(`\n[${label}]\n${JSON.stringify(payload, null, 2)}\n`)
}

const store = getMemoryStore(DATA_DIR)
const db = store.db

const nonMessageEpisodeIds = db.prepare(`
  SELECT id
  FROM episodes
  WHERE role = 'user'
    AND kind != 'message'
`).all().map(row => Number(row.id)).filter(Number.isFinite)

const invalidProfiles = db.prepare(`
  SELECT key, value
  FROM profiles
  WHERE status = 'active'
`).all().filter(row => !shouldKeepProfileValue(row.key, row.value))

const summary = {
  nonMessageEpisodes: nonMessageEpisodeIds.length,
  factsFromNonMessageEpisodes: nonMessageEpisodeIds.length
    ? db.prepare(`SELECT count(*) AS n FROM facts WHERE source_episode_id IN (${nonMessageEpisodeIds.map(() => '?').join(',')})`).get(...nonMessageEpisodeIds).n
    : 0,
  tasksFromNonMessageEpisodes: nonMessageEpisodeIds.length
    ? db.prepare(`SELECT count(*) AS n FROM tasks WHERE source_episode_id IN (${nonMessageEpisodeIds.map(() => '?').join(',')})`).get(...nonMessageEpisodeIds).n
    : 0,
  signalsFromNonMessageEpisodes: nonMessageEpisodeIds.length
    ? db.prepare(`SELECT count(*) AS n FROM signals WHERE source_episode_id IN (${nonMessageEpisodeIds.map(() => '?').join(',')})`).get(...nonMessageEpisodeIds).n
    : 0,
  entitiesFromNonMessageEpisodes: nonMessageEpisodeIds.length
    ? db.prepare(`SELECT count(*) AS n FROM entities WHERE source_episode_id IN (${nonMessageEpisodeIds.map(() => '?').join(',')})`).get(...nonMessageEpisodeIds).n
    : 0,
  relationsFromNonMessageEpisodes: nonMessageEpisodeIds.length
    ? db.prepare(`SELECT count(*) AS n FROM relations WHERE source_episode_id IN (${nonMessageEpisodeIds.map(() => '?').join(',')})`).get(...nonMessageEpisodeIds).n
    : 0,
  profilesToDrop: invalidProfiles.length,
}

logJson('dry-run-summary', summary)

if (!APPLY) {
  process.stdout.write('\nRun with --apply to execute cleanup.\n')
  process.exit(0)
}

db.exec('BEGIN')
try {
  if (nonMessageEpisodeIds.length > 0) {
    const placeholders = nonMessageEpisodeIds.map(() => '?').join(',')

    const factIds = db.prepare(`SELECT id FROM facts WHERE source_episode_id IN (${placeholders})`).all(...nonMessageEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    const taskIds = db.prepare(`SELECT id FROM tasks WHERE source_episode_id IN (${placeholders})`).all(...nonMessageEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    const signalIds = db.prepare(`SELECT id FROM signals WHERE source_episode_id IN (${placeholders})`).all(...nonMessageEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    const episodeVectorIds = db.prepare(`SELECT id FROM episodes WHERE id IN (${placeholders})`).all(...nonMessageEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)

    if (factIds.length > 0) {
      const factPlaceholders = factIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM facts_fts WHERE rowid IN (${factPlaceholders})`).run(...factIds)
      db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'fact' AND entity_id IN (${factPlaceholders})`).run(...factIds)
      db.prepare(`DELETE FROM facts WHERE id IN (${factPlaceholders})`).run(...factIds)
    }

    if (taskIds.length > 0) {
      const taskPlaceholders = taskIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM tasks_fts WHERE rowid IN (${taskPlaceholders})`).run(...taskIds)
      db.prepare(`DELETE FROM task_events WHERE task_id IN (${taskPlaceholders})`).run(...taskIds)
      db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'task' AND entity_id IN (${taskPlaceholders})`).run(...taskIds)
      db.prepare(`DELETE FROM tasks WHERE id IN (${taskPlaceholders})`).run(...taskIds)
    }

    if (signalIds.length > 0) {
      const signalPlaceholders = signalIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM signals_fts WHERE rowid IN (${signalPlaceholders})`).run(...signalIds)
      db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'signal' AND entity_id IN (${signalPlaceholders})`).run(...signalIds)
      db.prepare(`DELETE FROM signals WHERE id IN (${signalPlaceholders})`).run(...signalIds)
    }

    if (episodeVectorIds.length > 0) {
      const episodePlaceholders = episodeVectorIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'episode' AND entity_id IN (${episodePlaceholders})`).run(...episodeVectorIds)
      db.prepare(`DELETE FROM pending_embeds WHERE entity_type = 'episode' AND entity_id IN (${episodePlaceholders})`).run(...episodeVectorIds)
    }

    const entityIds = db.prepare(`SELECT id FROM entities WHERE source_episode_id IN (${placeholders})`).all(...nonMessageEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    db.prepare(`DELETE FROM relations WHERE source_episode_id IN (${placeholders})`).run(...nonMessageEpisodeIds)
    if (entityIds.length > 0) {
      const entityPlaceholders = entityIds.map(() => '?').join(',')
      db.prepare(`
        DELETE FROM relations
        WHERE source_entity_id IN (${entityPlaceholders})
           OR target_entity_id IN (${entityPlaceholders})
      `).run(...entityIds, ...entityIds)
    }
    db.prepare(`DELETE FROM entities WHERE source_episode_id IN (${placeholders})`).run(...nonMessageEpisodeIds)
    db.prepare(`DELETE FROM profiles WHERE source_episode_id IN (${placeholders})`).run(...nonMessageEpisodeIds)
  }

  if (invalidProfiles.length > 0) {
    for (const profile of invalidProfiles) {
      db.prepare(`DELETE FROM profiles WHERE key = ?`).run(profile.key)
    }
  }

  store.clearCandidatesStmt.run()
  store.rebuildCandidates()
  store.rebuildDerivedIndexes()
  store.writeContextFile()
  store.syncEmbeddingMetadata({ reason: 'repair_memory_corpus' })

  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}

const after = {
  facts: db.prepare(`SELECT count(*) AS n FROM facts`).get().n,
  tasks: db.prepare(`SELECT count(*) AS n FROM tasks`).get().n,
  signals: db.prepare(`SELECT count(*) AS n FROM signals`).get().n,
  profiles: db.prepare(`SELECT count(*) AS n FROM profiles`).get().n,
  pendingCandidates: store.countPendingCandidates(),
}

logJson('after-cleanup', after)
