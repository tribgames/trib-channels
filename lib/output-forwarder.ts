/**
 * OutputForwarder — centralized output forwarding from MCP server to Discord.
 * Replaces Discord API calls previously scattered across hooks.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { formatForDiscord, chunk } from './format.js'

export interface ForwarderCallbacks {
  send(channelId: string, text: string): Promise<void>
  react(channelId: string, messageId: string, emoji: string): Promise<void>
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>
}

const STATUS_FILE = join(tmpdir(), 'claude2bot-status.json')

export class OutputForwarder {
  private lastIdx = 0
  private lastHash = ''
  private sentCount = 0
  private transcriptPath = ''
  private channelId = ''
  private userMessageId = ''
  private emoji = ''

  constructor(private cb: ForwarderCallbacks) {}

  /** Set context for current turn (called on user message) */
  setContext(channelId: string, transcriptPath: string, transcriptIdx = 0): void {
    this.channelId = channelId
    this.transcriptPath = transcriptPath
    this.lastIdx = transcriptIdx
  }

  /** Reset counters for new turn */
  reset(): void {
    this.sentCount = 0
    this.lastHash = ''
  }

  /** Sync in-memory state from status file (call after user-prompt hook sets state) */
  syncFromState(): void {
    const state = this.readState()
    if (state.channelId) this.channelId = state.channelId
    if (state.userMessageId) this.userMessageId = state.userMessageId
    if (state.emoji) this.emoji = state.emoji
    if (state.transcriptPath) this.transcriptPath = state.transcriptPath
    if (state.transcriptIdx != null) this.lastIdx = state.transcriptIdx
    if (state.sentCount != null) this.sentCount = state.sentCount
    if (state.lastSentHash) this.lastHash = state.lastSentHash
  }

  /** Extract new assistant text from transcript since lastIdx */
  private extractNewText(): string {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return ''
    const transcript = readFileSync(this.transcriptPath, 'utf8')
    const lines = transcript.trim().split('\n')
    const newLines = lines.slice(this.lastIdx)
    this.lastIdx = lines.length

    let newText = ''
    for (const l of newLines) {
      try {
        const entry = JSON.parse(l)
        if (entry.type === 'assistant' && entry.message?.content) {
          const texts = entry.message.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n')
          if (texts.trim()) newText += texts.trim() + '\n'
        }
      } catch {}
    }
    return newText.trim()
  }

  /** Forward new assistant text to Discord (pre-tool replacement) */
  async forwardNewText(): Promise<void> {
    if (!this.channelId) return
    const newText = this.extractNewText()
    if (!newText) {
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

  /** Build tool log line from tool name and input */
  static buildToolLine(tool: string, toolInput: Record<string, any>): string | null {
    const isSearchTool = (tool === 'Read' || tool === 'Grep' || tool === 'Glob')
    const desc = (toolInput.description || '').substring(0, 50)
    let summary = ''
    let detail = ''

    if (tool === 'Bash' || tool.includes('Bash')) {
      summary = desc || 'Bash'
      detail = isSearchTool ? '' : (toolInput.command || '').substring(0, 500)
    } else if (tool === 'Read') {
      summary = (toolInput.file_path || '').split('/').pop() || ''
    } else if (tool === 'Grep') {
      summary = '"' + (toolInput.pattern || '').substring(0, 25) + '"'
    } else if (tool === 'Glob') {
      summary = (toolInput.pattern || '').substring(0, 25)
    } else if (tool === 'Write') {
      summary = (toolInput.file_path || '').split('/').pop() || 'Write'
      detail = toolInput.file_path || ''
    } else if (tool === 'Edit') {
      summary = (toolInput.file_path || '').split('/').pop() || 'Edit'
      detail = toolInput.file_path || ''
    } else if (tool === 'Agent') {
      summary = toolInput.name || toolInput.subagent_type || 'agent'
      let d = (toolInput.prompt || '').substring(0, 200)
      const backticks = (d.match(/```/g) || []).length
      if (backticks % 2 === 1) d += '\n```'
      if (d.length < (toolInput.prompt || '').length) d += '...'
      detail = d
    } else if (tool === 'TaskCreate') {
      summary = (toolInput.subject || '').substring(0, 50)
    } else if (tool === 'TeamCreate') {
      summary = toolInput.team_name || ''
      detail = toolInput.description || ''
    } else {
      summary = tool.replace(/mcp__\w+__/, '')
    }

    if (!summary) return null
    const displayName = tool.startsWith('mcp__') ? 'mcp' : tool
    let line = '-# ' + displayName + ' (' + summary + ')'
    if (!isSearchTool && detail && detail !== summary) {
      line += '\n```\n' + detail.substring(0, 300) + '\n```'
    }
    return line
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
    state.transcriptIdx = this.lastIdx
    state.sentCount = this.sentCount
    state.lastSentHash = this.lastHash
    state.lastSentTime = Date.now()
    state.emoji = this.emoji
    state.sessionIdle = false
    this.writeState(state)
  }
}
