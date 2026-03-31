#!/usr/bin/env node

import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding, getEmbeddingDims, warmupEmbeddingProvider } from '../lib/embedding-provider.mjs'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'claude2bot-claude2bot')
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

const pairs = [
  ['한국어로 답해야 해?', 'Should the assistant answer in Korean?'],
  ['지금 진행 중인 작업 뭐야', 'What are the current active tasks?'],
  ['커밋 먼저 하면 안 되지?', 'Is commit/push forbidden unless explicitly requested?'],
  ['2026-03-30에 무슨 얘기 했지', 'What did we discuss on 2026-03-30?'],
  ['RAG 구조 약점 뭐였지', 'What were the weaknesses in the RAG structure?'],
]

await warmupEmbeddingProvider()
process.env.CLAUDE2BOT_FORCE_VEC_DIMS = String(getEmbeddingDims())

const store = getMemoryStore(DATA_DIR)

for (const [left, right] of pairs) {
  process.stdout.write('\n=== pair ===\n')
  for (const query of [left, right]) {
    const intent = await store.classifyQueryIntent(query)
    const results = await store.searchRelevantHybrid(query, 5, { intent })
    process.stdout.write(`\nQ: ${query}\n`)
    process.stdout.write(`intent: ${intent.primary}\n`)
    if (!results.length) {
      process.stdout.write('(no results)\n')
      continue
    }
    for (const item of results) {
      process.stdout.write(`- [${item.type}:${item.subtype}] ${String(item.content).slice(0, 180)}\n`)
    }
  }
}

process.stdout.write('\n--- inbound memory-context sample ---\n')
for (const query of ['한국어', '존댓말', 'commit', '작업']) {
  const context = await store.buildInboundMemoryContext(query, { limit: 5 })
  process.stdout.write(`\nQ: ${query}\n${context || '(empty)'}\n`)
}
