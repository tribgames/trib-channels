/**
 * OutputForwarder — centralized output forwarding from MCP server to Discord.
 * MCP server-centric output architecture. No hooks for text forwarding.
 */

import { readFileSync, existsSync, statSync, watch, openSync, readSync, closeSync, type FSWatcher } from 'fs'
import { execFileSync } from 'child_process'
import { basename, join, resolve } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { formatForDiscord, chunk, safeCodeBlock } from './format.js'
import { JsonStateFile, type StatusState } from './state-file.js'

export interface ForwarderCallbacks {
  send(channelId: string, text: string): Promise<void>
  react(channelId: string, messageId: string, emoji: string): Promise<void>
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>
  recordAssistantTurn?: (payload: { channelId: string; text: string; sessionId?: string }) => Promise<void> | void
}

export interface SessionBoundTranscript {
  claudePid: number
  sessionId: string
  sessionCwd: string
  transcriptPath: string
  exists: boolean
}

type SessionMeta = {
  sessionId?: string
  cwd?: string
}

export function cwdToProjectSlug(cwd: string): string {
  return resolve(cwd)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1-')
    .replace(/\//g, '-')
}

function getParentPid(pid: number): number | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ], { encoding: 'utf8' }).trim()
      const parsed = parseInt(out, 10)
      return Number.isFinite(parsed) ? parsed : null
    }
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const parsed = parseInt(out, 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function discoverSessionBoundTranscript(): SessionBoundTranscript | null {
  const projectsDir = join(homedir(), '.claude', 'projects')
  const sessionsDir = join(homedir(), '.claude', 'sessions')
  let pid: number | null = process.ppid
  const projectSlug = cwdToProjectSlug(process.cwd())

  for (let depth = 0; pid && pid > 1 && depth < 6; depth += 1) {
    const sessionFile = join(sessionsDir, `${pid}.json`)
    try {
      const session = JSON.parse(readFileSync(sessionFile, 'utf8')) as SessionMeta
      if (session.sessionId) {
        const sessionCwd = resolve(session.cwd ?? process.cwd())
        const preferred = join(projectsDir, cwdToProjectSlug(sessionCwd), `${session.sessionId}.jsonl`)
        if (existsSync(preferred)) {
          return {
            claudePid: pid,
            sessionId: session.sessionId,
            sessionCwd,
            transcriptPath: preferred,
            exists: true,
          }
        }

        const fallback = join(projectsDir, projectSlug, `${session.sessionId}.jsonl`)
        if (existsSync(fallback)) {
          return {
            claudePid: pid,
            sessionId: session.sessionId,
            sessionCwd,
            transcriptPath: fallback,
            exists: true,
          }
        }

        return {
          claudePid: pid,
          sessionId: session.sessionId,
          sessionCwd,
          transcriptPath: preferred,
          exists: false,
        }
      }
    } catch { /* try parent */ }
    pid = getParentPid(pid)
  }

  return null
}

export class OutputForwarder {
  private lastHash = ''
  private sentCount = 0
  private transcriptPath = ''
  private channelId = ''
  private userMessageId = ''
  private emoji = ''
  private lastFileSize = 0
  private watchingPath = ''
  private watcher: FSWatcher | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private onIdleCallback: (() => void) | null = null
  private inExplorerSequence = false
  private hasSeenAssistant = false
  private sending = false
  private mainSessionId = ''
  private watchDebounce: ReturnType<typeof setTimeout> | null = null
  private turnTextBuffer = ''

  hasBinding(): boolean {
    return !!this.transcriptPath
  }

  constructor(
    private cb: ForwarderCallbacks,
    private readonly statusState: JsonStateFile<StatusState>,
  ) {}

  /** Set context for current turn (called on user message) */
  setContext(
    channelId: string,
    transcriptPath: string,
    options: { replayFromStart?: boolean } = {},
  ): void {
    this.channelId = channelId
    if (!transcriptPath) return
    if (this.transcriptPath !== transcriptPath) {
      this.closeWatcher()
      this.transcriptPath = transcriptPath
      this.mainSessionId = ''
    }
    try {
      this.lastFileSize = options.replayFromStart
        ? 0
        : existsSync(this.transcriptPath) ? statSync(this.transcriptPath).size : 0
    } catch {
      this.lastFileSize = 0
    }
  }

  /** Reset counters for new turn */
  reset(): void {
    this.sentCount = 0
    this.lastHash = ''
    this.inExplorerSequence = false
    this.hasSeenAssistant = false
    this.turnTextBuffer = ''
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }

  /** Read new bytes from transcript file since lastFileSize */
  private readNewLines(): string[] {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return []
    let fd: number | null = null
    try {
      const stat = statSync(this.transcriptPath)
      if (stat.size <= this.lastFileSize) return []

      fd = openSync(this.transcriptPath, 'r')
      const buf = Buffer.alloc(stat.size - this.lastFileSize)
      readSync(fd, buf, 0, buf.length, this.lastFileSize)
      this.lastFileSize = stat.size

      return buf.toString('utf8').split('\n').filter(l => l.trim())
    } catch {
      return []
    } finally {
      if (fd != null) {
        closeSync(fd)
      }
    }
  }

  /** Track last tool_use name for matching with tool_result */
  private lastToolName = ''

  /** Extract new assistant text + tool logs from transcript since lastFileSize */
  private extractNewText(): string {
    const newLines = this.readNewLines()
    let newText = ''
    for (const l of newLines) {
      try {
        const entry = JSON.parse(l)

        // Pin to the main session id on the first non-sidechain entry.
        if (!entry.isSidechain && entry.sessionId && !this.mainSessionId) {
          this.mainSessionId = entry.sessionId
        }

        // Keep sidechains out of the forwarding path.
        if (entry.isSidechain) continue
        if (this.mainSessionId && entry.sessionId && entry.sessionId !== this.mainSessionId) continue

        // tool_result: show Edit diff from toolUseResult, skip the rest
        if (entry.type === 'user' && entry.message?.content?.some((c: any) => c.type === 'tool_result')) {
          if (this.lastToolName === 'Edit' && entry.toolUseResult) {
            const old = entry.toolUseResult.oldString || ''
            const nw = entry.toolUseResult.newString || ''
            if (old || nw) {
              const diffLines: string[] = []
              for (const l of old.split('\n')) diffLines.push('- ' + l)
              for (const l of nw.split('\n')) diffLines.push('+ ' + l)
              const shown = diffLines.slice(0, 15)
              let diffContent = shown.join('\n')
              if (diffLines.length > 15) diffContent += '\n... +' + (diffLines.length - 15) + ' lines'
              const block = safeCodeBlock(diffContent, 'diff')
              newText += block + '\n'
            }
          }
          continue
        }

        if (entry.type === 'assistant' && entry.message?.content) {
          this.hasSeenAssistant = true
          const SEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob'])
          const parts: string[] = []

          for (const c of entry.message.content) {
            if (c.type === 'text' && c.text?.trim()) {
              // Plain text resets the Explorer grouping sequence.
              this.inExplorerSequence = false
              parts.push(c.text.trim())
            } else if (c.type === 'tool_use') {
              this.lastToolName = c.name || ''
              if (OutputForwarder.isHidden(c.name)) continue

              // Show only the first Read/Grep/Glob item in a grouped sequence.
              if (SEARCH_TOOLS.has(c.name)) {
                if (!this.inExplorerSequence) {
                  this.inExplorerSequence = true
                  let target = ''
                  if (c.name === 'Read') target = c.input?.file_path ? basename(c.input.file_path) : ''
                  else if (c.name === 'Grep') target = '"' + (c.input?.pattern || '').substring(0, 25) + '"'
                  else if (c.name === 'Glob') target = (c.input?.pattern || '').substring(0, 25)
                  if (parts.length > 0) parts.push('\u3164')
                  parts.push('● **Explorer** (' + (target || c.name) + ')')
                }
                // Ignore subsequent search steps in the same sequence.
                continue
              }

              // Non-search tools end the Explorer grouping sequence.
              this.inExplorerSequence = false
              const toolLine = OutputForwarder.buildToolLine(c.name, c.input)
              if (toolLine) {
                if (parts.length > 0) parts.push('\u3164')
                parts.push(toolLine)
              }
            }
          }
          if (parts.length) newText += parts.join('\n') + '\n'
        }
      } catch {}
    }
    return newText.trim()
  }

  // ── Single-send gate ──────────────────────────────────────────────
  // All Discord sends pass through sendOnce() so duplicate concurrent sends are avoided.

  // Texts that should never be forwarded to Discord (Claude's internal status lines)
  private static readonly SKIP_TEXTS = new Set([
    'No response requested.', 'No response requested',
    'Waiting for user response.', 'Waiting for user response',
  ])

  private async sendOnce(text: string): Promise<void> {
    if (!text || !this.channelId) return
    if (OutputForwarder.SKIP_TEXTS.has(text.trim())) return
    const formatted = formatForDiscord(text)
    const hash = createHash('md5').update(formatted).digest('hex')
    if (this.lastHash === hash) return
    this.lastHash = hash
    this.turnTextBuffer = this.turnTextBuffer
      ? `${this.turnTextBuffer}\n\n${text.trim()}`
      : text.trim()
    const chunks = chunk(formatted, 2000)
    this.sentCount += chunks.length
    this.persistState()
    for (const c of chunks) {
      try { await this.cb.send(this.channelId, c) }
      catch (err) { process.stderr.write(`claude2bot: send failed: ${err}\n`) }
    }
  }

  /** Forward new assistant text to Discord */
  async forwardNewText(): Promise<void> {
    if (!this.channelId || this.sending) return
    this.sending = true
    try {
      const newText = this.extractNewText()
      if (!newText) {
        this.persistState()
        return
      }
      await this.sendOnce(newText)
    } finally { this.sending = false }
  }

  /** Forward tool log line to Discord */
  async forwardToolLog(toolLine: string): Promise<void> {
    if (!this.channelId || this.sending) return
    this.sending = true
    try {
      // Update reaction to tool emoji
      if (this.userMessageId) {
        const newEmoji = '\u{1F6E0}\uFE0F'
        try {
          if (this.emoji && this.emoji !== newEmoji) {
            await this.cb.removeReaction(this.channelId, this.userMessageId, this.emoji)
          }
          await this.cb.react(this.channelId, this.userMessageId, newEmoji)
          this.emoji = newEmoji
        } catch {}
      }
      // Combine pending text + tool log
      const newText = this.extractNewText()
      const msg = newText
        ? formatForDiscord(newText) + '\n\n' + toolLine
        : toolLine
      // Tool logs are always treated as new output, so skip hash dedup here.
      this.sentCount++
      this.persistState()
      const chunks = chunk(msg, 2000)
      for (const c of chunks) {
        try { await this.cb.send(this.channelId, c) }
        catch (err) { process.stderr.write(`claude2bot: send failed: ${err}\n`) }
      }
    } finally { this.sending = false }
  }

  /** Forward final text on session idle */
  async forwardFinalText(): Promise<void> {
    if (!this.channelId || this.sending) return
    this.sending = true
    try {
      // Remove reaction
      if (this.userMessageId && this.emoji) {
        try { await this.cb.removeReaction(this.channelId, this.userMessageId, this.emoji) }
        catch {}
      }
      const newText = this.extractNewText()
      if (newText) await this.sendOnce(newText)
      if (this.turnTextBuffer.trim()) {
        await this.cb.recordAssistantTurn?.({
          channelId: this.channelId,
          text: this.turnTextBuffer.trim(),
          sessionId: this.mainSessionId || undefined,
        })
        this.turnTextBuffer = ''
      }
      this.updateState(state => {
        state.sessionIdle = true
      })
    } finally { this.sending = false }
  }

  /** Hidden tools — skip both tool_use and tool_result */
  private static readonly HIDDEN_TOOLS = new Set([
    'ToolSearch', 'SendMessage', 'TeamCreate', 'TaskCreate',
    'TaskUpdate', 'TaskList', 'TaskGet',
  ])

  /** Check if a tool should be hidden */
  static isHidden(name: string): boolean {
    if (OutputForwarder.HIDDEN_TOOLS.has(name)) return true
    // Hide claude2bot's own MCP tools from mirrored output.
    if (name.includes('plugin_claude2bot') || name === 'reply' || name === 'react'
      || name === 'edit_message' || name === 'fetch_messages' || name === 'download_attachment') return true
    return false
  }

  /** Build a tool log line from the tool name and input. */
  static buildToolLine(name: string, input: Record<string, any>): string | null {
    // Hidden tools — return null
    if (OutputForwarder.isHidden(name)) return null

    let displayName = name
    let summary = ''
    let detail = ''

    const isSearchTool = (name === 'Read' || name === 'Grep' || name === 'Glob')

    switch (name) {
      case 'Bash': {
        const desc = (input?.description || '').substring(0, 50)
        summary = desc || 'Bash'
        detail = (input?.command || '').substring(0, 500)
        break
      }
      case 'Read':
        summary = input?.file_path ? basename(input.file_path) : ''
        break
      case 'Grep':
        summary = '"' + (input?.pattern || '').substring(0, 25) + '"'
        break
      case 'Glob':
        summary = (input?.pattern || '').substring(0, 25)
        break
      case 'Edit':
      case 'Write':
        summary = input?.file_path ? basename(input.file_path) : ''
        detail = input?.file_path || ''
        break
      case 'Agent': {
        summary = input?.name || input?.subagent_type || 'agent'
        let d = (input?.prompt || '').substring(0, 200)
        const backticks = (d.match(/```/g) || []).length
        if (backticks % 2 === 1) d += '\n```'
        if (d.length < (input?.prompt || '').length) d += '...'
        detail = d
        break
      }
      case 'TeamCreate':
        summary = input?.team_name || ''
        detail = input?.description || ''
        break
      case 'TaskCreate':
        summary = (input?.subject || '').substring(0, 50)
        break
      case 'Skill':
        summary = input?.skill || ''
        break
      default:
        if (name.startsWith('mcp__')) {
          const parts = name.split('__')
          displayName = 'mcp'
          summary = parts[parts.length - 1] || ''
        } else {
          summary = name
        }
        break
    }

    if (!summary) return null
    // Format as ● **Name** (summary)
    let toolLine = (displayName === summary)
      ? '● **' + displayName + '**'
      : '● **' + displayName + '** (' + summary + ')'
    if (!isSearchTool && detail && detail !== summary) {
      // Limit the preview block to 5 lines.
      const lines = detail.substring(0, 500).split('\n')
      const shown = lines.slice(0, 5)
      let block = shown.join('\n')
      if (lines.length > 5) block += '\n... +' + (lines.length - 5) + ' lines'
      toolLine += '\n' + safeCodeBlock(block)
    }
    return toolLine
  }

  // ── File watch ─────────────────────────────────────────────────────

  /** Set callback for idle detection (no new data for 5s after assistant entry) */
  setOnIdle(cb: () => void): void {
    this.onIdleCallback = cb
  }

  /** Start watching transcript file for changes (runs once, never stops) */
  startWatch(): void {
    if (!this.transcriptPath) return
    if (this.watchingPath === this.transcriptPath && this.watcher) return

    this.closeWatcher()

    this.watchingPath = this.transcriptPath
    try {
      this.watcher = watch(this.transcriptPath, () => this.scheduleWatchFlush())
      this.watcher.on('error', () => this.closeWatcher())
    } catch {
      this.closeWatcher()
    }
  }

  /** No-op — watch is kept alive permanently */
  stopWatch(): void {
    // Intentionally empty: watch must never stop
  }

  /** Reset the idle timer — fires after 5s of no new data */
  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.onIdleCallback) this.onIdleCallback()
    }, 5000)
  }

  private closeWatcher(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce)
      this.watchDebounce = null
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    this.watchingPath = ''
  }

  private scheduleWatchFlush(): void {
    if (this.watchDebounce) clearTimeout(this.watchDebounce)
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null
      void this.forwardNewText()
      if (this.hasSeenAssistant) {
        this.resetIdleTimer()
      }
    }, 200)
  }

  private updateState(mutator: (state: StatusState) => void): void {
    this.statusState.update(mutator)
  }

  private persistState(): void {
    this.updateState(state => {
      state.lastFileSize = this.lastFileSize
      state.sentCount = this.sentCount
      state.lastSentHash = this.lastHash
      state.lastSentTime = Date.now()
      state.emoji = this.emoji
      state.sessionIdle = false
    })
  }
}
