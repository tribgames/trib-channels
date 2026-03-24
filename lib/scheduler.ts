/**
 * Built-in scheduler — handles three schedule categories:
 *
 * - nonInteractive: spawn claude -p at fixed times
 * - interactive: inject prompt into current session at fixed times
 * - proactive: bot-initiated conversation at random intervals based on frequency
 */

import { spawn } from 'child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { join, isAbsolute } from 'path'
import { tmpdir } from 'os'
import type { TimedSchedule, ProactiveConfig, ProactiveItem, ChannelsConfig } from '../backends/types.js'
import { DATA_DIR } from './config.js'

const TICK_INTERVAL = 60_000 // 1 minute

/** Callback to inject a prompt into the current session */
export type InjectFn = (channelId: string, name: string, promptContent: string) => void

/** Callback to send a message via the main session's backend */
export type SendFn = (channelId: string, text: string) => Promise<void>

// ── Frequency → daily count / idle guard mapping ─────────────────────

const FREQUENCY_MAP: Record<number, { daily: number; idleMinutes: number }> = {
  1: { daily: 1, idleMinutes: 480 },  // ~1/day, 8h guard
  2: { daily: 2, idleMinutes: 240 },  // ~2/day, 4h guard
  3: { daily: 4, idleMinutes: 120 },  // ~4/day, 2h guard
  4: { daily: 7, idleMinutes: 60 },   // ~7/day, 1h guard
  5: { daily: 10, idleMinutes: 30 },  // ~10/day, 30m guard
}

export class Scheduler {
  private nonInteractive: TimedSchedule[]
  private interactive: TimedSchedule[]
  private proactive: ProactiveConfig | null
  private channelsConfig: ChannelsConfig | null
  private promptsDir: string
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private lastFired = new Map<string, string>()    // name -> "YYYY-MM-DDTHH:MM"
  private running = new Set<string>()
  private injectFn: InjectFn | null = null
  private sendFn: SendFn | null = null

  // Proactive state
  private proactiveSlots: number[] = []             // minute-of-day slots for today
  private proactiveSlotsDate = ''                   // "YYYY-MM-DD" when slots were generated
  private proactiveLastFire = 0                     // timestamp of last proactive fire
  private proactiveFiredToday = 0                   // count of proactive fires today

  constructor(
    nonInteractive: TimedSchedule[],
    interactive: TimedSchedule[],
    proactive: ProactiveConfig | undefined,
    channelsConfig: ChannelsConfig | undefined,
    promptsDir?: string,
  ) {
    this.nonInteractive = nonInteractive.filter(s => s.enabled !== false)
    this.interactive = interactive.filter(s => s.enabled !== false)
    this.proactive = proactive ?? null
    this.channelsConfig = channelsConfig ?? null
    this.promptsDir = promptsDir ?? join(DATA_DIR, 'prompts')
  }

  setInjectHandler(fn: InjectFn): void {
    this.injectFn = fn
  }

  setSendHandler(fn: SendFn): void {
    this.sendFn = fn
  }

  private static SCHEDULER_LOCK = join(tmpdir(), 'claude2bot-scheduler.lock')

  start(): void {
    if (this.tickTimer) return
    const total = this.nonInteractive.length + this.interactive.length
      + (this.proactive?.items.length ?? 0)
    if (total === 0) {
      process.stderr.write('claude2bot scheduler: no schedules configured\n')
      return
    }

    // Scheduler-level lock: only one session runs the scheduler
    if (existsSync(Scheduler.SCHEDULER_LOCK)) {
      try {
        const content = readFileSync(Scheduler.SCHEDULER_LOCK, 'utf8')
        const pid = parseInt(content.split('\n')[0])
        // Check if the process is still alive
        try { process.kill(pid, 0); process.stderr.write(`claude2bot scheduler: another session (PID ${pid}) owns the scheduler, skipping\n`); return } catch { /* dead, take over */ }
      } catch { /* can't read, take over */ }
    }
    writeFileSync(Scheduler.SCHEDULER_LOCK, `${process.pid}\n${Date.now()}`)
    process.on('exit', () => { try { unlinkSync(Scheduler.SCHEDULER_LOCK) } catch { /* ignore */ } })

    process.stderr.write(`claude2bot scheduler: ${this.nonInteractive.length} non-interactive, ${this.interactive.length} interactive, ${this.proactive?.items.length ?? 0} proactive\n`)
    this.tick()
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL)
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  getStatus() {
    const result: Array<{
      name: string; time: string; days: string; type: string
      running: boolean; lastFired: string | null
    }> = []

    for (const s of this.nonInteractive) {
      result.push({
        name: s.name, time: s.time, days: s.days ?? 'daily',
        type: 'non-interactive', running: false,
        lastFired: this.lastFired.get(s.name) ?? null,
      })
    }
    for (const s of this.interactive) {
      result.push({
        name: s.name, time: s.time, days: s.days ?? 'daily',
        type: 'interactive', running: false,
        lastFired: this.lastFired.get(s.name) ?? null,
      })
    }
    if (this.proactive) {
      for (const item of this.proactive.items) {
        result.push({
          name: `proactive:${item.topic}`, time: `freq=${this.proactive.frequency}`,
          days: 'daily', type: 'proactive', running: false,
          lastFired: this.lastFired.get(`proactive:${item.topic}`) ?? null,
        })
      }
    }
    return result
  }

  async triggerManual(name: string): Promise<string> {
    // Check timed schedules
    const timed = [...this.nonInteractive, ...this.interactive].find(e => e.name === name)
    if (timed) {
      const isNonInteractive = this.nonInteractive.includes(timed)
      // Set lastFired to prevent duplicate with automatic tick
      const now = new Date()
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      this.lastFired.set(name, `${dateStr}T${hhmm}`)
      await this.fireTimed(timed, isNonInteractive ? 'non-interactive' : 'interactive')
      return `triggered "${name}"`
    }

    // Check proactive topics
    if (this.proactive) {
      const topic = name.replace(/^proactive:/, '')
      const item = this.proactive.items.find(i => i.topic === topic)
      if (item) {
        this.fireProactive(item)
        return `triggered proactive "${topic}"`
      }
    }

    return `schedule "${name}" not found`
  }

  // ── Tick ─────────────────────────────────────────────────────────────

  private tick(): void {
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const key = `${dateStr}T${hhmm}`
    const dow = now.getDay()
    const isWeekend = dow === 0 || dow === 6

    // Timed schedules (non-interactive + interactive)
    const allTimed: Array<{ schedule: TimedSchedule; type: 'non-interactive' | 'interactive' }> = [
      ...this.nonInteractive.map(s => ({ schedule: s, type: 'non-interactive' as const })),
      ...this.interactive.map(s => ({ schedule: s, type: 'interactive' as const })),
    ]

    for (const { schedule: s, type } of allTimed) {
      if ((s.days ?? 'daily') === 'weekday' && isWeekend) continue

      // Determine if this schedule should fire
      const intervalMatch = s.time.match(/^every(\d+)m$/)
      let shouldFire = false

      if (intervalMatch) {
        // Interval-based: fire if enough time elapsed since last run
        const intervalMs = parseInt(intervalMatch[1]) * 60_000
        const lastKey = this.lastFired.get(s.name)
        const lastTime = lastKey ? new Date(lastKey).getTime() : 0
        shouldFire = (Date.now() - lastTime) >= intervalMs
      } else if (s.time === 'hourly') {
        shouldFire = now.getMinutes() === 0 && this.lastFired.get(s.name) !== key
      } else {
        // Fixed time "HH:MM"
        shouldFire = s.time === hhmm && this.lastFired.get(s.name) !== key
      }

      if (!shouldFire) continue

      this.lastFired.set(s.name, now.toISOString())
      this.fireTimed(s, type).catch(err =>
        process.stderr.write(`claude2bot scheduler: ${s.name} failed: ${err}\n`),
      )
    }

    // Proactive schedules
    this.tickProactive(now, dateStr)
  }

  // ── Proactive tick ──────────────────────────────────────────────────

  private tickProactive(now: Date, dateStr: string): void {
    if (!this.proactive || this.proactive.items.length === 0) return

    // DND check
    if (this.isDnd(now)) return

    // Generate daily random slots if new day
    if (this.proactiveSlotsDate !== dateStr) {
      this.generateDailySlots(dateStr)
    }

    const minuteOfDay = now.getHours() * 60 + now.getMinutes()
    if (!this.proactiveSlots.includes(minuteOfDay)) return

    // Idle guard check
    const freq = Math.max(1, Math.min(5, this.proactive.frequency))
    const { idleMinutes } = FREQUENCY_MAP[freq]
    const elapsed = (Date.now() - this.proactiveLastFire) / 60_000
    if (this.proactiveLastFire > 0 && elapsed < idleMinutes) return

    // Pick a random topic
    const items = this.proactive.items
    const item = items[Math.floor(Math.random() * items.length)]
    this.fireProactive(item)
  }

  /** Check if current time is within DND (do-not-disturb) window */
  private isDnd(now: Date): boolean {
    const dndStart = this.proactive?.dndStart
    const dndEnd = this.proactive?.dndEnd
    if (!dndStart || !dndEnd) return false
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    // Handle overnight DND (e.g. 23:00 - 07:00)
    if (dndStart > dndEnd) return hhmm >= dndStart || hhmm < dndEnd
    return hhmm >= dndStart && hhmm < dndEnd
  }

  private generateDailySlots(dateStr: string): void {
    this.proactiveSlotsDate = dateStr
    this.proactiveFiredToday = 0

    if (!this.proactive) { this.proactiveSlots = []; return }

    const freq = Math.max(1, Math.min(5, this.proactive.frequency))
    const { daily } = FREQUENCY_MAP[freq]

    // Generate random minute-of-day slots within waking hours (7:00-22:00 = 420-1320)
    const start = 420   // 07:00
    const end = 1320    // 22:00
    const slots = new Set<number>()
    for (let i = 0; i < daily; i++) {
      slots.add(start + Math.floor(Math.random() * (end - start)))
    }
    this.proactiveSlots = [...slots].sort((a, b) => a - b)
    process.stderr.write(`claude2bot scheduler: proactive slots for ${dateStr}: ${this.proactiveSlots.map(m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`).join(', ')}\n`)
  }

  // ── Fire timed schedule ─────────────────────────────────────────────

  private async fireTimed(
    schedule: TimedSchedule,
    type: 'non-interactive' | 'interactive',
  ): Promise<void> {
    const prompt = this.loadPrompt(schedule.prompt ?? `${schedule.name}.md`)
    if (!prompt) {
      process.stderr.write(`claude2bot scheduler: prompt not found for "${schedule.name}"\n`)
      return
    }

    process.stderr.write(`claude2bot scheduler: firing ${schedule.name} (${type})\n`)

    if (type === 'interactive') {
      if (this.injectFn) this.injectFn(this.resolveChannel(schedule.channel), schedule.name, prompt)
      return
    }

    // Skip if already running (prevent duplicate from manual + auto trigger)
    if (this.running.has(schedule.name)) return
    this.running.add(schedule.name)

    const channelId = this.resolveChannel(schedule.channel)

    // CLAUDE2BOT_NO_CONNECT prevents child from connecting Discord bot (avoids WebSocket conflict)
    const proc = spawn('claude', ['-p', '--dangerously-skip-permissions', '--no-session-persistence'], {
      env: { ...process.env, CLAUDE2BOT_NO_CONNECT: '1' },
    })

    const wrappedPrompt = prompt + '\n\nIMPORTANT: Output your final result as plain text to stdout. Do NOT use any reply, messaging, or channel tools. Just print the result.'
    proc.stdin.write(wrappedPrompt)
    proc.stdin.end()

    let stdout = ''
    if (proc.stdout) proc.stdout.on('data', (d: Buffer) => { stdout += d })

    proc.on('close', (code: number | null) => {
      this.running.delete(schedule.name)
      // Only relay the last portion of stdout (skip internal tool logs, keep final result)
      const lines = stdout.trim().split('\n')
      // Take last 30 lines max, truncate to 1900 chars
      const result = lines.slice(-30).join('\n').substring(0, 1900)
      if (result && this.sendFn) {
        this.sendFn(channelId, result).catch(err =>
          process.stderr.write(`claude2bot scheduler: ${schedule.name} relay failed: ${err}\n`),
        )
      }
      process.stderr.write(`claude2bot scheduler: ${schedule.name} exited (${code})\n`)
    })
    proc.on('error', (err: Error) => {
      this.running.delete(schedule.name)
      process.stderr.write(`claude2bot scheduler: ${schedule.name} error: ${err}\n`)
    })
  }

  // ── Fire proactive ──────────────────────────────────────────────────

  private fireProactive(item: ProactiveItem): void {
    const topicPrompt = this.loadPrompt(`${item.topic}.md`)
    if (!topicPrompt) {
      process.stderr.write(`claude2bot scheduler: proactive prompt not found for "${item.topic}"\n`)
      return
    }

    // Replace template variables in prompt
    const channelId = this.resolveChannel(item.channel)
    let prompt = topicPrompt.replace(/\{\{CHAT_ID\}\}/g, channelId)

    // Merge topic prompt + feedback file
    if (this.proactive?.feedback) {
      const feedbackPath = join(DATA_DIR, 'proactive-feedback.md')
      const feedback = this.tryRead(feedbackPath)
      if (feedback) {
        prompt = `${topicPrompt}\n\n---\n## Proactive Feedback History\n${feedback}`
      }
    }

    process.stderr.write(`claude2bot scheduler: firing proactive "${item.topic}"\n`)
    this.proactiveLastFire = Date.now()
    this.proactiveFiredToday++
    this.lastFired.set(`proactive:${item.topic}`, new Date().toISOString().slice(0, 16))

    if (this.injectFn) this.injectFn(this.resolveChannel(item.channel), `proactive:${item.topic}`, prompt)
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /** Resolve a channel label to its platform ID via channelsConfig, fallback to raw value */
  private resolveChannel(label: string): string {
    return this.channelsConfig?.channels[label]?.id ?? label
  }

  private loadPrompt(nameOrPath: string): string | null {
    const full = isAbsolute(nameOrPath) ? nameOrPath : join(this.promptsDir, nameOrPath)
    return this.tryRead(full)
  }

  private tryRead(path: string): string | null {
    try {
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    } catch { return null }
  }

}
