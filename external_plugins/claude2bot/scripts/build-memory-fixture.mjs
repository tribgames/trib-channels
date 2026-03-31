#!/usr/bin/env node

import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding, getEmbeddingDims, warmupEmbeddingProvider } from '../lib/embedding-provider.mjs'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_CORPUS_PATH = join(SCRIPT_DIR, 'data', 'memory-fixture-corpus.json')
const DEFAULT_TARGET_DIR = process.env.CLAUDE2BOT_FIXTURE_DIR || join(tmpdir(), `claude2bot-memory-fixture-${process.pid}-${Date.now()}`)

export async function buildMemoryFixture(options = {}) {
  const corpusPath = options.corpusPath || DEFAULT_CORPUS_PATH
  const targetDir = options.targetDir || DEFAULT_TARGET_DIR
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))

  configureEmbedding({ provider: 'local' })
  await warmupEmbeddingProvider()
  process.env.CLAUDE2BOT_FORCE_VEC_DIMS = String(getEmbeddingDims())

  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(join(targetDir, 'history'), { recursive: true })
  writeFileSync(join(targetDir, 'config.json'), JSON.stringify({ embedding: { provider: 'local' } }, null, 2) + '\n', 'utf8')

  const store = getMemoryStore(targetDir)
  const base = new Date()
  base.setHours(12, 0, 0, 0)

  const timestamp = (dayOffset = 0, minuteOffset = 0) => {
    const ts = new Date(base)
    ts.setDate(ts.getDate() + Number(dayOffset))
    ts.setMinutes(ts.getMinutes() + Number(minuteOffset))
    return ts.toISOString()
  }

  const episodeIdByKey = new Map()
  for (const episode of corpus.episodes || []) {
    const id = store.appendEpisode({
      ts: timestamp(episode.dayOffset, episode.minuteOffset),
      backend: episode.backend || 'discord',
      channelId: episode.backend === 'discord' ? 'fixture-channel' : null,
      userId: episode.role === 'user' ? 'fixture-user' : 'fixture-assistant',
      userName: episode.role,
      sessionId: episode.backend === 'claude-session' ? 'fixture-session' : null,
      role: episode.role,
      kind: episode.kind,
      content: episode.content,
      sourceRef: `fixture:${episode.key}`,
    })
    if (episode.key) episodeIdByKey.set(episode.key, id)
  }

  const nowIso = timestamp(0, 120)
  store.upsertProfiles(corpus.profiles || [], nowIso, episodeIdByKey.get('policy_commit') ?? null)

  for (const item of corpus.entities || []) {
    store.upsertEntities([item], nowIso, episodeIdByKey.get(item.source) ?? null)
  }

  for (const item of corpus.facts || []) {
    const sourceEpisodeId = episodeIdByKey.get(item.source) ?? null
    if (!sourceEpisodeId) continue
    await store.upsertFacts([item], nowIso, sourceEpisodeId)
  }

  for (const item of corpus.tasks || []) {
    store.upsertTasks([item], nowIso, episodeIdByKey.get(item.source) ?? null)
  }

  for (const item of corpus.signals || []) {
    store.upsertSignals([item], episodeIdByKey.get(item.source) ?? null, nowIso)
  }

  for (const item of corpus.relations || []) {
    store.upsertRelations([item], nowIso, episodeIdByKey.get(item.source_episode ?? item.source) ?? null)
  }

  store.rebuildEntityLinks()
  await store.ensureEmbeddings({ all: true })
  store.writeContextFile()
  store.syncEmbeddingMetadata({ reason: 'build_fixture' })

  return {
    targetDir,
    baseDate: timestamp(0, 0).slice(0, 10),
    facts: store.db.prepare(`SELECT count(*) AS n FROM facts`).get().n,
    tasks: store.db.prepare(`SELECT count(*) AS n FROM tasks`).get().n,
    signals: store.db.prepare(`SELECT count(*) AS n FROM signals`).get().n,
    profiles: store.db.prepare(`SELECT count(*) AS n FROM profiles`).get().n,
    episodes: store.db.prepare(`SELECT count(*) AS n FROM episodes`).get().n,
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirectRun) {
  const summary = await buildMemoryFixture()
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}
