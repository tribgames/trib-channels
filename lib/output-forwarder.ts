/**
 * OutputForwarder — centralized output forwarding from MCP server to Discord.
 * MCP server-centric output architecture. No hooks for text forwarding.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, watchFile, unwatchFile, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { createHash } from 'crypto'
import { formatForDiscord, chunk, safeCodeBlock } from './format.js'

export interface ForwarderCallbacks {
  send(channelId: string, text: string): Promise<void>
  react(channelId: string, messageId: string, emoji: string): Promise<void>
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>
}

const STATUS_FILE = join(tmpdir(), 'claude2bot-status.json')

/** Discover the most recently modified .jsonl transcript under ~/.claude/projects/ */
export function discoverTranscriptPath(): string {
  const projectsDir = join(homedir(), '.claude', 'projects')
  let latest = { path: '', mtime: 0 }

  try {
    for (const slug of readdirSync(projectsDir)) {
      const dir = join(projectsDir, slug)
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.jsonl')) continue
          const fp = join(dir, f)
          const mt = statSync(fp).mtimeMs
          if (mt > latest.mtime) latest = { path: fp, mtime: mt }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* projects dir missing */ }

  return latest.path
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
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private onIdleCallback: (() => void) | null = null
  private inExplorerSequence = false
  private hasSeenAssistant = false

  constructor(private cb: ForwarderCallbacks) {}

  /** Set context for current turn (called on user message) */
  setContext(channelId: string, transcriptPath: string): void {
    this.channelId = channelId
    this.transcriptPath = transcriptPath
    // Record current file size so we only forward new content
    try {
      this.lastFileSize = existsSync(transcriptPath) ? statSync(transcriptPath).size : 0
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
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }

  /** Sync in-memory state from status file (call after user-prompt hook sets state) */
  syncFromState(): void {
    const state = this.readState()
    if (state.channelId) this.channelId = state.channelId
    if (state.userMessageId) this.userMessageId = state.userMessageId
    if (state.emoji) this.emoji = state.emoji
    if (state.transcriptPath) this.transcriptPath = state.transcriptPath
    if (state.lastFileSize != null) this.lastFileSize = state.lastFileSize
    if (state.sentCount != null) this.sentCount = state.sentCount
    if (state.lastSentHash) this.lastHash = state.lastSentHash
  }

  /** Read new bytes from transcript file since lastFileSize */
  private readNewLines(): string[] {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return []
    try {
      const stat = statSync(this.transcriptPath)
      if (stat.size <= this.lastFileSize) return []

      const fd = openSync(this.transcriptPath, 'r')
      const buf = Buffer.alloc(stat.size - this.lastFileSize)
      readSync(fd, buf, 0, buf.length, this.lastFileSize)
      closeSync(fd)
      this.lastFileSize = stat.size

      return buf.toString('utf8').split('\n').filter(l => l.trim())
    } catch {
      return []
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

        // 에이전트 엔트리 필터링 — teamName이 있으면 에이전트 출력
        if (entry.teamName) continue

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
              // 텍스트 → Explorer 시퀀스 리셋
              this.inExplorerSequence = false
              parts.push(c.text.trim())
            } else if (c.type === 'tool_use') {
              this.lastToolName = c.name || ''
              if (OutputForwarder.isHidden(c.name)) continue

              // Read/Grep/Glob → 첫 번째만 표시, 나머지 무시
              if (SEARCH_TOOLS.has(c.name)) {
                if (!this.inExplorerSequence) {
                  this.inExplorerSequence = true
                  let target = ''
                  if (c.name === 'Read') target = (c.input?.file_path || '').split('/').pop() || ''
                  else if (c.name === 'Grep') target = '"' + (c.input?.pattern || '').substring(0, 25) + '"'
                  else if (c.name === 'Glob') target = (c.input?.pattern || '').substring(0, 25)
                  if (parts.length > 0) parts.push('\u3164')
                  parts.push('● **Explorer** (' + (target || c.name) + ')')
                }
                // 연속 검색은 무시
                continue
              }

              // 비검색 도구 → Explorer 시퀀스 리셋
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

  /** Forward new assistant text to Discord (pre-tool replacement) */
  async forwardNewText(): Promise<void> {
    if (!this.channelId) return
    const newText = this.extractNewText()

    // Filter out internal/system responses
    const SKIP_TEXTS = ['No response requested.', 'No response requested', '유저 응답 대기.', '유저 응답 대기']
    if (!newText || SKIP_TEXTS.includes(newText.trim())) {
      this.persistState()
      return
    }

    const formatted = formatForDiscord(newText)
    const hash = createHash('md5').update(formatted).digest('hex')
    if (this.lastHash === hash) {
      this.persistState()
      return
    }

    this.lastHash = hash
    const pad = this.sentCount > 0 ? '\u3164\n' : ''
    const chunks = chunk(pad + formatted, 2000)
    this.sentCount += chunks.length
    this.persistState()

    for (const c of chunks) {
      try { await this.cb.send(this.channelId, c) }
      catch (err) { process.stderr.write(`claude2bot: forwardNewText failed: ${err}\n`) }
    }
  }

  /** Forward tool log line to Discord (post-tool replacement) */
  async forwardToolLog(toolLine: string): Promise<void> {
    if (!this.channelId) return

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
    const pad = this.sentCount > 0 ? '\u3164\n' : ''
    const msg = newText
      ? pad + formatForDiscord(newText) + '\n\n' + toolLine
      : pad + toolLine
    this.sentCount++
    this.persistState()

    const chunks = chunk(msg, 2000)
    for (const c of chunks) {
      try { await this.cb.send(this.channelId, c) }
      catch (err) { process.stderr.write(`claude2bot: forwardToolLog failed: ${err}\n`) }
    }
  }

  /** Forward final text on session idle (stop hook replacement) */
  async forwardFinalText(): Promise<void> {
    if (!this.channelId) return

    // Remove reaction
    if (this.userMessageId && this.emoji) {
      try { await this.cb.removeReaction(this.channelId, this.userMessageId, this.emoji) }
      catch {}
    }

    const newText = this.extractNewText()
    if (newText) {
      const formatted = formatForDiscord(newText)
      const hash = createHash('md5').update(formatted).digest('hex')
      if (this.lastHash !== hash) {
        this.lastHash = hash
        const pad = this.sentCount > 0 ? '\u3164\n' : ''
        const chunks = chunk(pad + formatted, 2000)
        for (const c of chunks) {
          try { await this.cb.send(this.channelId, c) }
          catch (err) { process.stderr.write(`claude2bot: forwardFinalText failed: ${err}\n`) }
        }
      }
    }

    // Mark idle in state
    const state = this.readState()
    state.sessionIdle = true
    this.writeState(state)
  }

  /** Hidden tools — skip both tool_use and tool_result */
  private static readonly HIDDEN_TOOLS = new Set([
    'ToolSearch', 'SendMessage', 'TeamCreate', 'TaskCreate',
    'TaskUpdate', 'TaskList', 'TaskGet',
  ])

  /** Tools whose results should be shown */
  static readonly RESULT_TOOLS: Record<string, 'code' | 'diff'> = {
    Bash: 'code',
    Edit: 'diff',
  }

  /** Check if a tool should be hidden */
  static isHidden(name: string): boolean {
    if (OutputForwarder.HIDDEN_TOOLS.has(name)) return true
    // claude2bot 자체 MCP 도구 숨김 (reply, react, edit_message, fetch_messages 등)
    if (name.includes('plugin_claude2bot') || name === 'reply' || name === 'react'
      || name === 'edit_message' || name === 'fetch_messages' || name === 'download_attachment') return true
    return false
  }

  /** Build tool log line from tool name and input (시안 C 포맷) */
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
        summary = input?.file_path?.split('/').pop() || ''
        break
      case 'Grep':
        summary = '"' + (input?.pattern || '').substring(0, 25) + '"'
        break
      case 'Glob':
        summary = (input?.pattern || '').substring(0, 25)
        break
      case 'Edit':
      case 'Write':
        summary = input?.file_path?.split('/').pop() || ''
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
    // ● **Name** (summary) 포맷
    let toolLine = (displayName === summary)
      ? '● **' + displayName + '**'
      : '● **' + displayName + '** (' + summary + ')'
    if (!isSearchTool && detail && detail !== summary) {
      // 5줄 제한
      const lines = detail.substring(0, 500).split('\n')
      const shown = lines.slice(0, 5)
      let block = shown.join('\n')
      if (lines.length > 5) block += '\n... +' + (lines.length - 5) + ' lines'
      toolLine += '\n' + safeCodeBlock(block)
    }
    return toolLine
  }

  /** Format tool result as code block (Bash: last 5 lines, Edit: diff) */
  static formatToolResult(toolName: string, content: any[]): string | null {
    const mode = OutputForwarder.RESULT_TOOLS[toolName]
    if (!mode) return null

    // Extract text from tool_result content
    let text = ''
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text) text += c.text
      }
    } else if (typeof content === 'string') {
      text = content
    }
    if (!text.trim()) return null

    if (mode === 'code') {
      // Bash: last 5 lines, +N lines indicator if truncated
      const lines = text.trimEnd().split('\n')
      const total = lines.length
      const shown = lines.slice(-5)
      let result = ''
      if (total > 5) result += `+${total - 5} lines\n`
      result += '```\n' + shown.join('\n') + '\n```'
      return result
    }

    if (mode === 'diff') {
      // Edit: show as diff block (truncate if very long)
      const lines = text.trimEnd().split('\n')
      const shown = lines.slice(0, 15)
      let result = '```diff\n' + shown.join('\n')
      if (lines.length > 15) result += '\n+' + (lines.length - 15) + ' more lines'
      result += '\n```'
      return result
    }

    return null
  }

  // ── File watch ─────────────────────────────────────────────────────

  /** Set callback for idle detection (no new data for 5s after assistant entry) */
  setOnIdle(cb: () => void): void {
    this.onIdleCallback = cb
  }

  /** Start watching transcript file for changes (runs once, never stops) */
  startWatch(): void {
    if (!this.transcriptPath) return
    // Already watching the same file — skip
    if (this.watchingPath === this.transcriptPath) return
    // Watching a different file — switch
    if (this.watchingPath) {
      unwatchFile(this.watchingPath)
      this.watchingPath = ''
    }

    // Initialize file size
    try {
      this.lastFileSize = statSync(this.transcriptPath).size
    } catch {
      this.lastFileSize = 0
    }

    this.watchingPath = this.transcriptPath
    watchFile(this.transcriptPath, { interval: 1000 }, (curr, prev) => {
      if (curr.size > prev.size) {
        void this.forwardNewText()
        // Reset idle timer — only after first assistant entry seen
        if (this.hasSeenAssistant) {
          this.resetIdleTimer()
        }
      }
    })
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

  // ── State file helpers ────────────────────────────────────────────

  private readState(): Record<string, any> {
    try { return JSON.parse(readFileSync(STATUS_FILE, 'utf8')) }
    catch { return {} }
  }

  private writeState(state: Record<string, any>): void {
    try { writeFileSync(STATUS_FILE, JSON.stringify(state)) }
    catch {}
  }

  private persistState(): void {
    const state = this.readState()
    state.lastFileSize = this.lastFileSize
    state.sentCount = this.sentCount
    state.lastSentHash = this.lastHash
    state.lastSentTime = Date.now()
    state.emoji = this.emoji
    state.sessionIdle = false
    this.writeState(state)
  }
}
