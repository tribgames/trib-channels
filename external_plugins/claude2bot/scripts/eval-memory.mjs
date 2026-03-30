#!/usr/bin/env node

import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding } from '../lib/embedding-provider.mjs'
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

const queries = [
  'What is the current SQLite long-term memory structure and its key decisions?',
  'Summarize the top three active tasks right now.',
  'What are the user preferences for language, tone, and response style?',
  'What is the current direction and remaining work for Codex integration?',
  'What architectural decisions are already fixed for webhooks or event automation?',
  'What preferences or rules exist for Discord output formatting?',
  'What constraints or prohibitions matter most in the current system?',
  'What repeated user patterns or work habits show up recently?',
  'Separate durable long-term facts from temporary work in the current memory.',
  'What should the next session resume first?',
]

const store = getMemoryStore(DATA_DIR)

for (const query of queries) {
  const results = await store.searchRelevantHybrid(query, 5)
  process.stdout.write(`\n=== ${query} ===\n`)
  if (results.length === 0) {
    process.stdout.write('(no results)\n')
    continue
  }
  for (const item of results) {
    const source = item.source_ref ? ` (${item.source_ref})` : ''
    process.stdout.write(`- [${item.type}:${item.subtype}] ${String(item.content).slice(0, 180)}${source}\n`)
  }
}

process.stdout.write('\n--- inbound memory-context sample ---\n')
process.stdout.write(await store.buildInboundMemoryContext(queries[0], { limit: 5 }) + '\n')
