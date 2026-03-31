#!/usr/bin/env node

import { readFileSync, cpSync, mkdirSync, existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding, getEmbeddingDims, warmupEmbeddingProvider } from '../lib/embedding-provider.mjs'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'claude2bot-claude2bot')
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const CASES_PATH = join(SCRIPT_DIR, 'data', 'memory-smoke-cases.json')

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

const COPY_DIR = join(tmpdir(), `claude2bot-memory-smoke-${process.pid}-${Date.now()}`)
mkdirSync(COPY_DIR, { recursive: true })
cpSync(join(DATA_DIR, 'config.json'), join(COPY_DIR, 'config.json'))
cpSync(join(DATA_DIR, 'memory.sqlite'), join(COPY_DIR, 'memory.sqlite'))
if (existsSync(join(DATA_DIR, 'memory.sqlite-wal'))) {
  cpSync(join(DATA_DIR, 'memory.sqlite-wal'), join(COPY_DIR, 'memory.sqlite-wal'))
}
if (existsSync(join(DATA_DIR, 'memory.sqlite-shm'))) {
  cpSync(join(DATA_DIR, 'memory.sqlite-shm'), join(COPY_DIR, 'memory.sqlite-shm'))
}

const store = getMemoryStore(COPY_DIR)
const cases = JSON.parse(readFileSync(CASES_PATH, 'utf8'))

function normalize(text) {
  return String(text ?? '').toLowerCase()
}

let intentPass = 0
let hitAt5 = 0
let hitAt1 = 0
let reciprocalRankSum = 0
let failures = 0

process.stdout.write(`[smoke] targetDir=${DATA_DIR}\n`)
process.stdout.write(`[smoke] copyDir=${COPY_DIR}\n`)
process.stdout.write(`[smoke] queries=${cases.length}\n`)

for (const testCase of cases) {
  const intent = await store.classifyQueryIntent(testCase.query)
  const results = await store.searchRelevantHybrid(testCase.query, 5, { intent })

  const acceptableIntents = new Set(testCase.acceptableIntents || [])
  const intentMatched = acceptableIntents.size === 0 || acceptableIntents.has(intent.primary)
  if (intentMatched) intentPass += 1

  const top1Matched = results.length > 0 && (testCase.expectedTop1Any || testCase.expectedAny || []).some(expected =>
    normalize(results[0]?.content).includes(normalize(expected)),
  )
  const firstMatchIndex = results.findIndex(item => {
    const content = normalize(item.content)
    return (testCase.expectedAny || []).some(expected => content.includes(normalize(expected)))
  })

  const hit = firstMatchIndex >= 0
  if (hit) {
    hitAt5 += 1
    reciprocalRankSum += 1 / (firstMatchIndex + 1)
  }
  if (top1Matched) hitAt1 += 1
  if (!intentMatched || !hit || (Array.isArray(testCase.expectedTop1Any) && !top1Matched)) failures += 1

  process.stdout.write(`\n[${testCase.id}]\n`)
  process.stdout.write(`query: ${testCase.query}\n`)
  process.stdout.write(`intent: ${intent.primary} ${intentMatched ? 'PASS' : 'FAIL'}\n`)
  process.stdout.write(`hit@1: ${top1Matched ? 'PASS' : 'FAIL'}\n`)
  process.stdout.write(`hit@5: ${hit ? 'PASS' : 'FAIL'}\n`)
  results.forEach((item, index) => {
    process.stdout.write(`${index + 1}. [${item.type}:${item.subtype}] ${String(item.content).slice(0, 180)}\n`)
  })
}

const total = cases.length || 1
process.stdout.write('\n=== summary ===\n')
process.stdout.write(`intent_accuracy=${(intentPass / total).toFixed(3)} (${intentPass}/${total})\n`)
process.stdout.write(`hit_at_1=${(hitAt1 / total).toFixed(3)} (${hitAt1}/${total})\n`)
process.stdout.write(`hit_at_5=${(hitAt5 / total).toFixed(3)} (${hitAt5}/${total})\n`)
process.stdout.write(`mrr_at_5=${(reciprocalRankSum / total).toFixed(3)}\n`)
if (failures > 0) {
  process.exitCode = 1
}
