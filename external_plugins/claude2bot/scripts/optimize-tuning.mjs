#!/usr/bin/env node

import { readFileSync, cpSync, mkdirSync, existsSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { getMemoryStore } from '../lib/memory.mjs'
import { mergeMemoryTuning } from '../lib/memory-tuning.mjs'
import { configureEmbedding, getEmbeddingDims, warmupEmbeddingProvider } from '../lib/embedding-provider.mjs'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'claude2bot-claude2bot')
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const CASES_PATH = join(SCRIPT_DIR, 'data', 'memory-smoke-cases.json')

// Embedding setup
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

// Copy DB to temp dir (read-only, no side effects)
const COPY_DIR = join(tmpdir(), `claude2bot-optimize-${process.pid}-${Date.now()}`)
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

// --- Matching logic (from smoke regression) ---
function normalize(text) {
  return String(text ?? '').toLowerCase()
}

function matchesExpectation(item, expected) {
  if (typeof expected === 'string') {
    return normalize(item?.content).includes(normalize(expected))
  }
  if (!expected || typeof expected !== 'object') return false
  if (expected.type && String(item?.type ?? '') !== String(expected.type)) return false
  if (expected.subtype && String(item?.subtype ?? '') !== String(expected.subtype)) return false
  if (Array.isArray(expected.subtypeAny) && !expected.subtypeAny.includes(String(item?.subtype ?? ''))) return false
  if (expected.source_kind && String(item?.source_kind ?? '') !== String(expected.source_kind)) return false
  const content = normalize(item?.content)
  if (Array.isArray(expected.contentAny) && !expected.contentAny.some(token => content.includes(normalize(token)))) return false
  if (Array.isArray(expected.contentAll) && !expected.contentAll.every(token => content.includes(normalize(token)))) return false
  return true
}

// --- Evaluation ---
// Pre-compute intents + queryVectors once (they don't depend on tuning weights)
console.log('Pre-computing intents and query vectors...')
const baseTuning = store.getRetrievalTuning()
const precomputed = []
for (const tc of cases) {
  const intent = await store.classifyQueryIntent(tc.query)
  precomputed.push({ tc, intent })
}
console.log(`Pre-computed ${precomputed.length} intents`)

async function evaluate(tuning) {
  let hit1 = 0, hit5 = 0, reciprocalRankSum = 0
  for (const { tc, intent } of precomputed) {
    const results = await store.searchRelevantHybrid(tc.query, 5, {
      tuning,
      intent,
      recordRetrieval: false,
    })
    const expected = tc.expectedAny || tc.expectedTop1Any || []
    const top1Matched = results.length > 0 && expected.some(exp => matchesExpectation(results[0], exp))
    const firstMatchIndex = results.findIndex(item =>
      expected.some(exp => matchesExpectation(item, exp)),
    )
    if (top1Matched) hit1++
    if (firstMatchIndex >= 0) {
      hit5++
      reciprocalRankSum += 1 / (firstMatchIndex + 1)
    }
  }
  const total = cases.length || 1
  return {
    hit1,
    hit5,
    mrr: reciprocalRankSum / total,
    score: hit1 * 2 + hit5,  // hit@1 weight x2
  }
}

// --- Search space ---
const SEARCH_SPACE = {
  'weights.overlap.defaultMax': [0.20, 0.50],
  'weights.overlap.policyMax': [0.30, 0.60],
  'weights.typeBoost.fact.decision': [-0.20, 0.0],
  'weights.typeBoost.fact.constraint': [-0.25, 0.0],
  'weights.typeBoost.task': [-0.25, 0.0],
  'weights.typeBoost.episode': [-0.15, 0.05],
  'weights.intentBoost.task.task': [-0.40, -0.10],
  'weights.intentBoost.decision.fact.decision': [-0.25, 0.0],
  'secondStageThreshold.default': [-0.50, -0.10],
  'weights.densityPenalty.episodeNoOverlap': [0.0, 0.25],
}

function setNestedValue(obj, path, value) {
  const keys = path.split('.')
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) current[keys[i]] = {}
    current = current[keys[i]]
  }
  current[keys[keys.length - 1]] = value
}

function getNestedValue(obj, path) {
  const keys = path.split('.')
  let current = obj
  for (const k of keys) {
    current = current?.[k]
  }
  return current
}

function randomInRange(min, max) {
  return min + Math.random() * (max - min)
}

function generateRandomTuning() {
  const tuning = JSON.parse(JSON.stringify(baseTuning))
  // Disable reranker during optimization (pure weight tuning)
  tuning.reranker = { ...tuning.reranker, enabled: false }
  for (const [path, [min, max]] of Object.entries(SEARCH_SPACE)) {
    setNestedValue(tuning, path, Number(randomInRange(min, max).toFixed(3)))
  }
  return tuning
}

// --- Run ---
const ITERATIONS = parseInt(process.env.ITERATIONS || '50', 10)

console.log(`\nSearch space: ${Object.keys(SEARCH_SPACE).length} parameters`)
console.log(`Iterations: ${ITERATIONS}`)
console.log(`Test cases: ${cases.length}`)

// Baseline (reranker disabled for fair comparison)
const baselineTuning = JSON.parse(JSON.stringify(baseTuning))
baselineTuning.reranker = { ...baselineTuning.reranker, enabled: false }
console.log('\n--- Baseline (reranker off) ---')
const baseline = await evaluate(baselineTuning)
console.log(`hit@1=${baseline.hit1}/${cases.length} (${(baseline.hit1 / cases.length).toFixed(3)})`)
console.log(`hit@5=${baseline.hit5}/${cases.length} (${(baseline.hit5 / cases.length).toFixed(3)})`)
console.log(`MRR@5=${baseline.mrr.toFixed(3)}`)
console.log(`score=${baseline.score}`)

// Print baseline values for search space params
console.log('\nBaseline values:')
for (const path of Object.keys(SEARCH_SPACE)) {
  console.log(`  ${path}: ${getNestedValue(baseTuning, path)}`)
}

// Random search
console.log('\n--- Random Search ---')
let best = { ...baseline, tuning: null }
const startTime = Date.now()

for (let i = 0; i < ITERATIONS; i++) {
  const tuning = generateRandomTuning()
  const result = await evaluate(tuning)
  if (result.score > best.score || (result.score === best.score && result.mrr > best.mrr)) {
    best = { ...result, tuning }
    console.log(`[${i}] NEW BEST: hit@1=${result.hit1} hit@5=${result.hit5} MRR=${result.mrr.toFixed(3)} score=${result.score}`)
  }
  if ((i + 1) % 10 === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[${i + 1}/${ITERATIONS}] ${elapsed}s elapsed | best: hit@1=${best.hit1} hit@5=${best.hit5} score=${best.score}`)
  }
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)

// --- Results ---
console.log('\n========================================')
console.log('=== RESULTS ===')
console.log('========================================')
console.log(`\nTotal time: ${totalTime}s (${ITERATIONS} iterations)`)
console.log(`\n--- Baseline ---`)
console.log(`hit@1=${baseline.hit1}/${cases.length} (${(baseline.hit1 / cases.length).toFixed(3)})`)
console.log(`hit@5=${baseline.hit5}/${cases.length} (${(baseline.hit5 / cases.length).toFixed(3)})`)
console.log(`MRR@5=${baseline.mrr.toFixed(3)}`)
console.log(`score=${baseline.score}`)

if (best.tuning) {
  console.log(`\n--- Best ---`)
  console.log(`hit@1=${best.hit1}/${cases.length} (${(best.hit1 / cases.length).toFixed(3)})`)
  console.log(`hit@5=${best.hit5}/${cases.length} (${(best.hit5 / cases.length).toFixed(3)})`)
  console.log(`MRR@5=${best.mrr.toFixed(3)}`)
  console.log(`score=${best.score}`)

  console.log(`\n--- Delta ---`)
  console.log(`hit@1: ${baseline.hit1} -> ${best.hit1} (${best.hit1 - baseline.hit1 >= 0 ? '+' : ''}${best.hit1 - baseline.hit1})`)
  console.log(`hit@5: ${baseline.hit5} -> ${best.hit5} (${best.hit5 - baseline.hit5 >= 0 ? '+' : ''}${best.hit5 - baseline.hit5})`)
  console.log(`MRR:   ${baseline.mrr.toFixed(3)} -> ${best.mrr.toFixed(3)} (${(best.mrr - baseline.mrr) >= 0 ? '+' : ''}${(best.mrr - baseline.mrr).toFixed(3)})`)

  console.log(`\n--- Optimal Values ---`)
  for (const [path, [min, max]] of Object.entries(SEARCH_SPACE)) {
    const baseVal = getNestedValue(baseTuning, path)
    const bestVal = getNestedValue(best.tuning, path)
    const delta = bestVal - baseVal
    console.log(`  ${path}: ${baseVal} -> ${Number(bestVal).toFixed(3)} (${delta >= 0 ? '+' : ''}${delta.toFixed(3)})`)
  }

  // Output as copy-pasteable object
  console.log(`\n--- Copy-paste for memory-tuning.mjs ---`)
  console.log(`{`)
  for (const path of Object.keys(SEARCH_SPACE)) {
    const bestVal = getNestedValue(best.tuning, path)
    console.log(`  // ${path}: ${Number(bestVal).toFixed(3)}`)
  }
  console.log(`}`)
} else {
  console.log('\nBaseline is already optimal (no improvement found)')
}

// Cleanup
try { rmSync(COPY_DIR, { recursive: true, force: true }) } catch {}
