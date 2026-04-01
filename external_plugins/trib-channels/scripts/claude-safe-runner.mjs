#!/usr/bin/env node

import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import process from 'process'

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    model: 'sonnet',
    effort: 'medium',
    timeoutMs: 180000,
    noConnect: false,
    promptFile: '',
    prompt: '',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--cwd' && argv[i + 1]) {
      options.cwd = argv[++i]
    } else if (arg === '--model' && argv[i + 1]) {
      options.model = argv[++i]
    } else if (arg === '--effort' && argv[i + 1]) {
      options.effort = argv[++i]
    } else if (arg === '--timeout-ms' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i], 10)
      if (Number.isFinite(parsed) && parsed > 0) options.timeoutMs = parsed
    } else if (arg === '--prompt-file' && argv[i + 1]) {
      options.promptFile = argv[++i]
    } else if (arg === '--prompt' && argv[i + 1]) {
      options.prompt = argv[++i]
    } else if (arg === '--no-connect') {
      options.noConnect = true
    } else if (arg === '--help') {
      process.stdout.write([
        'claude-safe-runner',
        '',
        'Options:',
        '  --cwd <path>',
        '  --model <name>',
        '  --effort <low|medium|high|max>',
        '  --timeout-ms <ms>',
        '  --prompt-file <path>',
        '  --prompt <text>',
        '  --no-connect',
      ].join('\n') + '\n')
      process.exit(0)
    }
  }

  return options
}

async function readPrompt(options) {
  if (options.promptFile) {
    return readFileSync(options.promptFile, 'utf8')
  }
  if (options.prompt) {
    return options.prompt
  }
  if (!process.stdin.isTTY) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }
  throw new Error('prompt input is required')
}

function killChildGroup(child, signal) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') {
      child.kill(signal)
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    // child may already be gone
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const prompt = await readPrompt(options)
  const args = ['-p', '--model', options.model, '--effort', options.effort]
  const env = {
    ...process.env,
    ...(options.noConnect ? { TRIB_CHANNELS_NO_CONNECT: '1' } : {}),
  }

  const child = spawn('claude', args, {
    cwd: options.cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'inherit', 'inherit'],
  })

  let cleaned = false
  let timeout = null

  const cleanup = (signal = 'SIGTERM') => {
    if (cleaned) return
    cleaned = true
    if (timeout) clearTimeout(timeout)
    killChildGroup(child, signal)
    timeout = setTimeout(() => {
      killChildGroup(child, 'SIGKILL')
    }, 1500)
  }

  process.on('SIGINT', () => {
    cleanup('SIGTERM')
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    cleanup('SIGTERM')
    process.exit(143)
  })
  process.on('exit', () => {
    cleanup('SIGTERM')
  })

  const wallTimer = setTimeout(() => {
    cleanup('SIGTERM')
    process.stderr.write(`[claude-safe-runner] timed out after ${options.timeoutMs}ms\n`)
  }, options.timeoutMs)

  child.stdin.end(prompt)

  child.on('error', err => {
    clearTimeout(wallTimer)
    cleanup('SIGKILL')
    process.stderr.write(`[claude-safe-runner] spawn failed: ${err.message}\n`)
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    clearTimeout(wallTimer)
    if (timeout) clearTimeout(timeout)
    cleaned = true
    if (signal) {
      process.exit(128 + 15)
    }
    process.exit(code ?? 0)
  })
}

main().catch(err => {
  process.stderr.write(`[claude-safe-runner] ${err.message}\n`)
  process.exit(1)
})
