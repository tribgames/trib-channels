#!/usr/bin/env node

import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding, getEmbeddingDims, warmupEmbeddingProvider } from '../lib/embedding-provider.mjs'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'claude2bot-claude2bot')
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const CASES_PATH = process.env.CLAUDE2BOT_REGRESSION_CASES || join(SCRIPT_DIR, 'data', 'memory-regression-cases.json')

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

const cases = JSON.parse(readFileSync(CASES_PATH, 'utf8'))
const store = getMemoryStore(DATA_DIR)

function normalize(text) {
  return String(text ?? '').toLowerCase()
}

let intentPass = 0
let hitAt5 = 0
let reciprocalRankSum = 0

for (const testCase of cases) {
  const intent = await store.classifyQueryIntent(testCase.query)
  const results = await store.searchRelevantHybrid(testCase.query, 5, { intent })

  const intentMatched = intent.primary === testCase.expectedIntent
  if (intentMatched) intentPass += 1

  const firstMatchIndex = results.findIndex(item => {
    const content = normalize(item.content)
    return (testCase.expectedAny || []).some(expected => content.includes(normalize(expected)))
  })

  const hit = firstMatchIndex >= 0
  if (hit) {
    hitAt5 += 1
    reciprocalRankSum += 1 / (firstMatchIndex + 1)
  }

  process.stdout.write(`\n[${testCase.id}]\n`)
  process.stdout.write(`query: ${testCase.query}\n`)
  process.stdout.write(`intent: ${intent.primary} ${intentMatched ? 'PASS' : `FAIL(expected ${testCase.expectedIntent})`}\n`)
  process.stdout.write(`hit@5: ${hit ? 'PASS' : 'FAIL'}\n`)
  results.forEach((item, index) => {
    process.stdout.write(`${index + 1}. [${item.type}:${item.subtype}] ${String(item.content).slice(0, 160)}\n`)
  })
}

const total = cases.length || 1
process.stdout.write('\n=== summary ===\n')
process.stdout.write(`intent_accuracy=${(intentPass / total).toFixed(3)} (${intentPass}/${total})\n`)
process.stdout.write(`hit_at_5=${(hitAt5 / total).toFixed(3)} (${hitAt5}/${total})\n`)
process.stdout.write(`mrr_at_5=${(reciprocalRankSum / total).toFixed(3)}\n`)
