/**
 * Webhook HTTP server — receives external webhook POST requests
 * and routes them to the event pipeline.
 */

import * as http from 'http'
import { join } from 'path'
import type { WebhookConfig, ChannelsConfig } from '../backends/types.js'
import type { EventPipeline } from './event-pipeline.js'
import { DATA_DIR } from './config.js'
import { appendFileSync } from 'fs'

const WEBHOOK_LOG = join(DATA_DIR, 'webhook.log')
function logWebhook(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { process.stderr.write(`claude2bot webhook: ${msg}\n`) } catch { /* EPIPE */ }
  try { appendFileSync(WEBHOOK_LOG, line) } catch { /* best effort */ }
}

// ── WebhookServer ─────────────────────────────────────────────────────

export class WebhookServer {
  private config: WebhookConfig
  private server: http.Server | null = null
  private eventPipeline: EventPipeline | null = null

  constructor(config: WebhookConfig, _channelsConfig: ChannelsConfig | null) {
    this.config = config
  }

  setEventPipeline(pipeline: EventPipeline): void { this.eventPipeline = pipeline }

  // ── HTTP server ───────────────────────────────────────────────────

  start(): void {
    if (this.server) return

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
    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logWebhook(`port ${port} already in use`)
        this.server = null
      }
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    logWebhook('stopped')
  }

  reloadConfig(config: WebhookConfig, _channelsConfig: ChannelsConfig | null): void {
    this.stop()
    this.config = config
    if (config.enabled) this.start()
  }

  // ── Webhook handler ───────────────────────────────────────────────

  private handleWebhook(
    name: string,
    body: any,
    headers: Record<string, string>,
    res: http.ServerResponse,
  ): void {
    if (this.eventPipeline?.handleWebhook(name, body, headers)) {
      logWebhook(`${name}: routed to event pipeline`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'accepted' }))
      return
    }

    logWebhook(`unknown endpoint: ${name}`)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown endpoint' }))
  }

  /** Get the webhook URL for an endpoint name */
  getUrl(name: string): string {
    if (this.config.ngrokDomain) {
      return `https://${this.config.ngrokDomain}/webhook/${name}`
    }
    return `http://localhost:${this.config.port}/webhook/${name}`
  }
}
