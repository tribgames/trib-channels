/**
 * Webhook receiver — HTTP server that accepts external webhook events,
 * parses/filters them, and dispatches via the same pipeline as the scheduler.
 */

import * as http from 'http'
import { spawn } from 'child_process'
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { join, normalize, extname } from 'path'
import type { WebhookConfig, WebhookEndpoint, ChannelsConfig } from '../backends/types.js'
import type { EventPipeline } from './event-pipeline.js'
import { DATA_DIR } from './config.js'
import { ensureDir } from './state-file.js'
import { appendFileSync } from 'fs'

const WEBHOOK_LOG = join(DATA_DIR, 'webhook.log')
function logWebhook(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stderr.write(`claude2bot webhook: ${msg}\n`)
  try { appendFileSync(WEBHOOK_LOG, line) } catch { /* best effort */ }
}

const SCRIPTS_DIR = join(DATA_DIR, 'scripts')
const WEBHOOKS_DIR = join(DATA_DIR, 'webhooks')

// ── Callback types ────────────────────────────────────────────────────

type InjectFn = (channelId: string, name: string, promptContent: string) => void
type SendFn = (channelId: string, text: string) => Promise<void>
type SessionStateGetter = () => 'idle' | 'active' | 'recent'

// ── Built-in parsers ──────────────────────────────────────────────────

function parseGithub(body: any, headers: Record<string, string>): Record<string, string> {
  const event = headers['x-github-event'] || ''
  const action = body.action || ''
  const pr = body.pull_request || body.issue || {}
  return {
    event, action,
    title: pr.title || body.head_commit?.message || '',
    author: pr.user?.login || body.sender?.login || '',
    repo: body.repository?.full_name || '',
    url: pr.html_url || body.compare || '',
    branch: body.ref || pr.head?.ref || '',
    message: body.head_commit?.message || '',
  }
}

function parseSentry(body: any): Record<string, string> {
  const data = body.data || {}
  const event = data.event || data.issue || {}
  return {
    title: event.title || body.message || '',
    level: event.level || body.level || '',
    project: body.project_name || body.project || '',
    url: event.web_url || body.url || '',
  }
}

function parseGeneric(body: any): Record<string, string> {
  const result: Record<string, string> = {}
  const keys = Object.keys(body).slice(0, 5)
  for (const k of keys) {
    result[k] = typeof body[k] === 'string' ? body[k] : JSON.stringify(body[k])
  }
  return result
}

// ── Filter engine ─────────────────────────────────────────────────────

/**
 * Simple filter evaluator supporting == comparison with || and && operators.
 * Example: "event == 'push' && branch == 'main'"
 */
function evaluateFilter(expr: string, data: Record<string, string>): boolean {
  // Split by || first (lower precedence)
  const orParts = expr.split('||').map(s => s.trim())
  for (const orPart of orParts) {
    // Split by && (higher precedence)
    const andParts = orPart.split('&&').map(s => s.trim())
    let andResult = true
    for (const condition of andParts) {
      // Parse "field == 'value'" or 'field == "value"'
      const match = condition.match(/^(\w+)\s*==\s*['"](.*)['"]$/)
      if (!match) {
        // Also support != operator
        const neqMatch = condition.match(/^(\w+)\s*!=\s*['"](.*)['"]$/)
        if (neqMatch) {
          const [, field, value] = neqMatch
          if ((data[field] ?? '') === value) { andResult = false; break }
        } else {
          // Unparseable condition → treat as false
          andResult = false
          break
        }
        continue
      }
      const [, field, value] = match
      if ((data[field] ?? '') !== value) { andResult = false; break }
    }
    if (andResult) return true
  }
  return false
}

// ── WebhookServer ─────────────────────────────────────────────────────

export class WebhookServer {
  private config: WebhookConfig
  private channelsConfig: ChannelsConfig | null
  private server: http.Server | null = null
  private batchTimer: ReturnType<typeof setInterval> | null = null

  // External handlers (injected from server.ts)
  private injectFn: InjectFn | null = null
  private sendFn: SendFn | null = null
  private sessionStateGetter: SessionStateGetter | null = null
  private eventPipeline: EventPipeline | null = null

  constructor(config: WebhookConfig, channelsConfig: ChannelsConfig | null) {
    this.config = config
    this.channelsConfig = channelsConfig
  }

  setEventPipeline(pipeline: EventPipeline): void { this.eventPipeline = pipeline }

  setInjectHandler(fn: InjectFn): void {
    this.injectFn = fn
  }

  setSendHandler(fn: SendFn): void {
    this.sendFn = fn
  }

  setSessionStateGetter(fn: SessionStateGetter): void {
    this.sessionStateGetter = fn
  }

  // ── HTTP server ───────────────────────────────────────────────────

  start(): void {
    if (this.server) return

    // Ensure webhook data directories
    ensureDir(WEBHOOKS_DIR)

    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('OK')
        return
      }

      if (req.method === 'POST' && req.url?.startsWith('/webhook/')) {
        const name = req.url.slice('/webhook/'.length).split('?')[0]
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk })
        req.on('end', () => {
          try {
            const parsed = body ? JSON.parse(body) : {}
            const headers: Record<string, string> = {}
            for (const [k, v] of Object.entries(req.headers)) {
              if (typeof v === 'string') headers[k] = v
            }
            this.handleWebhook(name, parsed, headers, res)
          } catch (err) {
            logWebhook(`JSON parse error for ${name}: ${err}`)
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid JSON' }))
          }
        })
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    })

    const port = this.config.port || 3333
    this.server.listen(port, () => {
      logWebhook(`listening on port ${port}`)
    })

    // Start batch timer
    const batchMs = (this.config.batchInterval || 30) * 60_000
    this.batchTimer = setInterval(() => this.processBatch(), batchMs)
    logWebhook(`batch timer set to ${this.config.batchInterval || 30}m`)
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    if (this.batchTimer) {
      clearInterval(this.batchTimer)
      this.batchTimer = null
    }
    logWebhook('stopped')
  }

  reloadConfig(config: WebhookConfig, channelsConfig: ChannelsConfig | null): void {
    this.stop()
    this.config = config
    this.channelsConfig = channelsConfig
    if (config.enabled) this.start()
  }

  // ── Webhook handler ───────────────────────────────────────────────

  private handleWebhook(
    name: string,
    body: any,
    headers: Record<string, string>,
    res: http.ServerResponse,
  ): void {
    // Try event pipeline first (new system)
    if (this.eventPipeline?.handleWebhook(name, body, headers)) {
      logWebhook(`${name}: routed to event pipeline`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'accepted' }))
      return
    }

    // Fallback to legacy webhook endpoints
    const endpoint = this.config.endpoints[name]
    if (!endpoint) {
      logWebhook(`unknown endpoint: ${name}`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown endpoint' }))
      return
    }

    // Parse
    let parsed: Record<string, string>
    if (endpoint.parser === 'github') {
      parsed = parseGithub(body, headers)
    } else if (endpoint.parser === 'sentry') {
      parsed = parseSentry(body)
    } else if (endpoint.parser === 'generic') {
      parsed = parseGeneric(body)
    } else {
      parsed = { raw: JSON.stringify(body) }
    }

    // Filter
    if (endpoint.filter) {
      if (!evaluateFilter(endpoint.filter, parsed)) {
        logWebhook(`${name}: filtered out`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'filtered' }))
        return
      }
    }

    // Template substitution
    let prompt = endpoint.execute
    for (const [key, value] of Object.entries(parsed)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
    }

    // Dispatch
    if (endpoint.mode === 'immediate') {
      this.dispatch(name, endpoint, prompt)
    } else {
      this.savePending(name, prompt)
    }

    logWebhook(`${name}: ${endpoint.mode} (${endpoint.exec})`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'accepted' }))
  }

  // ── Dispatch ──────────────────────────────────────────────────────

  private dispatch(name: string, endpoint: WebhookEndpoint, prompt: string): void {
    const channelId = this.resolveChannel(endpoint.channel)

    if (endpoint.exec === 'interactive') {
      const state = this.sessionStateGetter?.()
      if (state !== 'idle') {
        // Fallback to pending queue when session is busy
        this.savePending(name, prompt)
        logWebhook(`${name}: session ${state}, queued as pending`)
        return
      }
      if (this.injectFn) this.injectFn(channelId, `webhook:${name}`, prompt)
    } else if (endpoint.exec === 'non-interactive') {
      this.spawnClaudeP(channelId, name, prompt)
    } else if (endpoint.exec === 'script') {
      if (endpoint.script) {
        this.runScript(endpoint.script, channelId, name)
      } else {
        logWebhook(`${name}: no script specified`)
      }
    }
  }

  // ── Non-interactive: spawn claude -p ──────────────────────────────

  private spawnClaudeP(channelId: string, name: string, prompt: string): void {
    const proc = spawn('claude', ['-p', '--dangerously-skip-permissions', '--no-session-persistence', '--plugin-dir', '/tmp/claude2bot-noplugin'], {
      env: { ...process.env, CLAUDE2BOT_NO_CONNECT: '1' },
    })

    const wrappedPrompt = prompt + '\n\nIMPORTANT: Output your final result as plain text to stdout. Do NOT use any reply, messaging, or channel tools. Just print the result.'
    proc.stdin.write(wrappedPrompt)
    proc.stdin.end()

    let stdout = ''
    if (proc.stdout) proc.stdout.on('data', (d: Buffer) => { stdout += d })

    proc.on('close', (code: number | null) => {
      const lines = stdout.trim().split('\n')
      const result = lines.slice(-30).join('\n').substring(0, 1900)
      if (result && this.sendFn) {
        this.sendFn(channelId, result).catch(err =>
          logWebhook(`${name} relay failed: ${err}`),
        )
      }
      logWebhook(`${name} claude -p exited (${code})`)
    })

    proc.on('error', (err: Error) => {
      logWebhook(`${name} claude -p error: ${err}`)
    })
  }

  // ── Script execution ──────────────────────────────────────────────

  private runScript(scriptName: string, channelId: string, name: string): void {
    ensureDir(SCRIPTS_DIR)

    const scriptPath = normalize(join(SCRIPTS_DIR, scriptName))
    if (!scriptPath.startsWith(SCRIPTS_DIR)) {
      logWebhook(`${name}: script path escapes scripts directory: ${scriptName}`)
      return
    }

    const ext = extname(scriptName).toLowerCase()
    const cmd = ext === '.py' ? 'python3' : 'node'

    const proc = spawn(cmd, [scriptPath], {
      timeout: 30_000,
      env: { ...process.env },
    })

    let stdout = ''
    let stderr = ''
    if (proc.stdout) proc.stdout.on('data', (d: Buffer) => { stdout += d })
    if (proc.stderr) proc.stderr.on('data', (d: Buffer) => { stderr += d })

    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        logWebhook(`${name} script exited ${code}: ${stderr.substring(0, 500)}`)
        return
      }
      const result = stdout.substring(0, 2000)
      if (result && this.sendFn) {
        this.sendFn(channelId, result).catch(err =>
          logWebhook(`${name} script relay failed: ${err}`),
        )
      }
    })

    proc.on('error', (err: Error) => {
      logWebhook(`${name} script spawn error: ${err.message}`)
    })
  }

  // ── Pending / Batch ───────────────────────────────────────────────

  private savePending(name: string, prompt: string): void {
    const pendingDir = join(WEBHOOKS_DIR, name, 'pending')
    ensureDir(pendingDir)

    const timestamp = Date.now()
    const file = join(pendingDir, `${timestamp}.json`)
    const data = { prompt, timestamp, endpoint: name }
    writeFileSync(file, JSON.stringify(data, null, 2))
    logWebhook(`${name}: saved pending ${timestamp}`)
  }

  private processBatch(): void {
    for (const [name, endpoint] of Object.entries(this.config.endpoints)) {
      if (endpoint.mode !== 'batch') continue

      const pendingDir = join(WEBHOOKS_DIR, name, 'pending')
      const processedDir = join(WEBHOOKS_DIR, name, 'processed')
      ensureDir(pendingDir)
      ensureDir(processedDir)

      let files: string[]
      try {
        files = readdirSync(pendingDir).filter(f => f.endsWith('.json')).sort()
      } catch {
        continue
      }

      if (files.length === 0) continue

      // Read and combine all pending prompts
      const prompts: string[] = []
      for (const file of files) {
        try {
          const content = readFileSync(join(pendingDir, file), 'utf8')
          const data = JSON.parse(content)
          prompts.push(data.prompt)
        } catch (err) {
          logWebhook(`${name} batch read error: ${err}`)
        }
      }

      if (prompts.length === 0) continue

      // Combine prompts with separator
      const combined = prompts.length === 1
        ? prompts[0]
        : `The following ${prompts.length} webhook events need processing:\n\n` +
          prompts.map((p, i) => `--- Event ${i + 1} ---\n${p}`).join('\n\n')

      // Dispatch combined prompt
      this.dispatch(name, endpoint, combined)

      // Move files to processed
      for (const file of files) {
        try {
          renameSync(join(pendingDir, file), join(processedDir, file))
        } catch (err) {
          logWebhook(`${name} batch move error: ${err}`)
        }
      }

      logWebhook(`${name}: batch processed ${files.length} items`)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private resolveChannel(label: string): string {
    return this.channelsConfig?.channels[label]?.id ?? label
  }

  /** Get status info for all endpoints */
  getStatus(): Array<{ name: string; mode: string; exec: string; channel: string; pending: number }> {
    return Object.entries(this.config.endpoints).map(([name, ep]) => {
      let pending = 0
      const dir = join(WEBHOOKS_DIR, name, 'pending')
      try { pending = readdirSync(dir).filter(f => f.endsWith('.json')).length } catch { /* dir may not exist */ }
      return { name, mode: ep.mode, exec: ep.exec, channel: ep.channel, pending }
    })
  }

  /** Get the webhook URL for an endpoint */
  getUrl(name: string): string {
    if (this.config.ngrokDomain) {
      return `https://${this.config.ngrokDomain}/webhook/${name}`
    }
    return `http://localhost:${this.config.port}/webhook/${name}`
  }
}
