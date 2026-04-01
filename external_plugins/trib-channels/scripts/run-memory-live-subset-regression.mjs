#!/usr/bin/env node

import { spawnSync } from 'child_process'
import { join } from 'path'
import { fileURLToPath } from 'url'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const CASES_PATH = join(SCRIPT_DIR, 'data', 'memory-live-subset-cases.json')
const RUNNER = join(SCRIPT_DIR, 'run-memory-smoke-regression.mjs')

const result = spawnSync(process.execPath, [RUNNER], {
  cwd: join(SCRIPT_DIR, '..'),
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 20,
  env: {
    ...process.env,
    CLAUDE2BOT_SMOKE_CASES: CASES_PATH,
  },
})

process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
if ((result.status ?? 0) !== 0) {
  process.exitCode = result.status ?? 1
}
