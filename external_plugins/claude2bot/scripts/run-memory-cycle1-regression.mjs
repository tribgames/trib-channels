#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CASES_PATH = join(SCRIPT_DIR, 'data', 'memory-cycle1-cases.json')
const TARGET_ROOT = join(tmpdir(), `claude2bot-cycle-regression-${process.pid}-${Date.now()}`)

process.env.CLAUDE_PLUGIN_DATA = TARGET_ROOT
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT

mkdirSync(join(TARGET_ROOT, 'history'), { recursive: true })
writeFileSync(join(TARGET_ROOT, 'config.json'), JSON.stringify({ embedding: { provider: 'local' } }, null, 2) + '\n', 'utf8')
writeFileSync(join(TARGET_ROOT, 'memory-cycle.json'), JSON.stringify({ lastCycle1At: 0 }, null, 2) + '\n', 'utf8')

const { configureEmbedding, getEmbeddingDims, warmupEmbeddingProvider } = await import('../lib/embedding-provider.mjs')
configureEmbedding({ provider: 'local' })
await warmupEmbeddingProvider()
process.env.CLAUDE2BOT_FORCE_VEC_DIMS = String(getEmbeddingDims())

const { getMemoryStore } = await import('../lib/memory.mjs')
const { runCycle1 } = await import('../lib/memory-cycle.mjs')

const cases = JSON.parse(readFileSync(CASES_PATH, 'utf8'))

function normalize(text) {
  return String(text ?? '').toLowerCase()
}

function expectMatches(rows, patterns = [], field = 'text') {
  return patterns.every(pattern => rows.some(row => normalize(row[field]).includes(normalize(pattern))))
}

function expectNotMatches(rows, patterns = [], field = 'text') {
  return patterns.every(pattern => rows.every(row => !normalize(row[field]).includes(normalize(pattern))))
}

let failures = 0

for (const testCase of cases) {
  const caseDir = join(TARGET_ROOT, testCase.id)
  rmSync(caseDir, { recursive: true, force: true })
  mkdirSync(join(caseDir, 'history'), { recursive: true })
  writeFileSync(join(caseDir, 'config.json'), JSON.stringify({ embedding: { provider: 'local' } }, null, 2) + '\n', 'utf8')
  writeFileSync(join(TARGET_ROOT, 'memory-cycle.json'), JSON.stringify({ lastCycle1At: 0 }, null, 2) + '\n', 'utf8')

  const store = getMemoryStore(caseDir)
  for (const [index, episode] of (testCase.episodes || []).entries()) {
    store.appendEpisode({
      ts: episode.ts,
      backend: 'discord',
      channelId: 'cycle1-fixture',
      userId: episode.role === 'user' ? 'fixture-user' : 'fixture-assistant',
      userName: episode.role,
      role: episode.role,
      kind: episode.kind,
      content: episode.content,
      sourceRef: `cycle1:${testCase.id}:${index}`,
    })
  }

  const llm = async () => JSON.stringify(testCase.llmOutput)
  await runCycle1('/Users/jyp/Project', { memory: { cycle1: { timeout: 1000 } } }, { store, llm, skipWaterfall: true })

  const facts = store.db.prepare(`SELECT fact_type, text FROM facts WHERE status = 'active' ORDER BY id`).all()
  const tasks = store.db.prepare(`SELECT title, details FROM tasks ORDER BY id`).all()
  const signals = store.db.prepare(`SELECT kind, value FROM signals ORDER BY id`).all()
  const profiles = store.db.prepare(`SELECT key, value FROM profiles WHERE status = 'active' ORDER BY key, value`).all()

  const factIncludePass = expectMatches(facts, testCase.expect?.factsInclude, 'text')
  const factExcludePass = expectNotMatches(facts, testCase.expect?.factsExclude, 'text')
  const taskIncludePass = expectMatches(tasks, testCase.expect?.tasksInclude, 'title')
  const signalIncludePass = expectMatches(signals, testCase.expect?.signalsInclude, 'value')
  const profileIncludePass = (testCase.expect?.profilesInclude || []).every(item =>
    profiles.some(profile => profile.key === item.key && normalize(profile.value).includes(normalize(item.value))),
  )

  const passed = factIncludePass && factExcludePass && taskIncludePass && signalIncludePass && profileIncludePass
  if (!passed) failures += 1

  process.stdout.write(`\n[${testCase.id}] ${passed ? 'PASS' : 'FAIL'}\n`)
  process.stdout.write(`facts:\n`)
  facts.forEach(row => process.stdout.write(`- [${row.fact_type}] ${row.text}\n`))
  process.stdout.write(`tasks:\n`)
  tasks.forEach(row => process.stdout.write(`- ${row.title}${row.details ? ` — ${row.details}` : ''}\n`))
  if (signals.length > 0) {
    process.stdout.write(`signals:\n`)
    signals.forEach(row => process.stdout.write(`- [${row.kind}] ${row.value}\n`))
  }
  if (profiles.length > 0) {
    process.stdout.write(`profiles:\n`)
    profiles.forEach(row => process.stdout.write(`- [${row.key}] ${row.value}\n`))
  }
}

process.stdout.write(`\n=== summary ===\n`)
process.stdout.write(`cases=${cases.length}\n`)
process.stdout.write(`failures=${failures}\n`)
if (failures > 0) process.exitCode = 1
