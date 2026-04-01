/**
 * OutputForwarder — centralized output forwarding from MCP server to Discord.
 * MCP server-centric output architecture. No hooks for text forwarding.
 */

import { readFileSync, readdirSync, existsSync, statSync, watch, openSync, readSync, closeSync, type FSWatcher } from 'fs'
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

export interface ClaudeSessionRecord {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: string
  entrypoint: string
}

type SessionMeta = {
  sessionId?: string
  cwd?: string
  startedAt?: number
  kind?: string
  entrypoint?: string
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

function readSessionRecord(pid: number): ClaudeSessionRecord | null {
  const sessionFile = join(homedir(), '.claude', 'sessions', `${pid}.json`)
  try {
    const session = JSON.parse(readFileSync(sessionFile, 'utf8')) as SessionMeta
    if (!session.sessionId) return null
    return {
      pid,
      sessionId: session.sessionId,
      cwd: resolve(session.cwd ?? process.cwd()),
      startedAt: typeof session.startedAt === 'number' ? session.startedAt : 0,
      kind: typeof session.kind === 'string' ? session.kind : '',
      entrypoint: typeof session.entrypoint === 'string' ? session.entrypoint : '',
    }
  } catch {
    return null
  }
}

function isInteractiveSession(session: ClaudeSessionRecord | null): session is ClaudeSessionRecord {
  if (!session) return false
  return session.kind === 'interactive' || (!session.kind && session.entrypoint === 'cli')
}

export function discoverCurrentClaudeSession(): ClaudeSessionRecord | null {
  let pid: number | null = process.ppid

  for (let depth = 0; pid && pid > 1 && depth < 6; depth += 1) {
    const session = readSessionRecord(pid)
    if (session) return session
    pid = getParentPid(pid)
  }

  return null
}

export function listInteractiveClaudeSessions(): ClaudeSessionRecord[] {
  const sessionsDir = join(homedir(), '.claude', 'sessions')
  try {
    return readdirSync(sessionsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => parseInt(basename(file, '.json'), 10))
      .filter(pid => Number.isFinite(pid))
      .map(pid => readSessionRecord(pid))
      .filter(isInteractiveSession)
      .sort((a, b) => {
        if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt
        return b.pid - a.pid
      })
  } catch {
    return []
  }
}

export function getLatestInteractiveClaudeSession(): ClaudeSessionRecord | null {
  return listInteractiveClaudeSessions()[0] ?? null
}

function resolveTranscriptForSession(session: ClaudeSessionRecord): SessionBoundTranscript {
  const projectsDir = join(homedir(), '.claude', 'projects')
  const projectSlug = cwdToProjectSlug(process.cwd())
  const preferred = join(projectsDir, cwdToProjectSlug(session.cwd), `${session.sessionId}.jsonl`)
  if (existsSync(preferred)) {
    return {
      claudePid: session.pid,
      sessionId: session.sessionId,
      sessionCwd: session.cwd,
      transcriptPath: preferred,
      exists: true,
    }
  }

  const fallback = join(projectsDir, projectSlug, `${session.sessionId}.jsonl`)
  if (existsSync(fallback)) {
    return {
      claudePid: session.pid,
      sessionId: session.sessionId,
      sessionCwd: session.cwd,
      transcriptPath: fallback,
      exists: true,
    }
  }

  return {
    claudePid: session.pid,
    sessionId: session.sessionId,
    sessionCwd: session.cwd,
    transcriptPath: preferred,
    exists: false,
  }
}

export function discoverSessionBoundTranscript(): SessionBoundTranscript | null {
  const session = discoverCurrentClaudeSession()
  if (!session) return null
  return resolveTranscriptForSession(session)
}

export class OutputForwarder {
  private lastHash = ''
  private sentCount = 0
  private transcriptPath = ''
  private channelId = ''
  private userMessageId = ''
  private emoji = ''
  private lastFileSize = 0
  private readFileSize = 0
  private watchingPath = ''
  private watcher: FSWatcher | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private onIdleCallback: (() => void) | null = null
  private inExplorerSequence = false
  private inRecallSequence = false
  private hasSeenAssistant = false
  private sending = false
  private sendRetryTimer: ReturnType<typeof setTimeout> | null = null
  private sendQueue: Array<{
    type: 'text' | 'toolLog'
    text: string
    nextFileSize: number
    bufferText: string
    preformatted?: boolean
    skipHashDedup?: boolean
  }> = []
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
      const fileSize = options.replayFromStart
        ? 0
        : existsSync(this.transcriptPath) ? statSync(this.transcriptPath).size : 0
      this.lastFileSize = fileSize
      this.readFileSize = fileSize
    } catch {
      this.lastFileSize = 0
      this.readFileSize = 0
    }
  }

  /** Reset counters for new turn */
  reset(): void {
    this.sentCount = 0
    this.lastHash = ''
    this.inExplorerSequence = false
    this.inRecallSequence = false
    this.hasSeenAssistant = false
    this.turnTextBuffer = ''
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }

  /** Read new bytes from transcript file since readFileSize */
  private readNewLines(): { lines: string[]; nextFileSize: number } {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) {
      return { lines: [], nextFileSize: this.readFileSize }
    }
    let fd: number | null = null
    try {
      const stat = statSync(this.transcriptPath)
      if (stat.size <= this.readFileSize) {
        return { lines: [], nextFileSize: this.readFileSize }
      }
      const startOffset = this.readFileSize

      fd = openSync(this.transcriptPath, 'r')
      const buf = Buffer.alloc(stat.size - startOffset)
      readSync(fd, buf, 0, buf.length, startOffset)
      this.readFileSize = stat.size

      return {
        lines: buf.toString('utf8').split('\n').filter(l => l.trim()),
        nextFileSize: stat.size,
      }
    } catch {
      return { lines: [], nextFileSize: this.readFileSize }
    } finally {
      if (fd != null) {
        closeSync(fd)
      }
    }
  }

  /** Track last tool_use name and file path for matching with tool_result */
  private lastToolName = ''
  private lastToolFilePath = ''

  /** Extract new assistant text + tool logs from transcript since readFileSize */
  private extractNewText(): { text: string; nextFileSize: number } {
    const { lines: newLines, nextFileSize } = this.readNewLines()
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
          // Skip recall_memory tool results entirely
          if (OutputForwarder.isRecallMemory(this.lastToolName)) {
            continue
          }
          if (this.lastToolName === 'Edit' && entry.toolUseResult && !OutputForwarder.isMemoryFile(this.lastToolFilePath)) {
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
              // Plain text resets grouping sequences.
              this.inExplorerSequence = false
              this.inRecallSequence = false
              // Strip system XML tags (channel, memory-context, system-reminder, event) before forwarding
              let cleaned = c.text.trim()
                .replace(/<(channel|memory-context|system-reminder|event)\b[^>]*>[\s\S]*?<\/\1>/g, '')
                .trim()
              if (cleaned) parts.push(cleaned)
            } else if (c.type === 'tool_use') {
              this.lastToolName = c.name || ''
              this.lastToolFilePath = c.input?.file_path || ''
              if (OutputForwarder.isHidden(c.name)) continue

              // Show only the first Read/Grep/Glob item in a grouped sequence.
              if (SEARCH_TOOLS.has(c.name)) {
                if (!this.inExplorerSequence) {
                  this.inExplorerSequence = true
                  let target = ''
                  if (c.name === 'Read') target = c.input?.file_path ? basename(c.input.file_path) : ''
                  else if (c.name === 'Grep') target = '"' + (c.input?.pattern || '').substring(0, 25) + '"'
                  else if (c.name === 'Glob') target = (c.input?.pattern || '').substring(0, 25)
                  if (parts.length > 0) parts.push('')
                  parts.push('● **Explorer** (' + (target || c.name) + ')')
                }
                // Ignore subsequent search steps in the same sequence.
                continue
              }

              // Show only the first recall_memory in a grouped sequence.
              if (OutputForwarder.isRecallMemory(c.name)) {
                if (!this.inRecallSequence) {
                  this.inRecallSequence = true
                  if (parts.length > 0) parts.push('')
                  parts.push('● **recall_memory**')
                }
                continue
              }

              // Non-search tools end the Explorer and recall grouping sequences.
              this.inExplorerSequence = false
              this.inRecallSequence = false
              const toolLine = OutputForwarder.buildToolLine(c.name, c.input)
              if (toolLine) {
                if (parts.length > 0) parts.push('')
                parts.push(toolLine)
              }
            }
          }
          if (parts.length) newText += parts.join('\n') + '\n'
        }
      } catch {}
    }
    return { text: newText.trim(), nextFileSize }
  }

  // ── Single-send gate ──────────────────────────────────────────────
  // All Discord sends pass through sendOnce() so duplicate concurrent sends are avoided.

  // Texts that should never be forwarded to Discord (Claude's internal status lines)
  private static readonly SKIP_TEXTS = new Set([
    'No response requested.', 'No response requested',
    'Waiting for user response.', 'Waiting for user response',
  ])

  private commitReadProgress(nextFileSize: number): void {
    if (nextFileSize <= this.lastFileSize) return
    this.lastFileSize = nextFileSize
    this.persistState()
  }

  private async deliverQueueItem(item: {
    text: string
    nextFileSize: number
    bufferText: string
    preformatted?: boolean
    skipHashDedup?: boolean
  }): Promise<void> {
    if (!item.text || !this.channelId) {
      this.commitReadProgress(item.nextFileSize)
      return
    }
    if (!item.skipHashDedup && OutputForwarder.SKIP_TEXTS.has(item.text.trim())) {
      this.commitReadProgress(item.nextFileSize)
      return
    }

    const formatted = item.preformatted ? item.text : formatForDiscord(item.text)
    const hash = item.skipHashDedup ? '' : createHash('md5').update(formatted).digest('hex')
    if (!item.skipHashDedup && this.lastHash === hash) {
      this.commitReadProgress(item.nextFileSize)
      return
    }

    const chunks = chunk(formatted, 2000)
    for (const c of chunks) {
      await this.cb.send(this.channelId, c)
    }

    if (!item.skipHashDedup) {
      this.lastHash = hash
    }
    if (item.bufferText.trim()) {
      this.turnTextBuffer = this.turnTextBuffer
        ? `${this.turnTextBuffer}\n\n${item.bufferText.trim()}`
        : item.bufferText.trim()
    }
    this.sentCount += chunks.length
    this.commitReadProgress(item.nextFileSize)
  }

  private scheduleRetry(): void {
    if (this.sendRetryTimer) return
    this.sendRetryTimer = setTimeout(() => {
      this.sendRetryTimer = null
      void this.drainQueue()
    }, 1000)
  }

  /** Forward new assistant text to Discord. Returns true if text was sent. */
  async forwardNewText(): Promise<boolean> {
    if (!this.channelId) return false
    const { text: newText, nextFileSize } = this.extractNewText()
    if (!newText) {
      if (!this.sending && this.sendQueue.length === 0) {
        this.commitReadProgress(nextFileSize)
      }
      return false
    }
    this.sendQueue.push({
      type: 'text',
      text: newText,
      nextFileSize,
      bufferText: newText,
    })
    void this.drainQueue()
    return true
  }

  /** Forward tool log line to Discord */
  async forwardToolLog(toolLine: string): Promise<void> {
    if (!this.channelId) return
    const { text: newText, nextFileSize } = this.extractNewText()
    const message = newText
      ? formatForDiscord(newText) + '\n\n' + toolLine
      : toolLine
    this.sendQueue.push({
      type: 'toolLog',
      text: message,
      nextFileSize,
      bufferText: newText,
      preformatted: true,
      skipHashDedup: true,
    })
    void this.drainQueue()
  }

  /** Drain the send queue sequentially. Only one drain loop runs at a time. */
  private async drainQueue(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      while (this.sendQueue.length > 0) {
        const item = this.sendQueue[0]
        try {
          if (item.type === 'text') {
            await this.deliverQueueItem(item)
          } else if (item.type === 'toolLog') {
            await this.processToolLog(item)
          }
          this.sendQueue.shift()
        } catch (err) {
          process.stderr.write(`trib-channels: send failed: ${err}\n`)
          this.scheduleRetry()
          break
        }
      }
    } finally { this.sending = false }
  }

  /** Internal: process a single tool log send (extracted from old forwardToolLog) */
  private async processToolLog(item: {
    text: string
    nextFileSize: number
    bufferText: string
    preformatted?: boolean
    skipHashDedup?: boolean
  }): Promise<void> {
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
    await this.deliverQueueItem(item)
  }

  /** Forward final text on session idle */
  async forwardFinalText(retries = 0): Promise<void> {
    if (!this.channelId) return
    if (this.sending || this.sendQueue.length > 0) {
      if (retries < 5) {
        setTimeout(() => void this.forwardFinalText(retries + 1), 300)
      }
      return
    }
    this.sending = true
    try {
      // Remove reaction
      if (this.userMessageId && this.emoji) {
        try { await this.cb.removeReaction(this.channelId, this.userMessageId, this.emoji) }
        catch {}
      }
      const { text: newText, nextFileSize } = this.extractNewText()
      if (newText) {
        await this.deliverQueueItem({
          text: newText,
          nextFileSize,
          bufferText: newText,
        })
      } else {
        this.commitReadProgress(nextFileSize)
      }
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

  /** Check if a tool name is recall_memory */
  static isRecallMemory(name: string): boolean {
    return name === 'recall_memory' || name === 'mcp__plugin_trib-channels_trib-channels__recall_memory'
  }

  /** Check if a file path points to a memory file */
  static isMemoryFile(filePath: string): boolean {
    if (!filePath) return false
    const normalized = filePath.replace(/\\/g, '/')
    if (normalized.includes('.claude/projects/') && normalized.includes('/memory/')) return true
    if (basename(normalized) === 'MEMORY.md') return true
    return false
  }

  /** Check if a tool should be hidden */
  static isHidden(name: string): boolean {
    if (OutputForwarder.HIDDEN_TOOLS.has(name)) return true
    // Hide trib-channels's own MCP tools from mirrored output.
    if ((name.includes('plugin_trib-channels') && !name.endsWith('recall_memory')) || name === 'reply' || name === 'react'
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

  /** Reset the idle timer — safety net in case turn-end signal is missed */
  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.onIdleCallback) this.onIdleCallback()
    }, 1000)
  }

  private closeWatcher(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce)
      this.watchDebounce = null
    }
    if (this.sendRetryTimer) {
      clearTimeout(this.sendRetryTimer)
      this.sendRetryTimer = null
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
      void this.forwardNewText().then(hadText => {
        // Only reset idle timer when visible text was actually forwarded.
        // HIDDEN tools (SendMessage, TaskUpdate etc.) should not delay idle detection.
        if (hadText) {
          this.resetIdleTimer()
        }
      })
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
