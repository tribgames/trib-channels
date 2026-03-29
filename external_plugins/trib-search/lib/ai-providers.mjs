import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { CLI_HOME_DIR, ensureDir } from './config.mjs'

export const AI_PROVIDER_IDS = ['grok', 'gemini', 'claude', 'codex']

function commandExists(command) {
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [command], {
      stdio: 'ignore',
    })
    child.on('exit', code => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

export async function getAvailableAiProviders() {
  const results = []
  for (const provider of AI_PROVIDER_IDS) {
    if (await commandExists(provider)) {
      results.push(provider)
    }
  }
  return results
}

function buildPrompt(query, site) {
  const parts = [
    'Answer using live web search when the provider supports it.',
    'Return a concise answer with source URLs when possible.',
  ]
  if (site) {
    parts.push(`Limit the search to site:${site}.`)
  }
  parts.push(`Question: ${query}`)
  return parts.join('\n')
}

function extractGrokAnswer(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    return content.trim()
  }

  if (Array.isArray(content)) {
    return content
      .map(item => item?.text || '')
      .join('\n')
      .trim()
  }

  return ''
}

async function runGrokApi(prompt, model, env, timeoutMs) {
  const apiKey = env.XAI_API_KEY || env.GROK_API_KEY
  if (!apiKey) {
    throw new Error('XAI_API_KEY or GROK_API_KEY is required for Grok API mode')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        model: model || 'grok-4',
        stream: false,
        temperature: 0.7,
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Grok API failed: ${response.status} ${body}`)
    }

    const payload = await response.json()
    const answer = extractGrokAnswer(payload)
    if (!answer) {
      throw new Error('Grok API returned an empty answer')
    }
    return {
      stdout: answer,
      stderr: null,
    }
  } finally {
    clearTimeout(timer)
  }
}

function providerHome(provider) {
  // Use PID-based subdirectory to prevent concurrent CLI file conflicts
  const home = path.join(CLI_HOME_DIR, provider, String(process.pid))
  ensureDir(home)
  if (provider === 'gemini') {
    ensureDir(path.join(home, '.gemini'))
  }
  return home
}

function buildProviderEnv(provider) {
  if (provider === 'claude') {
    return {
      ...process.env,
      CLAUDE2BOT_NO_CONNECT: '1',       // prevent killing main claude2bot session
      CLAUDE_CODE_DISABLE_PLUGINS: '1',  // prevent recursive plugin loading
    }
  }
  if (provider === 'codex') {
    return { ...process.env }
  }

  const home = providerHome(provider)
  return {
    ...process.env,
    HOME: home,
  }
}

function buildProviderCwd(provider, env) {
  if (provider === 'claude' || provider === 'codex') {
    return env.TRIB_SEARCH_EXEC_CWD || env.PWD || env.HOME || '/tmp'
  }
  return process.cwd()
}

function runCli(command, args, env, timeoutMs, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', code => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`))
        return
      }
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    })
  })
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`
}

function runShellCli(commandText, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/zsh', ['-lc', commandText], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`shell command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', code => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`shell command exited with ${code}: ${stderr.trim()}`))
        return
      }
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    })
  })
}

function extractCodexAnswer(stdout) {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  let lastMessage = null
  for (const line of lines) {
    try {
      const payload = JSON.parse(line)
      if (payload?.type === 'item.completed' && payload?.item?.type === 'agent_message') {
        lastMessage = payload.item.text || lastMessage
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  return lastMessage || stdout.trim()
}

export async function runAiSearch({
  query,
  provider,
  site,
  model,
  timeoutMs,
}) {
  if (site === 'x.com' && provider && provider !== 'grok') {
    throw new Error('x.com is only supported by grok in ai_search')
  }

  const finalProvider = site === 'x.com' ? 'grok' : provider
  if (!finalProvider) {
    throw new Error('provider is required for ai_search')
  }

  const env = buildProviderEnv(finalProvider)
  const cwd = buildProviderCwd(finalProvider, env)

  switch (finalProvider) {
    case 'grok': {
      const prompt = buildPrompt(query, site)
      const result =
        env.XAI_API_KEY || env.GROK_API_KEY
          ? await runGrokApi(prompt, model, env, timeoutMs)
          : await runCli(
              'grok',
              model ? ['-m', model, '-p', prompt] : ['-p', prompt],
              env,
              timeoutMs,
              cwd,
            )
      return {
        provider: 'grok',
        model: model || null,
        answer: result.stdout,
        stderr: result.stderr || null,
      }
    }
    case 'gemini': {
      const prompt = buildPrompt(query, site)
      const args = ['-p', prompt, '--output-format', 'text']
      if (model) {
        args.push('--model', model)
      }
      const result = await runCli(
        'gemini',
        args,
        env,
        timeoutMs,
        cwd,
      )
      return {
        provider: 'gemini',
        model: model || null,
        answer: result.stdout,
        stderr: result.stderr || null,
      }
    }
    case 'claude': {
      const prompt = buildPrompt(query, site)
      const command = [
        `cd ${shellEscape(cwd)}`,
        '&&',
        'claude',
        '--print',
        ...(model ? ['--model', shellEscape(model)] : []),
        '--',
        shellEscape(prompt),
      ].join(' ')
      const result = await runShellCli(command, env, timeoutMs)
      return {
        provider: 'claude',
        model: model || null,
        answer: result.stdout,
        stderr: result.stderr || null,
      }
    }
    case 'codex': {
      const prompt = buildPrompt(query, site)
      const args = [
        'exec',
        '-c',
        'model_reasoning_effort=medium',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--json',
        prompt,
      ]
      if (model) {
        args.splice(1, 0, '--model', model)
      }
      const result = await runCli('codex', args, env, timeoutMs, cwd)
      return {
        provider: 'codex',
        model: model || null,
        answer: extractCodexAnswer(result.stdout),
        stderr: result.stderr || null,
      }
    }
    default:
      throw new Error(`Unsupported ai_search provider: ${finalProvider}`)
  }
}
