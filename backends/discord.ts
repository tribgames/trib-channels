/**
 * Discord backend — forked from the official Claude Code Discord plugin.
 *
 * Implements ChannelBackend with full access control (pairing, allowlists,
 * guild-channel support with mention-triggering). State lives in
 * <stateDir>/access.json.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type Attachment,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { randomBytes } from 'crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  realpathSync,
} from 'fs'
import { join, sep } from 'path'
import type {
  ChannelBackend,
  InboundMessage,
  SendOptions,
  SendResult,
  FetchedMessage,
  DownloadedFile,
  DiscordBackendConfig,
  AttachmentInfo,
  ChannelAccessPolicy,
} from './types.js'
import { chunk } from '../lib/format.js'

// ── Access control types ───────────────────────────────────────────────

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  channels: Record<string, ChannelAccessPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

// ── Constants ──────────────────────────────────────────────────────────

const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const RECENT_SENT_CAP = 200

// ── Helpers ────────────────────────────────────────────────────────────

function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    channels: {},
    pending: {},
  }
}

function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
}

// ── Discord backend ────────────────────────────────────────────────────

export class DiscordBackend implements ChannelBackend {
  readonly name = 'discord'

  onMessage: ((msg: InboundMessage) => void) | null = null
  onInteraction: ((interaction: { type: string; customId: string; userId: string; channelId: string; values?: string[]; fields?: Record<string, string>; message?: { id: string } }) => void) | null = null
  onSlashCommand: ((interaction: ChatInputCommandInteraction) => void) | null = null
  onModalRequest: ((interaction: any) => void) | null = null
  onCustomCommand: ((text: string, channelId: string, userId: string, replyFn: (text: string, opts?: { embeds?: Record<string, unknown>[]; components?: Record<string, unknown>[] }) => Promise<void>) => void) | null = null

  private client: Client
  private stateDir: string
  private accessFile: string
  private approvedDir: string
  private inboxDir: string
  private token: string
  private isStatic: boolean
  private bootAccess: Access | null = null
  private recentSentIds = new Set<string>()
  private sendCount = 0
  private approvalTimer: ReturnType<typeof setInterval> | null = null
  private typingIntervals = new Map<string, NodeJS.Timeout>()

  constructor(config: DiscordBackendConfig, stateDir: string) {
    this.token = config.token
    this.stateDir = stateDir
    this.accessFile = join(stateDir, 'access.json')
    this.approvedDir = join(stateDir, 'approved')
    this.inboxDir = join(stateDir, 'inbox')
    this.isStatic = config.accessMode === 'static'

    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    })
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.isStatic) {
      const a = this.readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('claude2bot discord: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      this.bootAccess = a
    }

    this.client.on('error', err => {
      process.stderr.write(`claude2bot discord: client error: ${err}\n`)
    })

    this.client.on('messageCreate', msg => {
      if (msg.author.id === this.client.user?.id) {
        return
      }
      if (msg.author.bot) return
      this.handleInbound(msg).catch(e =>
        process.stderr.write(`claude2bot discord: handleInbound failed: ${e}\n`),
      )
    })

    this.client.on('interactionCreate', async (interaction) => {
      try {
        // Slash commands — /claude stop, /claude status, etc.
        if (interaction.isChatInputCommand()) {
          if (this.onSlashCommand) {
            this.onSlashCommand(interaction)
          }
          return
        }

        // Modal submit handling
        if (interaction.isModalSubmit()) {
          if (this.onInteraction) {
            const fields: Record<string, string> = {}
            for (const row of interaction.components) {
              for (const comp of (row as any).components ?? []) {
                if (comp.customId && comp.value != null) fields[comp.customId] = String(comp.value)
              }
            }
            this.onInteraction({
              type: 'modal',
              customId: interaction.customId,
              userId: interaction.user.id,
              channelId: interaction.channelId ?? '',
              fields,
              message: interaction.message ? { id: interaction.message.id } : undefined,
            })
          }
          await interaction.deferUpdate().catch(() => {})
          return
        }

        if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isUserSelectMenu() || interaction.isChannelSelectMenu()) {
          // Pass modal-triggering interactions through without deferUpdate.
          const needsModal = interaction.isButton() && (
            interaction.customId === 'sched_add_next' ||
            interaction.customId === 'sched_edit_next' ||
            interaction.customId === 'quiet_set_next' ||
            interaction.customId === 'activity_add_next' ||
            interaction.customId === 'profile_edit'
          )

          if (needsModal) {
            // Forward the raw interaction so server.ts can call showModal().
            if (this.onModalRequest) {
              this.onModalRequest(interaction as any)
            }
            return
          }

          await interaction.deferUpdate().catch(() => {})

          if (this.onInteraction) {
            this.onInteraction({
              type: interaction.isButton() ? 'button' : 'select',
              customId: interaction.customId,
              userId: interaction.user.id,
              channelId: interaction.channelId,
              values: interaction.isStringSelectMenu() ? interaction.values : undefined,
              message: interaction.message ? { id: interaction.message.id } : undefined,
            })
          }
        }
      } catch (err) {
        process.stderr.write(`claude2bot discord: interaction error: ${err}\n`)
      }
    })

    this.client.on('ready', async c => {
      process.stderr.write(`claude2bot discord: gateway connected as ${c.user.tag}\n`)
      try {
        const { registerSlashCommands } = await import('../lib/slash-commands.js')
        await registerSlashCommands(this.client, this.token)
      } catch (err) {
        process.stderr.write(`claude2bot discord: slash command registration failed: ${err}\n`)
      }
    })

    this.client.on('shardDisconnect', (ev, id) => {
      process.stderr.write(`claude2bot discord: shard ${id} disconnected (code ${ev.code}). Will auto-reconnect.\n`)
    })

    this.client.on('shardReconnecting', id => {
      process.stderr.write(`claude2bot discord: shard ${id} reconnecting...\n`)
    })

    this.client.on('shardResume', (id, replayedEvents) => {
      process.stderr.write(`claude2bot discord: shard ${id} resumed (replayed ${replayedEvents} events)\n`)
    })

    this.client.on('warn', msg => {
      process.stderr.write(`claude2bot discord: warn: ${msg}\n`)
    })


    await this.client.login(this.token)

    if (!this.isStatic) {
      this.approvalTimer = setInterval(() => this.checkApprovals(), 5000)
    }
  }

  async disconnect(): Promise<void> {
    if (this.approvalTimer) {
      clearInterval(this.approvalTimer)
      this.approvalTimer = null
    }
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval)
    }
    this.typingIntervals.clear()
    this.client.destroy()
  }

  resetSendCount(): void {
    this.sendCount = 0
  }

  startTyping(channelId: string): void {
    this.stopTyping(channelId)
    const ch = this.client.channels.cache.get(channelId)
    if (ch && 'sendTyping' in ch) {
      void (ch as any).sendTyping().catch(() => {})
      const interval = setInterval(() => {
        if ('sendTyping' in (ch as any)) {
          (ch as any).sendTyping().catch(() => {})
        }
      }, 9000)
      this.typingIntervals.set(channelId, interval)
    }
  }

  stopTyping(channelId: string): void {
    const interval = this.typingIntervals.get(channelId)
    if (interval) {
      clearInterval(interval)
      this.typingIntervals.delete(channelId)
    }
  }

  // ── Outbound operations ────────────────────────────────────────────

  async sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<SendResult> {
    const ch = await this.fetchAllowedChannel(chatId)
    if (!('send' in ch)) throw new Error('channel is not sendable')

    const files = opts?.files ?? []
    const replyTo = opts?.replyTo

    for (const f of files) {
      this.assertSendable(f)
      const st = statSync(f)
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
      }
    }
    if (files.length > 10) throw new Error('max 10 attachments per message')

    // Consecutive message padding — prepend ZWS newline when prior messages exist in the same turn
    if (text && this.sendCount > 0) {
      text = '\u3164\n' + text
    }

    const access = this.loadAccess()
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
    const replyMode = access.replyToMode ?? 'first'
    const chunks = chunk(text, limit)
    const sentIds: string[] = []

    try {
      for (let i = 0; i < chunks.length; i++) {
        const shouldReplyTo =
          replyTo != null &&
          replyMode !== 'off' &&
          (replyMode === 'all' || i === 0)
        const embeds = i === 0 ? (opts?.embeds ?? []) : []
        const components = i === 0 ? (opts?.components ?? []) : []
        const sent = await ch.send({
          content: chunks[i],
          ...(embeds.length > 0 ? { embeds } : {}),
          ...(components.length > 0 ? { components: components as any } : {}),
          ...(i === 0 && files.length > 0 ? { files } : {}),
          ...(shouldReplyTo
            ? { reply: { messageReference: replyTo, failIfNotExists: false } }
            : {}),
        })
        this.noteSent(sent.id)
        sentIds.push(sent.id)
      }
      this.sendCount += sentIds.length
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`send failed after ${sentIds.length}/${chunks.length} chunk(s): ${msg}`)
    }

    return { sentIds }
  }

  async fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]> {
    const ch = await this.fetchAllowedChannel(channelId)
    const capped = Math.min(limit, 100)
    const msgs = await ch.messages.fetch({ limit: capped })
    const me = this.client.user?.id

    return [...msgs.values()].reverse().map(m => ({
      id: m.id,
      user: m.author.id === me ? 'me' : m.author.username,
      text: m.content.replace(/[\r\n]+/g, ' \u23CE '),
      ts: m.createdAt.toISOString(),
      isMe: m.author.id === me,
      attachmentCount: m.attachments.size,
    }))
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    const ch = await this.fetchAllowedChannel(chatId)
    const msg = await ch.messages.fetch(messageId)
    await msg.react(emoji)
  }

  async removeReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    const ch = await this.fetchAllowedChannel(chatId)
    const msg = await ch.messages.fetch(messageId)
    const me = this.client.user?.id
    if (me) {
      const reaction = msg.reactions.cache.get(emoji)
      if (reaction) await reaction.users.remove(me)
    }
  }

  async editMessage(chatId: string, messageId: string, text: string, opts?: { embeds?: Record<string, unknown>[]; components?: Record<string, unknown>[] }): Promise<string> {
    const ch = await this.fetchAllowedChannel(chatId)
    const msg = await ch.messages.fetch(messageId)
    const edited = await msg.edit({
      content: text || null,
      ...(opts?.embeds ? { embeds: opts.embeds } : {}),
      ...(opts?.components ? { components: opts.components as any } : {}),
    })
    return edited.id
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    const ch = await this.fetchAllowedChannel(chatId)
    const msg = await ch.messages.fetch(messageId)
    await msg.delete()
  }

  async downloadAttachment(chatId: string, messageId: string): Promise<DownloadedFile[]> {
    const ch = await this.fetchAllowedChannel(chatId)
    const msg = await ch.messages.fetch(messageId)
    if (msg.attachments.size === 0) return []

    const results: DownloadedFile[] = []
    for (const att of msg.attachments.values()) {
      const path = await this.downloadSingleAttachment(att)
      results.push({
        path,
        name: safeAttName(att),
        contentType: att.contentType ?? 'unknown',
        size: att.size,
      })
    }
    return results
  }

  async validateChannel(chatId: string): Promise<void> {
    await this.fetchAllowedChannel(chatId)
  }

  // ── Access control ─────────────────────────────────────────────────

  private readAccessFile(): Access {
    try {
      const raw = readFileSync(this.accessFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Access>
      return {
        dmPolicy: parsed.dmPolicy ?? 'pairing',
        allowFrom: parsed.allowFrom ?? [],
        channels: parsed.channels ?? {},
        pending: parsed.pending ?? {},
        mentionPatterns: parsed.mentionPatterns,
        ackReaction: parsed.ackReaction,
        replyToMode: parsed.replyToMode,
        textChunkLimit: parsed.textChunkLimit,
        chunkMode: parsed.chunkMode,
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
      try {
        renameSync(this.accessFile, `${this.accessFile}.corrupt-${Date.now()}`)
      } catch {}
      process.stderr.write('claude2bot discord: access.json corrupt, moved aside. Starting fresh.\n')
      return defaultAccess()
    }
  }

  private loadAccess(): Access {
    return this.bootAccess ?? this.readAccessFile()
  }

  private saveAccess(a: Access): void {
    if (this.isStatic) return
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmp = this.accessFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.accessFile)
  }

  private pruneExpired(a: Access): boolean {
    const now = Date.now()
    let changed = false
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.expiresAt < now) {
        delete a.pending[code]
        changed = true
      }
    }
    return changed
  }

  private async gate(msg: Message): Promise<GateResult> {
    const access = this.loadAccess()
    if (this.pruneExpired(access)) this.saveAccess(access)

    if (access.dmPolicy === 'disabled') return { action: 'drop' }

    const senderId = msg.author.id
    const isDM = msg.channel.type === ChannelType.DM

    if (isDM) {
      if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
      if (access.dmPolicy === 'allowlist') return { action: 'drop' }

      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          if ((p.replies ?? 1) >= 2) return { action: 'drop' }
          p.replies = (p.replies ?? 1) + 1
          this.saveAccess(access)
          return { action: 'pair', code, isResend: true }
        }
      }
      if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

      const code = randomBytes(3).toString('hex')
      const now = Date.now()
      access.pending[code] = {
        senderId,
        chatId: msg.channelId,
        createdAt: now,
        expiresAt: now + 60 * 60 * 1000,
        replies: 1,
      }
      this.saveAccess(access)
      return { action: 'pair', code, isResend: false }
    }

    const channelId = msg.channel.isThread()
      ? msg.channel.parentId ?? msg.channelId
      : msg.channelId
    const policy = access.channels[channelId]
    if (!policy) return { action: 'drop' }
    const channelAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (channelAllowFrom.length > 0 && !channelAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !(await this.isMentioned(msg, access.mentionPatterns))) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  private async isMentioned(msg: Message, extraPatterns?: string[]): Promise<boolean> {
    if (this.client.user && msg.mentions.has(this.client.user)) return true

    const refId = msg.reference?.messageId
    if (refId) {
      if (this.recentSentIds.has(refId)) return true
      try {
        const ref = await msg.fetchReference()
        if (ref.author.id === this.client.user?.id) return true
      } catch {}
    }

    const text = msg.content
    for (const pat of extraPatterns ?? []) {
      try {
        if (new RegExp(pat, 'i').test(text)) return true
      } catch {}
    }
    return false
  }

  // ── Inbound handling ───────────────────────────────────────────────

  private async handleInbound(msg: Message): Promise<void> {
    const result = await this.gate(msg)
    if (result.action === 'drop') return

    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      try {
        await msg.reply(`${lead} — run in Claude Code:\n\n/discord:access pair ${result.code}`)
      } catch (err) {
        process.stderr.write(`claude2bot discord: failed to send pairing code: ${err}\n`)
      }
      return
    }

    // Ack reaction
    if (result.access.ackReaction) {
      void msg.react(result.access.ackReaction).catch(() => {})
    }

    // Build attachment info
    const atts: AttachmentInfo[] = []
    for (const att of msg.attachments.values()) {
      atts.push({
        name: safeAttName(att),
        contentType: att.contentType ?? 'unknown',
        size: att.size,
      })
    }

    const text = msg.content || (atts.length > 0 ? '(attachment)' : '')

    // Custom command routing: /bot(...) or /profile(...)
    if (text.match(/^\/(bot|profile)\s*\(/) && this.onCustomCommand) {
      const replyFn = async (reply: string, opts?: { embeds?: Record<string, unknown>[]; components?: Record<string, unknown>[] }) => {
        try {
          const ch = await this.fetchAllowedChannel(msg.channelId)
          if ('send' in ch) {
            await ch.send({
              ...(reply ? { content: reply } : {}),
              ...(opts?.embeds?.length ? { embeds: opts.embeds } : {}),
              ...(opts?.components?.length ? { components: opts.components as any } : {}),
            })
          }
        } catch (err) {
          process.stderr.write(`claude2bot discord: custom command reply failed: ${err}\n`)
        }
      }
      this.onCustomCommand(text, msg.channelId, msg.author.id, replyFn)
      return
    }

    if (this.onMessage) {
      this.onMessage({
        chatId: msg.channelId,
        messageId: msg.id,
        user: msg.author.username,
        userId: msg.author.id,
        text,
        ts: msg.createdAt.toISOString(),
        attachments: atts,
      })
    }
  }

  // ── Approval polling ───────────────────────────────────────────────

  private checkApprovals(): void {
    let files: string[]
    try {
      files = readdirSync(this.approvedDir)
    } catch {
      return
    }
    if (files.length === 0) return

    for (const senderId of files) {
      const file = join(this.approvedDir, senderId)
      let dmChannelId: string
      try {
        dmChannelId = readFileSync(file, 'utf8').trim()
      } catch {
        rmSync(file, { force: true })
        continue
      }
      if (!dmChannelId) {
        rmSync(file, { force: true })
        continue
      }

      void (async () => {
        try {
          const ch = await this.fetchTextChannel(dmChannelId)
          if ('send' in ch) {
            await ch.send("Paired! Say hi to Claude.")
          }
          rmSync(file, { force: true })
        } catch (err) {
          process.stderr.write(`claude2bot discord: approval confirm failed: ${err}\n`)
          rmSync(file, { force: true })
        }
      })()
    }
  }

  // ── Channel helpers ────────────────────────────────────────────────

  private async fetchTextChannel(id: string) {
    const ch = await this.client.channels.fetch(id)
    if (!ch || !ch.isTextBased()) {
      throw new Error(`channel ${id} not found or not text-based`)
    }
    return ch
  }

  private async fetchAllowedChannel(id: string) {
    const ch = await this.fetchTextChannel(id)
    const access = this.loadAccess()
    if (ch.type === ChannelType.DM) {
      if (access.allowFrom.includes(ch.recipientId)) return ch
    } else {
      const key = ch.isThread() ? ch.parentId ?? ch.id : ch.id
      if (key in access.channels) return ch
    }
    throw new Error(`channel ${id} is not allowlisted — add via /discord:access`)
  }

  private noteSent(id: string): void {
    this.recentSentIds.add(id)
    if (this.recentSentIds.size > RECENT_SENT_CAP) {
      const first = this.recentSentIds.values().next().value
      if (first) this.recentSentIds.delete(first)
    }
  }

  private assertSendable(f: string): void {
    let real: string, stateReal: string
    try {
      real = realpathSync(f)
      stateReal = realpathSync(this.stateDir)
    } catch {
      return
    }
    const inbox = join(stateReal, 'inbox')
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`)
    }
  }

  private async downloadSingleAttachment(att: Attachment): Promise<string> {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`,
      )
    }
    const res = await fetch(att.url)
    if (!res.ok) {
      throw new Error(`attachment download failed: HTTP ${res.status}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const name = att.name ?? `${att.id}`
    const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const path = join(this.inboxDir, `${Date.now()}-${att.id}.${ext}`)
    mkdirSync(this.inboxDir, { recursive: true })
    writeFileSync(path, buf)
    return path
  }
}
