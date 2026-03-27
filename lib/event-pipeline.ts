/**
 * Event pipeline — receives raw events from sources, applies parsing/filtering,
 * and enqueues them for execution.
 */

import type { EventRule, EventsConfig, ChannelsConfig } from '../backends/types.js'
import { EventQueue, type QueueItem } from './event-queue.js'
import { applyParser, evaluateFilter, applyTemplate, logEvent } from './executor.js'

export class EventPipeline {
  private rules: EventRule[]
  private queue: EventQueue

  constructor(config: EventsConfig | undefined, channelsConfig?: ChannelsConfig) {
    this.rules = (config?.rules ?? []).filter(r => r.enabled !== false)
    this.queue = new EventQueue(config?.queue, channelsConfig)
  }

  getQueue(): EventQueue { return this.queue }

  start(): void { this.queue.start() }
  stop(): void { this.queue.stop() }

  reloadConfig(config: EventsConfig | undefined, channelsConfig?: ChannelsConfig): void {
    this.rules = (config?.rules ?? []).filter(r => r.enabled !== false)
    this.queue.reloadConfig(config?.queue, channelsConfig)
  }

  // ── Source: webhook ───────────────────────────────────────────────

  /** Handle an incoming webhook event */
  handleWebhook(endpointName: string, body: any, headers: Record<string, string>): boolean {
    const rule = this.rules.find(r => r.source === 'webhook' && r.name === endpointName)
    if (!rule) return false

    // Parse
    const data = applyParser(rule.parser, body, headers)

    // Filter
    if (rule.filter && !evaluateFilter(rule.filter, data)) {
      return true // matched rule but filtered out — not an error
    }

    // Template → enqueue
    const prompt = applyTemplate(rule.execute, data)
    this.enqueue(rule, prompt)
    return true
  }

  // ── Source: watcher ───────────────────────────────────────────────

  /** Handle an incoming chat message — check all watcher rules */
  handleMessage(text: string, user: string, channelId: string, isBot: boolean): void {
    if (isBot) return // prevent self-triggering loops

    for (const rule of this.rules) {
      if (rule.source !== 'watcher') continue
      if (!rule.match) continue

      try {
        const regex = new RegExp(rule.match, 'i')
        if (!regex.test(text)) continue
      } catch {
        logEvent(`${rule.name}: invalid match regex: ${rule.match}`)
        continue
      }

      const data: Record<string, string> = {
        text,
        user,
        channel: channelId,
        match: text.match(new RegExp(rule.match, 'i'))?.[0] ?? '',
      }

      const prompt = applyTemplate(rule.execute, data)
      logEvent(`${rule.name}: watcher matched "${rule.match}" from ${user}`)
      this.enqueue(rule, prompt)
    }
  }

  // ── Source: file (placeholder) ────────────────────────────────────

  /** Handle a file change event */
  handleFileChange(filePath: string, eventType: string): void {
    for (const rule of this.rules) {
      if (rule.source !== 'file') continue
      if (!rule.path) continue

      // Simple glob-like matching
      const pattern = rule.path.replace(/\*/g, '.*')
      if (!new RegExp(pattern).test(filePath)) continue

      const data: Record<string, string> = {
        path: filePath,
        event: eventType,
        filename: filePath.split('/').pop() ?? '',
      }

      const prompt = applyTemplate(rule.execute, data)
      logEvent(`${rule.name}: file ${eventType}: ${filePath}`)
      this.enqueue(rule, prompt)
    }
  }

  // ── Common enqueue ────────────────────────────────────────────────

  private enqueue(rule: EventRule, prompt: string): void {
    const item: QueueItem = {
      name: rule.name,
      source: rule.source,
      priority: rule.priority,
      prompt,
      exec: rule.exec,
      channel: rule.channel,
      script: rule.script,
      timestamp: Date.now(),
    }
    this.queue.enqueue(item)
  }

  // ── Status ────────────────────────────────────────────────────────

  getRules(): EventRule[] { return this.rules }

  getStatus(): { rules: number; queue: { pending: number; running: number } } {
    return {
      rules: this.rules.length,
      queue: this.queue.getStatus(),
    }
  }
}
