#!/usr/bin/env node

import { buildMemoryFixture } from './build-memory-fixture.mjs'
import { getMemoryStore } from '../lib/memory.mjs'

const fixture = await buildMemoryFixture()
const store = getMemoryStore(fixture.targetDir)

const scenarios = [
  { label: 'search-policy', query: '커밋 먼저 하면 안 되지?', limit: 5 },
  { label: 'search-entity', query: 'ProjectAA랑 ProjectAA_Server 관계 뭐야', limit: 5 },
  { label: 'search-history', query: `${fixture.baseDate}에 무슨 얘기 했지`, limit: 5 },
  { label: 'search-profile', query: '언어랑 말투 선호 뭐야', limit: 5 },
  { label: 'search-rule', query: 'session transcript prompt는 durable memory로 보면 안 되지?', limit: 5 },
]

function renderResult(item) {
  const sourceParts = [
    item.source_ref ? String(item.source_ref) : null,
    item.source_ts ? `ts:${String(item.source_ts)}` : null,
    item.source_kind ? `kind:${String(item.source_kind)}` : null,
    item.source_backend ? `backend:${String(item.source_backend)}` : null,
  ].filter(Boolean)
  return {
    type: item.type,
    subtype: item.subtype ?? null,
    content: String(item.content ?? ''),
    source: sourceParts,
  }
}

for (const scenario of scenarios) {
  const intent = await store.classifyQueryIntent(scenario.query)
  const results = await store.searchRelevantHybrid(scenario.query, scenario.limit, { intent })
  process.stdout.write(`\n[${scenario.label}]\n`)
  process.stdout.write(`query=${scenario.query}\n`)
  process.stdout.write(`intent=${intent.primary}\n`)
  process.stdout.write(`${JSON.stringify(results.map(renderResult), null, 2)}\n`)
}
