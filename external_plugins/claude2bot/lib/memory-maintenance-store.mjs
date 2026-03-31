import { getEmbeddingDims } from './embedding-provider.mjs'
import { cleanMemoryText } from './memory-extraction.mjs'
import { insertCandidateUnits } from './memory-text-utils.mjs'

export function getEpisodesSince(store, timestamp) {
  const ts = typeof timestamp === 'number'
    ? new Date(timestamp).toISOString()
    : String(timestamp)
  return store.db.prepare(`
    SELECT id, ts, role, kind, content
    FROM episodes
    WHERE ts > ?
    ORDER BY ts, id
  `).all(ts)
}

export function countEpisodes(store) {
  return store.db.prepare(`SELECT count(*) AS n FROM episodes`).get().n
}

export function getCandidatesForDate(store, dayKey) {
  return store.db.prepare(`
    SELECT mc.id, mc.episode_id, mc.ts, mc.role, mc.content, mc.score
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE mc.day_key = ?
      AND mc.status = 'pending'
      AND e.role IN ('user', 'assistant')
      AND e.kind = 'message'
    ORDER BY mc.score DESC, mc.ts ASC
  `).all(dayKey)
}

export function getPendingCandidateDays(store, limit = 7, minCount = 1) {
  return store.db.prepare(`
    SELECT mc.day_key, count(*) AS n
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE mc.status = 'pending'
      AND e.role IN ('user', 'assistant')
      AND e.kind = 'message'
    GROUP BY mc.day_key
    HAVING count(*) >= ?
    ORDER BY mc.day_key DESC
    LIMIT ?
  `).all(minCount, limit)
}

export function getDecayRows(store, kind = 'fact') {
  if (kind === 'fact') {
    return store.db.prepare(`
      SELECT id, mention_count, retrieval_count, last_seen, first_seen
      FROM facts
      WHERE status = 'active'
    `).all()
  }
  if (kind === 'task') {
    return store.db.prepare(`
      SELECT id, retrieval_count, last_seen, first_seen
      FROM tasks
      WHERE status = 'active'
    `).all()
  }
  if (kind === 'signal') {
    return store.db.prepare(`
      SELECT id, retrieval_count, last_seen, first_seen
      FROM signals
      WHERE status = 'active'
    `).all()
  }
  return []
}

export function markRowsDeprecated(store, kind = 'fact', ids = [], seenAt = null) {
  const normalizedIds = [...new Set(ids.map(id => Number(id)).filter(Number.isFinite))]
  if (normalizedIds.length === 0 || !seenAt) return 0
  const placeholders = normalizedIds.map(() => '?').join(', ')
  if (kind === 'fact') {
    return Number(store.db.prepare(`
      UPDATE facts
      SET status = 'deprecated', last_seen = ?
      WHERE id IN (${placeholders})
    `).run(seenAt, ...normalizedIds).changes ?? 0)
  }
  if (kind === 'task') {
    return Number(store.db.prepare(`
      UPDATE tasks
      SET status = 'deprecated', last_seen = ?
      WHERE id IN (${placeholders})
    `).run(seenAt, ...normalizedIds).changes ?? 0)
  }
  if (kind === 'signal') {
    return Number(store.db.prepare(`
      UPDATE signals
      SET status = 'deprecated', last_seen = ?
      WHERE id IN (${placeholders})
    `).run(seenAt, ...normalizedIds).changes ?? 0)
  }
  return 0
}

export function listDeprecatedIds(store, kind = 'fact', olderThan = '') {
  if (!olderThan) return []
  if (kind === 'fact') {
    return store.db.prepare(`
      SELECT id
      FROM facts
      WHERE status = 'deprecated' AND last_seen < ?
    `).all(olderThan).map(row => Number(row.id)).filter(Number.isFinite)
  }
  if (kind === 'task') {
    return store.db.prepare(`
      SELECT id
      FROM tasks
      WHERE status = 'deprecated' AND last_seen < ?
    `).all(olderThan).map(row => Number(row.id)).filter(Number.isFinite)
  }
  if (kind === 'signal') {
    return store.db.prepare(`
      SELECT id
      FROM signals
      WHERE status = 'deprecated' AND last_seen < ?
    `).all(olderThan).map(row => Number(row.id)).filter(Number.isFinite)
  }
  return []
}

export function deleteRowsByIds(store, kind = 'fact', ids = []) {
  const normalizedIds = [...new Set(ids.map(id => Number(id)).filter(Number.isFinite))]
  if (normalizedIds.length === 0) return 0
  const placeholders = normalizedIds.map(() => '?').join(', ')
  if (kind === 'fact') {
    for (const id of normalizedIds) store.deleteFactFtsStmt.run(id)
    store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'fact' AND entity_id IN (${placeholders})`).run(...normalizedIds)
    if (store.vecEnabled) {
      for (const id of normalizedIds) {
        const rowid = store._vecRowId('fact', id)
        try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
      }
    }
    return Number(store.db.prepare(`DELETE FROM facts WHERE id IN (${placeholders})`).run(...normalizedIds).changes ?? 0)
  }
  if (kind === 'task') {
    for (const id of normalizedIds) store.deleteTaskFtsStmt.run(id)
    store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'task' AND entity_id IN (${placeholders})`).run(...normalizedIds)
    if (store.vecEnabled) {
      for (const id of normalizedIds) {
        const rowid = store._vecRowId('task', id)
        try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
      }
    }
    store.db.prepare(`DELETE FROM task_events WHERE task_id IN (${placeholders})`).run(...normalizedIds)
    return Number(store.db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...normalizedIds).changes ?? 0)
  }
  if (kind === 'signal') {
    for (const id of normalizedIds) store.deleteSignalFtsStmt.run(id)
    store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'signal' AND entity_id IN (${placeholders})`).run(...normalizedIds)
    if (store.vecEnabled) {
      for (const id of normalizedIds) {
        const rowid = store._vecRowId('signal', id)
        try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
      }
    }
    return Number(store.db.prepare(`DELETE FROM signals WHERE id IN (${placeholders})`).run(...normalizedIds).changes ?? 0)
  }
  return 0
}

export function resetEmbeddingIndex(store, options = {}) {
  store.clearVectorsStmt.run()
  try { store.db.prepare('DELETE FROM pending_embeds').run() } catch {}
  if (store.vecEnabled) {
    try {
      store.db.exec('DROP TABLE IF EXISTS vec_memory')
      store.db.exec(`CREATE VIRTUAL TABLE vec_memory USING vec0(embedding float[${getEmbeddingDims()}])`)
    } catch {}
  }
  store.syncEmbeddingMetadata({
    reason: options.reason ?? 'reset_embedding_index',
    reindexRequired: 1,
    reindexReason: options.reindexReason ?? 'embedding index reset',
  })
}

export function vacuumDatabase(store) {
  try {
    store.db.exec('VACUUM')
    return true
  } catch {
    return false
  }
}

export function getRecentCandidateDays(store, limit = 7) {
  return store.db.prepare(`
    SELECT mc.day_key, count(*) AS n
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE e.role = 'user'
      AND e.kind = 'message'
    GROUP BY mc.day_key
    ORDER BY mc.day_key DESC
    LIMIT ?
  `).all(limit)
}

export function countPendingCandidates(store, dayKey = null) {
  if (dayKey) {
    return store.db.prepare(`
      SELECT count(*) AS n
      FROM memory_candidates mc
      JOIN episodes e ON e.id = mc.episode_id
      WHERE mc.status = 'pending'
        AND mc.day_key = ?
        AND e.role = 'user'
        AND e.kind = 'message'
    `).get(dayKey).n
  }
  return store.db.prepare(`
    SELECT count(*) AS n
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE mc.status = 'pending'
      AND e.role = 'user'
      AND e.kind = 'message'
  `).get().n
}

export function rebuildCandidates(store) {
  store.clearCandidatesStmt.run()
  const rows = store.db.prepare(`
    SELECT id, ts, day_key, role, kind, content
    FROM episodes
    ORDER BY ts, id
  `).all()
  let created = 0
  for (const row of rows) {
    const clean = cleanMemoryText(row.content)
    if (!clean) continue
    const shouldCandidate = row.role === 'user' && row.kind === 'message'
    if (shouldCandidate) {
      created += insertCandidateUnits(store.insertCandidateStmt, row.id, row.ts, row.day_key, row.role, clean)
    }
  }
  return created
}

export function resetConsolidatedMemory(store) {
  store.clearFactsStmt.run()
  store.clearTasksStmt.run()
  store.clearSignalsStmt.run()
  store.clearPropositionsStmt.run()
  store.clearFactsFtsStmt.run()
  store.clearTasksFtsStmt.run()
  store.clearSignalsFtsStmt.run()
  store.clearPropositionsFtsStmt.run()
  store.clearVectorsStmt.run()
  if (store.vecEnabled) {
    try { store.db.exec('DELETE FROM vec_memory') } catch {}
  }
  store.db.prepare(`UPDATE memory_candidates SET status = 'pending'`).run()
}

export function resetConsolidatedMemoryForDays(store, dayKeys = []) {
  const keys = [...new Set(dayKeys.map(key => String(key).trim()).filter(Boolean))]
  if (keys.length === 0) return

  const placeholders = keys.map(() => '?').join(', ')
  const episodeIds = store.db.prepare(`
    SELECT id
    FROM episodes
    WHERE day_key IN (${placeholders})
  `).all(...keys).map(row => Number(row.id)).filter(Number.isFinite)

  if (episodeIds.length > 0) {
    const episodePlaceholders = episodeIds.map(() => '?').join(', ')

    const factIds = store.db.prepare(`
      SELECT id FROM facts WHERE source_episode_id IN (${episodePlaceholders})
    `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (factIds.length > 0) {
      const factPlaceholders = factIds.map(() => '?').join(', ')
      for (const id of factIds) store.deleteFactFtsStmt.run(id)
      store.db.prepare(`DELETE FROM facts WHERE id IN (${factPlaceholders})`).run(...factIds)
      store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'fact' AND entity_id IN (${factPlaceholders})`).run(...factIds)
      if (store.vecEnabled) {
        for (const id of factIds) {
          const rowid = store._vecRowId('fact', id)
          try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
        }
      }
    }

    const taskIds = store.db.prepare(`
      SELECT id FROM tasks WHERE source_episode_id IN (${episodePlaceholders})
    `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (taskIds.length > 0) {
      const taskPlaceholders = taskIds.map(() => '?').join(', ')
      for (const id of taskIds) store.deleteTaskFtsStmt.run(id)
      store.db.prepare(`DELETE FROM tasks WHERE id IN (${taskPlaceholders})`).run(...taskIds)
      store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'task' AND entity_id IN (${taskPlaceholders})`).run(...taskIds)
      if (store.vecEnabled) {
        for (const id of taskIds) {
          const rowid = store._vecRowId('task', id)
          try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
        }
      }
    }

    const signalIds = store.db.prepare(`
      SELECT id FROM signals WHERE source_episode_id IN (${episodePlaceholders})
    `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (signalIds.length > 0) {
      const signalPlaceholders = signalIds.map(() => '?').join(', ')
      for (const id of signalIds) store.deleteSignalFtsStmt.run(id)
      store.db.prepare(`DELETE FROM signals WHERE id IN (${signalPlaceholders})`).run(...signalIds)
      store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'signal' AND entity_id IN (${signalPlaceholders})`).run(...signalIds)
      if (store.vecEnabled) {
        for (const id of signalIds) {
          const rowid = store._vecRowId('signal', id)
          try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
        }
      }
    }

    const propositionIds = store.db.prepare(`
      SELECT id FROM propositions WHERE source_episode_id IN (${episodePlaceholders})
    `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (propositionIds.length > 0) {
      const propositionPlaceholders = propositionIds.map(() => '?').join(', ')
      for (const id of propositionIds) store.deletePropositionFtsStmt.run(id)
      store.db.prepare(`DELETE FROM propositions WHERE id IN (${propositionPlaceholders})`).run(...propositionIds)
      store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'proposition' AND entity_id IN (${propositionPlaceholders})`).run(...propositionIds)
      if (store.vecEnabled) {
        for (const id of propositionIds) {
          const rowid = store._vecRowId('proposition', id)
          try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
        }
      }
    }

    // Clean up orphaned entity_links, entities, and relations
    store.db.prepare(`DELETE FROM entity_links WHERE episode_id IN (${episodePlaceholders})`).run(...episodeIds)
    store.db.prepare(`DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_links)`).run()
    store.db.prepare(`DELETE FROM relations WHERE source_entity_id NOT IN (SELECT id FROM entities) OR target_entity_id NOT IN (SELECT id FROM entities)`).run()
  }

  store.db.prepare(`
    UPDATE memory_candidates
    SET status = 'pending'
    WHERE day_key IN (${placeholders})
  `).run(...keys)
}

export function pruneConsolidatedMemoryOutsideDays(store, dayKeys = []) {
  const keys = [...new Set(dayKeys.map(key => String(key).trim()).filter(Boolean))]
  if (keys.length === 0) return

  const placeholders = keys.map(() => '?').join(', ')
  const keepEpisodeIds = store.db.prepare(`
    SELECT id
    FROM episodes
    WHERE day_key IN (${placeholders})
  `).all(...keys).map(row => Number(row.id)).filter(Number.isFinite)

  if (keepEpisodeIds.length === 0) return
  const keepPlaceholders = keepEpisodeIds.map(() => '?').join(', ')

  const staleFactIds = store.db.prepare(`
    SELECT id FROM facts
    WHERE source_episode_id IS NOT NULL
      AND source_episode_id NOT IN (${keepPlaceholders})
  `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
  if (staleFactIds.length > 0) {
    const staleFactPlaceholders = staleFactIds.map(() => '?').join(', ')
    for (const id of staleFactIds) store.deleteFactFtsStmt.run(id)
    store.db.prepare(`DELETE FROM facts WHERE id IN (${staleFactPlaceholders})`).run(...staleFactIds)
    store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'fact' AND entity_id IN (${staleFactPlaceholders})`).run(...staleFactIds)
    if (store.vecEnabled) {
      for (const id of staleFactIds) {
        const rowid = store._vecRowId('fact', id)
        try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
      }
    }
  }

  const staleTaskIds = store.db.prepare(`
    SELECT id FROM tasks
    WHERE source_episode_id IS NOT NULL
      AND source_episode_id NOT IN (${keepPlaceholders})
  `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
  if (staleTaskIds.length > 0) {
    const staleTaskPlaceholders = staleTaskIds.map(() => '?').join(', ')
    for (const id of staleTaskIds) store.deleteTaskFtsStmt.run(id)
    store.db.prepare(`DELETE FROM tasks WHERE id IN (${staleTaskPlaceholders})`).run(...staleTaskIds)
    store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'task' AND entity_id IN (${staleTaskPlaceholders})`).run(...staleTaskIds)
    if (store.vecEnabled) {
      for (const id of staleTaskIds) {
        const rowid = store._vecRowId('task', id)
        try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
      }
    }
  }

  const staleSignalIds = store.db.prepare(`
    SELECT id FROM signals
    WHERE source_episode_id IS NOT NULL
      AND source_episode_id NOT IN (${keepPlaceholders})
  `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
  if (staleSignalIds.length > 0) {
    const staleSignalPlaceholders = staleSignalIds.map(() => '?').join(', ')
    for (const id of staleSignalIds) store.deleteSignalFtsStmt.run(id)
    store.db.prepare(`DELETE FROM signals WHERE id IN (${staleSignalPlaceholders})`).run(...staleSignalIds)
    store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'signal' AND entity_id IN (${staleSignalPlaceholders})`).run(...staleSignalIds)
    if (store.vecEnabled) {
      for (const id of staleSignalIds) {
        const rowid = store._vecRowId('signal', id)
        try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
      }
    }
  }

  const stalePropositionIds = store.db.prepare(`
    SELECT id FROM propositions
    WHERE source_episode_id IS NOT NULL
      AND source_episode_id NOT IN (${keepPlaceholders})
  `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
  if (stalePropositionIds.length > 0) {
    const stalePropositionPlaceholders = stalePropositionIds.map(() => '?').join(', ')
    for (const id of stalePropositionIds) store.deletePropositionFtsStmt.run(id)
    store.db.prepare(`DELETE FROM propositions WHERE id IN (${stalePropositionPlaceholders})`).run(...stalePropositionIds)
    store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'proposition' AND entity_id IN (${stalePropositionPlaceholders})`).run(...stalePropositionIds)
    if (store.vecEnabled) {
      for (const id of stalePropositionIds) {
        const rowid = store._vecRowId('proposition', id)
        try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
      }
    }
  }

  // Clean up orphaned entity_links, entities, and relations
  store.db.prepare(`
    DELETE FROM entity_links
    WHERE episode_id IS NOT NULL
      AND episode_id NOT IN (${keepPlaceholders})
  `).run(...keepEpisodeIds)
  store.db.prepare(`DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_links)`).run()
  store.db.prepare(`DELETE FROM relations WHERE source_entity_id NOT IN (SELECT id FROM entities) OR target_entity_id NOT IN (SELECT id FROM entities)`).run()

  store.db.prepare(`
    DELETE FROM profiles
    WHERE source_episode_id IS NOT NULL
      AND source_episode_id NOT IN (${keepPlaceholders})
  `).run(...keepEpisodeIds)
}

export function markCandidateIdsConsolidated(store, candidateIds = []) {
  const ids = [...new Set(candidateIds.map(id => Number(id)).filter(Number.isFinite))]
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const stmt = store.db.prepare(`
    UPDATE memory_candidates
    SET status = 'consolidated'
    WHERE status = 'pending'
      AND id IN (${placeholders})
  `)
  const result = stmt.run(...ids)
  return Number(result.changes ?? 0)
}

export function markCandidatesConsolidated(store, dayKey) {
  return Number(store.db.prepare(`
    UPDATE memory_candidates
    SET status = 'consolidated'
    WHERE day_key = ? AND status = 'pending'
  `).run(dayKey).changes ?? 0)
}
