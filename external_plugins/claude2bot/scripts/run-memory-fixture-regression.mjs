#!/usr/bin/env node

import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { getMemoryStore } from '../lib/memory.mjs'
import { buildMemoryFixture } from './build-memory-fixture.mjs'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const CASES_PATH = join(SCRIPT_DIR, 'data', 'memory-fixture-cases.json')

const fixture = await buildMemoryFixture()
const store = getMemoryStore(fixture.targetDir)

const rawCases = JSON.parse(readFileSync(CASES_PATH, 'utf8'))
const cases = rawCases.flatMap(item => {
  const queries = [item.query, ...(item.variants || [])].map(query =>
    String(query).replaceAll('{BASE_DATE}', fixture.baseDate),
  )
  return queries.map((query, index) => ({
    ...item,
    caseId: item.id,
    id: index === 0 ? item.id : `${item.id}__v${index}`,
    query,
  }))
})

function normalize(text) {
  return String(text ?? '').toLowerCase()
}

let intentPass = 0
let hitAt5 = 0
let reciprocalRankSum = 0
let failures = 0

process.stdout.write(`[fixture] targetDir=${fixture.targetDir}\n`)
process.stdout.write(`[fixture] baseDate=${fixture.baseDate}\n`)
process.stdout.write(`[fixture] queries=${cases.length}\n`)

for (const testCase of cases) {
  const intent = await store.classifyQueryIntent(testCase.query)
  const results = await store.searchRelevantHybrid(testCase.query, 5, { intent })

  const acceptableIntents = new Set([testCase.expectedIntent, ...(testCase.acceptableIntents || [])])
  const intentMatched = acceptableIntents.has(intent.primary)
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
  if (!intentMatched || !hit) failures += 1

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
if (failures > 0) {
  process.exitCode = 1
}
