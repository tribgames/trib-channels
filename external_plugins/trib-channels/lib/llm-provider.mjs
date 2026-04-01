/**
 * llm-provider.mjs — Unified LLM provider abstraction layer.
 * Supports: codex, cli (claude), ollama, api (placeholder).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * @param {string} prompt — LLM에 보낼 프롬프트
 * @param {object} provider — { connection, model, effort?, fast?, baseUrl? }
 * @param {object} options — { timeout?, cwd? }
 * @returns {Promise<string>} — LLM 응답 텍스트
 */
export async function callLLM(prompt, provider, options = {}) {
  switch (provider.connection) {
    case 'codex':
      return callCodex(prompt, provider, options)
    case 'cli':
      return callClaude(prompt, provider, options)
    case 'ollama':
      return callOllama(prompt, provider, options)
    case 'api':
      return callAPI(prompt, provider, options)
    default:
      throw new Error(`Unknown provider connection: ${provider.connection}`)
  }
}

async function callCodex(prompt, provider, options) {
  const args = ['exec', '--model', provider.model || 'gpt-5.4']
  if (provider.effort) args.push('-c', `model_reasoning_effort=${provider.effort}`)
  if (provider.fast) args.push('-c', 'service_tier=fast')
  args.push('--skip-git-repo-check', '--json', prompt)

  const { stdout } = await execFileAsync('codex', args, {
    timeout: options.timeout || 60000,
    maxBuffer: 10 * 1024 * 1024,
  })

  // JSON streaming parse — extract text from agent_message type
  const lines = stdout.split('\n').filter(l => l.trim())
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
        return obj.item.text
      }
    } catch { /* skip non-JSON lines */ }
  }
  return ''
}

async function callClaude(prompt, provider, options) {
  const args = [
    '-p',
    '--system-prompt', 'You are a memory extraction system.',
    '--tools', '',
    '--setting-sources', '',
  ]
  if (provider.effort) args.push('--effort', provider.effort)
  args.push('--', prompt)

  const { stdout } = await execFileAsync('claude', args, {
    timeout: options.timeout || 120000,
    maxBuffer: 10 * 1024 * 1024,
    shell: '/bin/zsh',
    env: { ...process.env, CLAUDE2BOT_NO_CONNECT: '1', TRIB_SEARCH_SPAWNED: '1' },
  })
  return stdout.trim()
}

async function callOllama(prompt, provider, options) {
  const baseUrl = provider.baseUrl || 'http://localhost:11434'
  const resp = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: provider.model || 'qwen3.5:9b',
      prompt,
      stream: false,
      options: { num_ctx: 4096, temperature: 0 },
    }),
    signal: AbortSignal.timeout(options.timeout || 120000),
  })
  const data = await resp.json()
  return data.response || ''
}

async function callAPI(prompt, provider, options) {
  // Anthropic/OpenAI API direct call — to be implemented
  throw new Error('API provider not yet implemented. Use codex, cli, or ollama.')
}
