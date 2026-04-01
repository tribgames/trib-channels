#!/usr/bin/env node

import { spawnSync } from 'child_process'
import { join } from 'path'
import { fileURLToPath } from 'url'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))

function run(scriptName) {
  return spawnSync(process.execPath, [join(SCRIPT_DIR, scriptName)], {
    cwd: join(SCRIPT_DIR, '..'),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
    env: process.env,
  })
}

const fixture = run('run-memory-fixture-regression.mjs')
process.stdout.write(fixture.stdout)
process.stderr.write(fixture.stderr)

const liveSubset = run('run-memory-live-subset-regression.mjs')
process.stdout.write('\n--- live-subset ---\n')
process.stdout.write(liveSubset.stdout)
process.stderr.write(liveSubset.stderr)

if ((fixture.status ?? 1) !== 0) {
  process.exitCode = fixture.status ?? 1
} else if ((liveSubset.status ?? 0) !== 0) {
  process.exitCode = liveSubset.status ?? 1
}
