#!/usr/bin/env node

import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding, getEmbeddingDims, getEmbeddingModelId, warmupEmbeddingProvider } from '../lib/embedding-provider.mjs'
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

await warmupEmbeddingProvider()
process.env.CLAUDE2BOT_FORCE_VEC_DIMS = String(getEmbeddingDims())

const store = getMemoryStore(DATA_DIR)

process.stdout.write(`target_model=${getEmbeddingModelId()}\n`)
process.stdout.write(`target_dims=${getEmbeddingDims()}\n`)
process.stdout.write(`stored_vector_model=${store.getMetaValue('embedding.vector_model', '')}\n`)
process.stdout.write(`stored_vector_dims=${store.getMetaValue('embedding.vector_dims', '')}\n`)

const updated = await store.ensureEmbeddings({ all: true })
store.writeContextFile()
store.syncEmbeddingMetadata({ reason: 'rebuild_memory_embeddings' })

process.stdout.write(`updated_vectors=${updated}\n`)
