#!/usr/bin/env node

import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TARGET_ROOT = join(tmpdir(), `trib-channels-context-regression-${process.pid}-${Date.now()}`)
process.env.CLAUDE_PLUGIN_DATA = TARGET_ROOT

mkdirSync(join(TARGET_ROOT, 'history'), { recursive: true })
writeFileSync(join(TARGET_ROOT, 'config.json'), JSON.stringify({ embedding: { provider: 'local' } }, null, 2) + '\n', 'utf8')

const { configureEmbedding, getEmbeddingDims, warmupEmbeddingProvider } = await import('../lib/embedding-provider.mjs')
configureEmbedding({ provider: 'local' })
await warmupEmbeddingProvider()
process.env.CLAUDE2BOT_FORCE_VEC_DIMS = String(getEmbeddingDims())

const { getMemoryStore } = await import('../lib/memory.mjs')
const { parseTemporalHint, isDoneTaskQuery } = await import('../lib/memory-query-plan.mjs')

function normalize(text) {
  return String(text ?? '').toLowerCase()
}

let failures = 0

{
  const caseDir = join(TARGET_ROOT, 'recent-channel-scope')
  rmSync(caseDir, { recursive: true, force: true })
  mkdirSync(join(caseDir, 'history'), { recursive: true })
  writeFileSync(join(caseDir, 'config.json'), JSON.stringify({ embedding: { provider: 'local' } }, null, 2) + '\n', 'utf8')
  const store = getMemoryStore(caseDir)

  const epA = store.appendEpisode({
    ts: '2026-03-31T01:00:00.000Z',
    backend: 'discord',
    channelId: 'fixture-channel-a',
    userId: 'fixture-user',
    userName: 'user',
    role: 'user',
    kind: 'message',
    content: '같은 채널 최근 주제: 메모리 검색 품질',
    sourceRef: 'ctx:recent:a',
  })
  store.appendEpisode({
    ts: '2026-03-31T01:05:00.000Z',
    backend: 'discord',
    channelId: 'fixture-channel-b',
    userId: 'fixture-user',
    userName: 'user',
    role: 'user',
    kind: 'message',
    content: '완전히 무관한 다른 채널 주제: 세금 신고 마감일',
    sourceRef: 'ctx:recent:b',
  })
  store.upsertProfiles([{ key: 'language', value: '한국어로 소통한다.', confidence: 0.95 }], '2026-03-31T01:06:00.000Z', epA?.id ?? null)
  store.upsertSignals([{ kind: 'language', value: '한국어로 빠르게 설계와 구현 검토를 이어가는 편이다.', score: 0.95 }], epA?.id ?? null, '2026-03-31T01:06:00.000Z')

  const context = await store.buildInboundMemoryContext('언어 선호 뭐야', {
    channelId: 'fixture-channel-a',
    userId: 'fixture-user',
  })
  const passed = normalize(context).includes(normalize('같은 채널 최근 주제')) && !normalize(context).includes(normalize('세금 신고 마감일'))
  if (!passed) failures += 1
  process.stdout.write(`\n[recent-channel-scope] ${passed ? 'PASS' : 'FAIL'}\n`)
  process.stdout.write(`${context}\n`)
}

{
  const caseDir = join(TARGET_ROOT, 'no-auto-retrieval-count')
  rmSync(caseDir, { recursive: true, force: true })
  mkdirSync(join(caseDir, 'history'), { recursive: true })
  writeFileSync(join(caseDir, 'config.json'), JSON.stringify({ embedding: { provider: 'local' } }, null, 2) + '\n', 'utf8')
  const store = getMemoryStore(caseDir)

  const ep = store.appendEpisode({
    ts: '2026-03-31T02:00:00.000Z',
    backend: 'discord',
    channelId: 'fixture-channel-a',
    userId: 'fixture-user',
    userName: 'user',
    role: 'user',
    kind: 'message',
    content: '커밋이나 푸시는 사용자가 명시적으로 요청하기 전에는 실행하지 않는다.',
    sourceRef: 'ctx:retrieval:src',
  })
  await store.upsertFacts([
    {
      type: 'constraint',
      text: '커밋이나 푸시는 사용자가 명시적으로 요청하기 전에는 실행하지 않는다.',
      confidence: 0.96,
    },
  ], '2026-03-31T02:01:00.000Z', ep?.id ?? null)

  const before = store.db.prepare(`SELECT retrieval_count FROM facts WHERE fact_type='constraint'`).get()?.retrieval_count ?? 0
  await store.buildInboundMemoryContext('커밋 먼저 하면 안 되지?', {
    channelId: 'fixture-channel-a',
    userId: 'fixture-user',
  })
  const after = store.db.prepare(`SELECT retrieval_count FROM facts WHERE fact_type='constraint'`).get()?.retrieval_count ?? 0
  const passed = before === after
  if (!passed) failures += 1
  process.stdout.write(`\n[no-auto-retrieval-count] ${passed ? 'PASS' : 'FAIL'} before=${before} after=${after}\n`)
}

{
  const yesterday = parseTemporalHint('what happened yesterday')
  const twoDays = parseTemporalHint('what happened two days ago')
  const passed = Boolean(yesterday?.exact) && yesterday?.start === '2026-03-30' && Boolean(twoDays?.exact) && twoDays?.start === '2026-03-29'
  if (!passed) failures += 1
  process.stdout.write(`\n[relative-date-exact] ${passed ? 'PASS' : 'FAIL'} ${JSON.stringify({ yesterday, twoDays })}\n`)
}

{
  const statusOnly = isDoneTaskQuery('현재 상태가 어때?')
  const taskStatus = isDoneTaskQuery('Windows 호환성 작업 상태 뭐야')
  const completed = isDoneTaskQuery('completed task 알려줘')
  const passed = statusOnly === false && taskStatus === true && completed === true
  if (!passed) failures += 1
  process.stdout.write(`\n[vague-status-query] ${passed ? 'PASS' : 'FAIL'} ${JSON.stringify({ statusOnly, taskStatus, completed })}\n`)
}

process.stdout.write(`\n=== summary ===\n`)
process.stdout.write(`failures=${failures}\n`)
if (failures > 0) process.exitCode = 1
