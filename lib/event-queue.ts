/**
 * Event queue — file-based queue with priority processing.
 * All events go through this queue before execution.
 */

import { readdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { EventQueueConfig, ChannelsConfig } from '../backends/types.js'
import { DATA_DIR } from './config.js'
import { ensureDir } from './state-file.js'
import {
  logEvent,
  spawnClaudeP,
  runScript,
  type InjectFn,
  type SendFn,
  type SessionStateGetter,
} from './executor.js'

const QUEUE_DIR = join(DATA_DIR, 'events', 'queue')
const PROCESSED_DIR = join(DATA_DIR, 'events', 'processed')

export interface QueueItem {
  name: string
  source: string
  priority: 'high' | 'normal' | 'low'
  prompt: string
  exec: 'interactive' | 'non-interactive' | 'script'
  channel: string
  script?: string
  timestamp: number
}

export class EventQueue {
  private config: EventQueueConfig
  private channelsConfig: ChannelsConfig | null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private batchTimer: ReturnType<typeof setInterval> | null = null
  private runningCount = 0

  private injectFn: InjectFn | null = null
  private sendFn: SendFn | null = null
  private sessionStateGetter: SessionStateGetter | null = null

  constructor(config?: EventQueueConfig, channelsConfig?: ChannelsConfig) {
    this.config = config ?? {}
    this.channelsConfig = channelsConfig ?? null
  }

  setInjectHandler(fn: InjectFn): void { this.injectFn = fn }
  setSendHandler(fn: SendFn): void { this.sendFn = fn }
  setSessionStateGetter(fn: SessionStateGetter): void { this.sessionStateGetter = fn }

  // ── Lifecycle ─────────────────────────────────────────────────────

  start(): void {
    if (this.tickTimer) return
    ensureDir(QUEUE_DIR)
    ensureDir(PROCESSED_DIR)

    const tickMs = (this.config.tickInterval ?? 60) * 1000
    this.tickTimer = setInterval(() => this.processQueue(), tickMs)

    const batchMs = (this.config.batchInterval ?? 30) * 60_000
    this.batchTimer = setInterval(() => this.processBatch(), batchMs)

    logEvent('queue started')
  }

  stop(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
    if (this.batchTimer) { clearInterval(this.batchTimer); this.batchTimer = null }
  }

  reloadConfig(config?: EventQueueConfig, channelsConfig?: ChannelsConfig): void {
    this.stop()
    this.config = config ?? {}
    this.channelsConfig = channelsConfig ?? null
    this.start()
  }

  // ── Enqueue ───────────────────────────────────────────────────────

  enqueue(item: QueueItem): void {
    ensureDir(QUEUE_DIR)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const filename = `${item.priority === 'high' ? '0' : item.priority === 'normal' ? '1' : '2'}-${id}.json`
    writeFileSync(join(QUEUE_DIR, filename), JSON.stringify(item, null, 2))
    logEvent(`${item.name}: enqueued (${item.priority}, ${item.exec})`)

    // High priority: process immediately
    if (item.priority === 'high') {
      this.processQueue()
    }
  }

  // ── Process queue ─────────────────────────────────────────────────

  private processQueue(): void {
    const maxConcurrent = this.config.maxConcurrent ?? 2

    const files = this.readQueueFiles()
    if (files.length === 0) return

    for (const file of files) {
      const item = this.readItem(file)
      if (!item) continue

      // Skip low priority — handled by batch timer
      if (item.priority === 'low') continue

      // Interactive: only when idle, one at a time
      if (item.exec === 'interactive') {
        const state = this.sessionStateGetter?.() ?? 'idle'
        if (state !== 'idle') continue
        this.executeItem(item, file)
        return // only one interactive at a time
      }

      // Non-interactive/script: respect concurrency limit
      if (this.runningCount >= maxConcurrent) return
      this.executeItem(item, file)
    }
  }

  private processBatch(): void {
    const files = this.readQueueFiles()
    const lowFiles = files.filter(f => f.startsWith('2-'))
    if (lowFiles.length === 0) return

    // Group by rule name
    const groups = new Map<string, { items: QueueItem[]; files: string[] }>()
    for (const file of lowFiles) {
      const item = this.readItem(file)
      if (!item) continue
      const group = groups.get(item.name) ?? { items: [], files: [] }
      group.items.push(item)
      group.files.push(file)
      groups.set(item.name, group)
    }

    for (const [name, group] of groups) {
      const combined = group.items.length === 1
        ? group.items[0].prompt
        : `Batch of ${group.items.length} events:\n\n${group.items.map((it, i) => `--- Event ${i + 1} ---\n${it.prompt}`).join('\n\n')}`

      const batchItem: QueueItem = {
        ...group.items[0],
        prompt: combined,
      }

      logEvent(`${name}: processing batch of ${group.items.length}`)
      this.executeItem(batchItem, null)

      // Move all to processed
      for (const file of group.files) {
        this.moveToProcessed(file, 'batched')
      }
    }
  }

  // ── Execute ───────────────────────────────────────────────────────

  private executeItem(item: QueueItem, file: string | null): void {
    const channelId = this.resolveChannel(item.channel)

    if (item.exec === 'interactive') {
      if (this.injectFn) {
        const wrapped = `<event source="${item.source}" name="${item.name}">\n${item.prompt}\n</event>`
        this.injectFn(channelId, `event:${item.name}`, wrapped)
      }
      if (file) this.moveToProcessed(file, 'done')
      return
    }

    if (item.exec === 'non-interactive') {
      this.runningCount++
      spawnClaudeP(item.name, item.prompt, (result, _code) => {
        this.runningCount--
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(err =>
            logEvent(`${item.name}: send failed: ${err}`),
          )
        }
        logEvent(`${item.name}: result=${result.substring(0, 200)}`)
        if (file) this.moveToProcessed(file, 'done')
      })
      return
    }

    if (item.exec === 'script' && item.script) {
      this.runningCount++
      runScript(item.name, item.script, (result, _code) => {
        this.runningCount--
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(err =>
            logEvent(`${item.name}: send failed: ${err}`),
          )
        }
        logEvent(`${item.name}: result=${result.substring(0, 200)}`)
        if (file) this.moveToProcessed(file, 'done')
      })
      return
    }

    logEvent(`${item.name}: unknown exec type: ${item.exec}`)
    if (file) this.moveToProcessed(file, 'error')
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private readQueueFiles(): string[] {
    try {
      return readdirSync(QUEUE_DIR)
        .filter(f => f.endsWith('.json'))
        .sort() // priority prefix ensures order: 0-high, 1-normal, 2-low
    } catch { return [] }
  }

  private readItem(file: string): QueueItem | null {
    try {
      return JSON.parse(readFileSync(join(QUEUE_DIR, file), 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logEvent(`queue: corrupt file ${file}`)
      }
      return null
    }
  }

  private moveToProcessed(file: string, status: string): void {
    try {
      ensureDir(PROCESSED_DIR)
      renameSync(join(QUEUE_DIR, file), join(PROCESSED_DIR, `${status}-${file}`))
    } catch { /* best effort */ }
  }

  private resolveChannel(label: string): string {
    return this.channelsConfig?.channels[label]?.id ?? label
  }

  /** Get queue status */
  getStatus(): { pending: number; running: number } {
    const pending = this.readQueueFiles().length
    return { pending, running: this.runningCount }
  }
}
