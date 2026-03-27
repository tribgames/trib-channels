/**
 * Built-in scheduler — handles three schedule categories:
 *
 * - nonInteractive: spawn claude -p at fixed times
 * - interactive: inject prompt into current session at fixed times
 * - proactive: bot-initiated conversation at random intervals based on frequency
 */

import { spawn } from 'child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join, isAbsolute, extname, normalize } from 'path'
import { tmpdir } from 'os'
import type { TimedSchedule, ProactiveConfig, ProactiveItem, ChannelsConfig, BotConfig } from '../backends/types.js'
import { DATA_DIR } from './config.js'
import { isHoliday } from './holidays.js'
import { tryRead } from './settings.js'

const SCRIPTS_DIR = join(DATA_DIR, 'scripts')

const TICK_INTERVAL = 60_000 // 1 minute

/** Callback to inject a prompt into the current session */
type InjectFn = (channelId: string, name: string, promptContent: string) => void

/** Callback to send a message via the main session's backend */
type SendFn = (channelId: string, text: string) => Promise<void>

// ── Frequency → daily count / idle guard mapping ─────────────────────

const FREQUENCY_MAP: Record<number, { daily: number; idleMinutes: number }> = {
  1: { daily: 3, idleMinutes: 180 },  // 3/day, 3h guard
  2: { daily: 5, idleMinutes: 120 },  // 5/day, 2h guard
  3: { daily: 7, idleMinutes: 90 },   // 7/day, 1.5h guard
  4: { daily: 10, idleMinutes: 60 },  // 10/day, 1h guard
  5: { daily: 15, idleMinutes: 30 },  // 15/day, 30m guard
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

  // Activity tracking
  private lastActivity = 0                          // timestamp of last inbound message

  // Proactive state
  private proactiveSlots: number[] = []             // minute-of-day slots for today
  private proactiveSlotsDate = ''                   // "YYYY-MM-DD" when slots were generated
  private proactiveLastFire = 0                     // timestamp of last proactive fire
  private proactiveFiredToday = 0                   // count of proactive fires today
  private deferred = new Map<string, number>()       // name -> deferred-until timestamp
  private skippedToday = new Set<string>()           // names skipped for today
  private holidayCountry: string | null = null       // ISO country code for holiday check
  private holidayChecked = ''                        // "YYYY-MM-DD" last checked date
  private todayIsHoliday = false                     // cached result for today
  private quietSchedule: string | null = null        // global quiet hours "HH:MM-HH:MM"

  constructor(
    nonInteractive: TimedSchedule[],
    interactive: TimedSchedule[],
    proactive: ProactiveConfig | undefined,
    channelsConfig: ChannelsConfig | undefined,
    promptsDir?: string,
    botConfig?: BotConfig,
  ) {
    this.nonInteractive = nonInteractive.filter(s => s.enabled !== false)
    this.interactive = interactive.filter(s => s.enabled !== false)
    this.proactive = proactive ?? null
    this.channelsConfig = channelsConfig ?? null
    this.promptsDir = promptsDir ?? join(DATA_DIR, 'prompts')
    this.holidayCountry = botConfig?.quiet?.holidays ?? null
    this.quietSchedule = botConfig?.quiet?.schedule ?? null
  }

  setInjectHandler(fn: InjectFn): void {
    this.injectFn = fn
  }

  setSendHandler(fn: SendFn): void {
    this.sendFn = fn
  }

  noteActivity(): void {
    this.lastActivity = Date.now()
  }

  /** Defer a schedule by N minutes from now */
  defer(name: string, minutes: number): void {
    this.deferred.set(name, Date.now() + minutes * 60_000)
  }

  /** Skip a schedule for the rest of today */
  skipToday(name: string): void {
    this.skippedToday.add(name)
  }

  /** Check if a schedule should be skipped (deferred or skipped today) */
  shouldSkip(name: string): boolean {
    if (this.skippedToday.has(name)) return true
    const until = this.deferred.get(name)
    if (until && Date.now() < until) return true
    if (until && Date.now() >= until) this.deferred.delete(name)
    return false
  }

  /** Get current session state based on activity */
  getSessionState(): 'idle' | 'active' | 'recent' {
    if (this.lastActivity === 0) return 'idle'
    const elapsed = Date.now() - this.lastActivity
    if (elapsed < 2 * 60_000) return 'active'       // within 2 minutes
    if (elapsed < 5 * 60_000) return 'recent'        // within 5 minutes
    return 'idle'
  }

  /** Get time context for prompt enrichment */
  getTimeContext(): { hour: number; dayOfWeek: string; isWeekend: boolean } {
    const now = new Date()
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const dow = now.getDay()
    return {
      hour: now.getHours(),
      dayOfWeek: days[dow],
      isWeekend: dow === 0 || dow === 6,
    }
  }

  /** Wrap prompt with session context metadata */
  wrapPrompt(name: string, prompt: string, type: 'interactive' | 'proactive'): string {
    const state = this.getSessionState()
    const time = this.getTimeContext()
    const header = [
      `[schedule: ${name} | type: ${type} | session: ${state}]`,
      `[time: ${time.dayOfWeek} ${String(time.hour).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')} | weekend: ${time.isWeekend}]`,
      `Before starting any work, briefly tell the user what you're about to do in one short sentence.`,
    ].join('\n')
    return `${header}\n\n${prompt}`
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

  restart(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    try { unlinkSync(Scheduler.SCHEDULER_LOCK) } catch {}
    this.start()
  }

  reloadConfig(
    nonInteractive: TimedSchedule[],
    interactive: TimedSchedule[],
    proactive: ProactiveConfig | undefined,
    channelsConfig: ChannelsConfig | undefined,
    promptsDir?: string,
    botConfig?: BotConfig,
  ): void {
    this.nonInteractive = nonInteractive.filter(s => s.enabled !== false)
    this.interactive = interactive.filter(s => s.enabled !== false)
    this.proactive = proactive ?? null
    this.channelsConfig = channelsConfig ?? null
    this.promptsDir = promptsDir ?? join(DATA_DIR, 'prompts')
    this.holidayCountry = botConfig?.quiet?.holidays ?? null
    this.quietSchedule = botConfig?.quiet?.schedule ?? null
    this.holidayChecked = ''
    this.todayIsHoliday = false
    this.proactiveSlots = []
    this.proactiveSlotsDate = ''
    this.proactiveFiredToday = 0
    this.restart()
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
      if (this.running.has(name)) return `"${name}" is already running`
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
        // Check active conversation guard even for manual triggers
        if (this.lastActivity > 0 && (Date.now() - this.lastActivity) < 5 * 60_000) {
          return `skipped proactive "${topic}" — conversation active (last activity ${Math.floor((Date.now() - this.lastActivity) / 1000)}s ago)`
        }
        this.fireProactive(item)
        return `triggered proactive "${topic}"`
      }
    }

    return `schedule "${name}" not found`
  }

  // ── Tick ─────────────────────────────────────────────────────────────

  private tick(): void {
    this.tickAsync().catch(err =>
      process.stderr.write(`claude2bot scheduler: tick error: ${err}\n`),
    )
  }

  private async tickAsync(): Promise<void> {
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const key = `${dateStr}T${hhmm}`
    const dow = now.getDay()
    const isWeekend = dow === 0 || dow === 6

    // Holiday check — once per day, cached
    if (this.holidayCountry && this.holidayChecked !== dateStr) {
      this.holidayChecked = dateStr
      try {
        this.todayIsHoliday = await isHoliday(now, this.holidayCountry)
        if (this.todayIsHoliday) {
          process.stderr.write(`claude2bot scheduler: today (${dateStr}) is a holiday — weekday schedules will be skipped\n`)
        }
      } catch (err) {
        process.stderr.write(`claude2bot scheduler: holiday check failed: ${err}\n`)
        this.todayIsHoliday = false
      }
    }

    // Timed schedules (non-interactive + interactive)
    const allTimed: Array<{ schedule: TimedSchedule; type: 'non-interactive' | 'interactive' }> = [
      ...this.nonInteractive.map(s => ({ schedule: s, type: 'non-interactive' as const })),
      ...this.interactive.map(s => ({ schedule: s, type: 'interactive' as const })),
    ]

    for (const { schedule: s, type } of allTimed) {
      // Day-of-week check (daily, weekday, weekend, or comma-separated like "mon,wed,fri")
      const days = s.days ?? 'daily'
      if (!this.matchesDays(days, dow, isWeekend)) continue

      // Holiday skip: explicit per-schedule (skipHolidays) or weekday backward compat
      if (this.todayIsHoliday && (s.skipHolidays || days === 'weekday')) {
        const skipKey = `holiday:${dateStr}:${s.name}`
        if (!this.lastFired.has(skipKey)) {
          this.lastFired.set(skipKey, dateStr)
          process.stderr.write(`claude2bot scheduler: skipping "${s.name}" — public holiday\n`)
        }
        continue
      }

      // Per-schedule DND: skip during global quiet hours if dnd is true
      if (s.dnd && this.isQuietHours(now)) continue

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
      if (this.shouldSkip(s.name)) continue

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
    if (this.isQuietHours(now)) return

    // Generate daily random slots if new day
    if (this.proactiveSlotsDate !== dateStr) {
      this.generateDailySlots(dateStr)
    }

    const minuteOfDay = now.getHours() * 60 + now.getMinutes()
    if (!this.proactiveSlots.includes(minuteOfDay)) return

    // Session state guard — only fire when idle (no activity for 5+ minutes)
    if (this.getSessionState() !== 'idle') return

    // Frequency-based cooldown
    const freq = Math.max(1, Math.min(5, this.proactive.frequency))
    const { idleMinutes } = FREQUENCY_MAP[freq]
    const elapsed = (Date.now() - this.proactiveLastFire) / 60_000
    if (this.proactiveLastFire > 0 && elapsed < idleMinutes) return

    // Pick a random topic, skip if deferred/skipped
    const items = this.proactive.items
    const item = items[Math.floor(Math.random() * items.length)]
    if (this.shouldSkip(`proactive:${item.topic}`)) return
    this.fireProactive(item)
  }

  /** Day abbreviation → JS day number (0=Sun...6=Sat) */
  private static DAY_ABBRS: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  }

  /** Check if today matches the schedule's days setting */
  private matchesDays(days: string, dow: number, isWeekend: boolean): boolean {
    if (days === 'daily') return true
    if (days === 'weekday') return !isWeekend
    if (days === 'weekend') return isWeekend
    // Comma-separated day abbreviations: "mon,wed,fri"
    const dayList = days.split(',').map(d => d.trim().toLowerCase())
    return dayList.some(d => Scheduler.DAY_ABBRS[d] === dow)
  }

  /** Check if current time is within global quiet hours (quiet.schedule) */
  private isQuietHours(now: Date): boolean {
    if (!this.quietSchedule) return false
    const parts = this.quietSchedule.split('-')
    if (parts.length !== 2) return false
    const [start, end] = parts
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    if (start > end) return hhmm >= start || hhmm < end
    return hhmm >= start && hhmm < end
  }

  private generateDailySlots(dateStr: string): void {
    this.proactiveSlotsDate = dateStr
    this.proactiveFiredToday = 0
    this.skippedToday.clear()
    this.deferred.clear()

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
    const execMode = schedule.exec ?? 'prompt'

    // For script/script+prompt modes, run script first
    if (execMode === 'script' || execMode === 'script+prompt') {
      if (!schedule.script) {
        process.stderr.write(`claude2bot scheduler: no script specified for "${schedule.name}"\n`)
        return
      }

      // Skip if already running
      if (this.running.has(schedule.name)) return
      this.running.add(schedule.name)

      const channelId = this.resolveChannel(schedule.channel)
      process.stderr.write(`claude2bot scheduler: firing ${schedule.name} (${type}, exec=${execMode})\n`)

      try {
        const scriptResult = await this.runScript(schedule.script)

        if (execMode === 'script') {
          // Direct send: script stdout → Discord
          this.running.delete(schedule.name)
          if (scriptResult && this.sendFn) {
            await this.sendFn(channelId, scriptResult).catch(err =>
              process.stderr.write(`claude2bot scheduler: ${schedule.name} relay failed: ${err}\n`),
            )
          }
          process.stderr.write(`claude2bot scheduler: ${schedule.name} script done\n`)
          return
        }

        // script+prompt: script result → embed in prompt → Claude
        const prompt = this.loadPrompt(schedule.prompt ?? `${schedule.name}.md`)
        if (!prompt) {
          this.running.delete(schedule.name)
          process.stderr.write(`claude2bot scheduler: prompt not found for "${schedule.name}"\n`)
          return
        }

        const combinedPrompt = `${prompt}\n\n---\n## Script Output\n\`\`\`\n${scriptResult}\n\`\`\``
        this.running.delete(schedule.name)
        // Re-fire as a normal prompt schedule with the combined content
        await this.fireTimedPrompt(schedule, type, combinedPrompt, channelId)
        return
      } catch (err) {
        this.running.delete(schedule.name)
        process.stderr.write(`claude2bot scheduler: ${schedule.name} script error: ${err}\n`)
        return
      }
    }

    // Default: prompt mode
    const prompt = this.loadPrompt(schedule.prompt ?? `${schedule.name}.md`)
    if (!prompt) {
      process.stderr.write(`claude2bot scheduler: prompt not found for "${schedule.name}"\n`)
      return
    }

    const channelId = this.resolveChannel(schedule.channel)
    await this.fireTimedPrompt(schedule, type, prompt, channelId)
  }

  /** Fire a timed schedule with the given prompt content */
  private async fireTimedPrompt(
    schedule: TimedSchedule,
    type: 'non-interactive' | 'interactive',
    prompt: string,
    channelId: string,
  ): Promise<void> {
    process.stderr.write(`claude2bot scheduler: firing ${schedule.name} (${type})\n`)

    if (type === 'interactive') {
      const wrapped = this.wrapPrompt(schedule.name, prompt, 'interactive')
      if (this.injectFn) this.injectFn(channelId, schedule.name, wrapped)
      return
    }

    // Skip if already running (prevent duplicate from manual + auto trigger)
    if (this.running.has(schedule.name)) return
    this.running.add(schedule.name)

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

  // ── Script execution ────────────────────────────────────────────────

  /** Run a script from the scripts directory. Returns stdout (max 2000 chars). */
  private runScript(scriptName: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Ensure scripts directory exists
      if (!existsSync(SCRIPTS_DIR)) {
        mkdirSync(SCRIPTS_DIR, { recursive: true })
      }

      // Security: resolve path and verify it stays within SCRIPTS_DIR
      const scriptPath = normalize(join(SCRIPTS_DIR, scriptName))
      if (!scriptPath.startsWith(SCRIPTS_DIR)) {
        reject(new Error(`script path escapes scripts directory: ${scriptName}`))
        return
      }

      if (!existsSync(scriptPath)) {
        reject(new Error(`script not found: ${scriptPath}`))
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
          reject(new Error(`script exited with code ${code}: ${stderr.substring(0, 500)}`))
          return
        }
        // Truncate to 2000 chars (Discord limit)
        resolve(stdout.substring(0, 2000))
      })

      proc.on('error', (err: Error) => {
        reject(new Error(`script spawn error: ${err.message}`))
      })
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
      const feedback = tryRead(feedbackPath)
      if (feedback) {
        prompt = `${topicPrompt}\n\n---\n## Proactive Feedback History\n${feedback}`
      }
    }

    process.stderr.write(`claude2bot scheduler: firing proactive "${item.topic}"\n`)
    this.proactiveLastFire = Date.now()
    this.proactiveFiredToday++
    this.lastFired.set(`proactive:${item.topic}`, new Date().toISOString().slice(0, 16))

    prompt = this.wrapPrompt(`proactive:${item.topic}`, prompt, 'proactive')
    if (this.injectFn) this.injectFn(this.resolveChannel(item.channel), `proactive:${item.topic}`, prompt)
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /** Resolve a channel label to its platform ID via channelsConfig, fallback to raw value */
  private resolveChannel(label: string): string {
    return this.channelsConfig?.channels[label]?.id ?? label
  }

  private loadPrompt(nameOrPath: string): string | null {
    const full = isAbsolute(nameOrPath) ? nameOrPath : join(this.promptsDir, nameOrPath)
    return tryRead(full)
  }

}
