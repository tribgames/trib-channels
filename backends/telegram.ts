/**
 * Telegram backend — forked from the official Claude Code Telegram plugin.
 *
 * Implements ChannelBackend with full access control: pairing, allowlists,
 * group support with mention-triggering. State lives in
 * <stateDir>/access.json.
 */

import { Bot, GrammyError, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
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
  chmodSync,
} from 'fs'
import { join, extname, sep } from 'path'
import type {
  ChannelBackend,
  InboundMessage,
  SendOptions,
  SendResult,
  FetchedMessage,
  DownloadedFile,
  TelegramBackendConfig,
  AttachmentInfo,
  ChannelAccessPolicy,
} from './types.js'

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

type AttachmentMeta = {
  kind: string
  fileId: string
  size?: number
  mime?: string
  name?: string
}

// ── Constants ──────────────────────────────────────────────────────────

const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const ATTACHMENT_CACHE_CAP = 500
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// ── Helpers ────────────────────────────────────────────────────────────

function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    channels: {},
    pending: {},
  }
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// ── Telegram backend ──────────────────────────────────────────────────

export class TelegramBackend implements ChannelBackend {
  readonly name = 'telegram'
  onMessage: ((msg: InboundMessage) => void) | null = null
  onInteraction: ((interaction: { type: string; customId: string; userId: string; channelId: string; values?: string[]; message?: { id: string } }) => void) | null = null
  onSlashCommand: ((interaction: any) => void) | null = null
  onCustomCommand: ((text: string, channelId: string, userId: string, replyFn: (text: string, opts?: { embeds?: Record<string, unknown>[]; components?: Record<string, unknown>[] }) => Promise<void>) => void) | null = null

  private bot: Bot
  private botUsername = ''
  private stateDir: string
  private accessFile: string
  private approvedDir: string
  private inboxDir: string
  private token: string
  private isStatic: boolean
  private bootAccess: Access | null = null
  private approvalTimer: ReturnType<typeof setInterval> | null = null
  private shuttingDown = false
  private attachmentCache = new Map<string, AttachmentMeta[]>()
  private attachmentOrder: string[] = []

  constructor(config: TelegramBackendConfig, stateDir: string) {
    this.token = config.token
    this.stateDir = stateDir
    this.accessFile = join(stateDir, 'access.json')
    this.approvedDir = join(stateDir, 'approved')
    this.inboxDir = join(stateDir, 'inbox')
    this.isStatic = config.accessMode === 'static'
    this.bot = new Bot(this.token)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.isStatic) {
      const a = this.readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('claude2bot telegram: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      this.bootAccess = a
    }

    // Load .env from state dir
    const envFile = join(this.stateDir, '.env')
    try {
      chmodSync(envFile, 0o600)
      for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^(\w+)=(.*)$/)
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
      }
    } catch {}

    // Register bot commands
    this.bot.command('start', async ctx => {
      if (ctx.chat?.type !== 'private') return
      const access = this.loadAccess()
      if (access.dmPolicy === 'disabled') {
        await ctx.reply("This bot isn't accepting new connections.")
        return
      }
      await ctx.reply(
        'This bot bridges Telegram to a Claude Code session.\n\n' +
        'To pair:\n' +
        '1. DM me anything — you\'ll get a 6-char code\n' +
        '2. In Claude Code: /telegram:access pair <code>\n\n' +
        'After that, DMs here reach that session.'
      )
    })

    this.bot.command('help', async ctx => {
      if (ctx.chat?.type !== 'private') return
      await ctx.reply(
        'Messages you send here route to a paired Claude Code session. ' +
        'Text and photos are forwarded; replies and reactions come back.\n\n' +
        '/start — pairing instructions\n' +
        '/status — check your pairing state'
      )
    })

    this.bot.command('status', async ctx => {
      if (ctx.chat?.type !== 'private') return
      const from = ctx.from
      if (!from) return
      const senderId = String(from.id)
      const access = this.loadAccess()

      if (access.allowFrom.includes(senderId)) {
        const name = from.username ? `@${from.username}` : senderId
        await ctx.reply(`Paired as ${name}.`)
        return
      }

      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          await ctx.reply(`Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`)
          return
        }
      }

      await ctx.reply('Not paired. Send me a message to get a pairing code.')
    })

    // Register message handlers
    this.bot.on('message:text', async ctx => {
      await this.handleInbound(ctx, ctx.message.text)
    })

    this.bot.on('message:photo', async ctx => {
      const caption = ctx.message.caption ?? '(photo)'
      await this.handleInbound(ctx, caption, async () => {
        const photos = ctx.message.photo
        const best = photos[photos.length - 1]
        try {
          const file = await ctx.api.getFile(best.file_id)
          if (!file.file_path) return undefined
          const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`
          const res = await fetch(url)
          const buf = Buffer.from(await res.arrayBuffer())
          const ext = file.file_path.split('.').pop() ?? 'jpg'
          const path = join(this.inboxDir, `${Date.now()}-${best.file_unique_id}.${ext}`)
          mkdirSync(this.inboxDir, { recursive: true })
          writeFileSync(path, buf)
          return path
        } catch (err) {
          process.stderr.write(`claude2bot telegram: photo download failed: ${err}\n`)
          return undefined
        }
      })
    })

    this.bot.on('message:document', async ctx => {
      const doc = ctx.message.document
      const name = safeName(doc.file_name)
      const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
      await this.handleInbound(ctx, text, undefined, {
        kind: 'document',
        fileId: doc.file_id,
        size: doc.file_size,
        mime: doc.mime_type,
        name,
      })
    })

    this.bot.on('message:voice', async ctx => {
      const voice = ctx.message.voice
      const text = ctx.message.caption ?? '(voice message)'
      await this.handleInbound(ctx, text, undefined, {
        kind: 'voice',
        fileId: voice.file_id,
        size: voice.file_size,
        mime: voice.mime_type,
      })
    })

    this.bot.on('message:audio', async ctx => {
      const audio = ctx.message.audio
      const name = safeName(audio.file_name)
      const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
      await this.handleInbound(ctx, text, undefined, {
        kind: 'audio',
        fileId: audio.file_id,
        size: audio.file_size,
        mime: audio.mime_type,
        name,
      })
    })

    this.bot.on('message:video', async ctx => {
      const video = ctx.message.video
      const text = ctx.message.caption ?? '(video)'
      await this.handleInbound(ctx, text, undefined, {
        kind: 'video',
        fileId: video.file_id,
        size: video.file_size,
        mime: video.mime_type,
        name: safeName(video.file_name),
      })
    })

    this.bot.on('message:video_note', async ctx => {
      const vn = ctx.message.video_note
      await this.handleInbound(ctx, '(video note)', undefined, {
        kind: 'video_note',
        fileId: vn.file_id,
        size: vn.file_size,
      })
    })

    this.bot.on('message:sticker', async ctx => {
      const sticker = ctx.message.sticker
      const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
      await this.handleInbound(ctx, `(sticker${emoji})`, undefined, {
        kind: 'sticker',
        fileId: sticker.file_id,
        size: sticker.file_size,
      })
    })

    // Error handler — keep polling on handler errors
    this.bot.catch(err => {
      process.stderr.write(`claude2bot telegram: handler error (polling continues): ${err.error}\n`)
    })

    // Approval polling
    if (!this.isStatic) {
      this.approvalTimer = setInterval(() => this.checkApprovals(), 5000)
    }

    // Shutdown on stdin close
    const shutdown = () => {
      if (this.shuttingDown) return
      this.shuttingDown = true
      process.stderr.write('claude2bot telegram: shutting down\n')
      setTimeout(() => process.exit(0), 2000)
      void Promise.resolve(this.bot.stop()).finally(() => process.exit(0))
    }
    process.stdin.on('end', shutdown)
    process.stdin.on('close', shutdown)

    // Start bot polling with 409 retry
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.bot.start({
            onStart: info => {
              this.botUsername = info.username
              process.stderr.write(`claude2bot telegram: polling as @${info.username}\n`)
              void this.bot.api.setMyCommands(
                [
                  { command: 'start', description: 'Welcome and setup guide' },
                  { command: 'help', description: 'What this bot can do' },
                  { command: 'status', description: 'Check your pairing status' },
                ],
                { scope: { type: 'all_private_chats' } },
              ).catch(() => {})
            },
          })
          return
        } catch (err) {
          if (err instanceof GrammyError && err.error_code === 409) {
            const delay = Math.min(1000 * attempt, 15000)
            const detail = attempt === 1
              ? ' — another instance is polling (zombie session, or a second Claude Code running?)'
              : ''
            process.stderr.write(
              `claude2bot telegram: 409 Conflict${detail}, retrying in ${delay / 1000}s\n`,
            )
            await new Promise(r => setTimeout(r, delay))
            continue
          }
          if (err instanceof Error && err.message === 'Aborted delay') return
          process.stderr.write(`claude2bot telegram: polling failed: ${err}\n`)
          return
        }
      }
    })()
  }

  async disconnect(): Promise<void> {
    if (this.approvalTimer) {
      clearInterval(this.approvalTimer)
      this.approvalTimer = null
    }
    this.shuttingDown = true
    await this.bot.stop()
  }

  // ── Outbound operations ────────────────────────────────────────────

  async sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<SendResult> {
    this.assertAllowedChat(chatId)

    const files = opts?.files ?? []
    const replyTo = opts?.replyTo != null ? Number(opts.replyTo) : undefined

    for (const f of files) {
      this.assertSendable(f)
      const st = statSync(f)
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
      }
    }

    const access = this.loadAccess()
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
    const mode = access.chunkMode ?? 'length'
    const replyMode = access.replyToMode ?? 'first'
    const chunks = chunk(text, limit, mode)
    const sentIds: string[] = []

    try {
      for (let i = 0; i < chunks.length; i++) {
        const shouldReplyTo =
          replyTo != null &&
          replyMode !== 'off' &&
          (replyMode === 'all' || i === 0)
        const sent = await this.bot.api.sendMessage(chatId, chunks[i], {
          ...(shouldReplyTo ? { reply_parameters: { message_id: replyTo } } : {}),
        })
        sentIds.push(String(sent.message_id))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`send failed after ${sentIds.length}/${chunks.length} chunk(s): ${msg}`)
    }

    // Files go as separate messages (Telegram doesn't mix text+file in one call)
    for (const f of files) {
      const ext = extname(f).toLowerCase()
      const input = new InputFile(f)
      const replyOpts = replyTo != null && replyMode !== 'off'
        ? { reply_parameters: { message_id: replyTo } }
        : undefined
      if (PHOTO_EXTS.has(ext)) {
        const sent = await this.bot.api.sendPhoto(chatId, input, replyOpts)
        sentIds.push(String(sent.message_id))
      } else {
        const sent = await this.bot.api.sendDocument(chatId, input, replyOpts)
        sentIds.push(String(sent.message_id))
      }
    }

    return { sentIds }
  }

  async fetchMessages(_channelId: string, _limit: number): Promise<FetchedMessage[]> {
    throw new Error(
      "Telegram's Bot API does not expose message history. " +
      'Ask the user to paste the content or summarize.'
    )
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.assertAllowedChat(chatId)
    await this.bot.api.setMessageReaction(chatId, Number(messageId), [
      { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
    ])
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<string> {
    this.assertAllowedChat(chatId)
    const edited = await this.bot.api.editMessageText(chatId, Number(messageId), text)
    const id = typeof edited === 'object' ? edited.message_id : messageId
    return String(id)
  }

  async downloadAttachment(_chatId: string, messageId: string): Promise<DownloadedFile[]> {
    const cached = this.attachmentCache.get(messageId)
    if (!cached || cached.length === 0) return []

    const results: DownloadedFile[] = []
    for (const entry of cached) {
      const file = await this.bot.api.getFile(entry.fileId)
      if (!file.file_path) continue

      const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())

      const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
      const path = join(this.inboxDir, `${Date.now()}-${uniqueId}.${ext}`)
      mkdirSync(this.inboxDir, { recursive: true })
      writeFileSync(path, buf)

      results.push({
        path,
        name: entry.name ?? `${uniqueId}.${ext}`,
        contentType: entry.mime ?? 'application/octet-stream',
        size: buf.length,
      })
    }
    return results
  }

  async validateChannel(chatId: string): Promise<void> {
    this.assertAllowedChat(chatId)
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
      process.stderr.write('claude2bot telegram: access.json corrupt, moved aside. Starting fresh.\n')
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

  private gate(ctx: Context): GateResult {
    const access = this.loadAccess()
    if (this.pruneExpired(access)) this.saveAccess(access)

    if (access.dmPolicy === 'disabled') return { action: 'drop' }

    const from = ctx.from
    if (!from) return { action: 'drop' }
    const senderId = String(from.id)
    const chatType = ctx.chat?.type

    if (chatType === 'private') {
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
        chatId: String(ctx.chat!.id),
        createdAt: now,
        expiresAt: now + 60 * 60 * 1000,
        replies: 1,
      }
      this.saveAccess(access)
      return { action: 'pair', code, isResend: false }
    }

    if (chatType === 'group' || chatType === 'supergroup') {
      const groupId = String(ctx.chat!.id)
      const policy = access.channels[groupId]
      if (!policy) return { action: 'drop' }
      const channelAllowFrom = policy.allowFrom ?? []
      const requireMention = policy.requireMention ?? true
      if (channelAllowFrom.length > 0 && !channelAllowFrom.includes(senderId)) {
        return { action: 'drop' }
      }
      if (requireMention && !this.isMentioned(ctx, access.mentionPatterns)) {
        return { action: 'drop' }
      }
      return { action: 'deliver', access }
    }

    return { action: 'drop' }
  }

  private isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
    const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
    const text = ctx.message?.text ?? ctx.message?.caption ?? ''
    for (const e of entities) {
      if (e.type === 'mention') {
        const mentioned = text.slice(e.offset, e.offset + e.length)
        if (mentioned.toLowerCase() === `@${this.botUsername}`.toLowerCase()) return true
      }
      if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === this.botUsername) {
        return true
      }
    }

    if (ctx.message?.reply_to_message?.from?.username === this.botUsername) return true

    for (const pat of extraPatterns ?? []) {
      try {
        if (new RegExp(pat, 'i').test(text)) return true
      } catch {}
    }
    return false
  }

  private assertAllowedChat(chatId: string): void {
    const access = this.loadAccess()
    if (access.allowFrom.includes(chatId)) return
    if (chatId in access.channels) return
    throw new Error(`chat ${chatId} is not allowlisted — add via /telegram:access`)
  }

  // ── Inbound handling ───────────────────────────────────────────────

  private async handleInbound(
    ctx: Context,
    text: string,
    downloadImage?: () => Promise<string | undefined>,
    attachment?: AttachmentMeta,
  ): Promise<void> {
    const result = this.gate(ctx)
    if (result.action === 'drop') return

    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      return
    }

    const access = result.access
    const from = ctx.from!
    const chatId = String(ctx.chat!.id)
    const msgId = ctx.message?.message_id

    // Typing indicator
    void this.bot.api.sendChatAction(chatId, 'typing').catch(() => {})

    // Ack reaction
    if (access.ackReaction && msgId != null) {
      void this.bot.api
        .setMessageReaction(chatId, msgId, [
          { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
        ])
        .catch(() => {})
    }

    const imagePath = downloadImage ? await downloadImage() : undefined

    // Cache attachment for later downloadAttachment calls
    if (attachment && msgId != null) {
      this.cacheAttachment(String(msgId), attachment)
    }

    // Build attachment info
    const atts: AttachmentInfo[] = []
    if (attachment) {
      atts.push({
        name: attachment.name ?? attachment.kind,
        contentType: attachment.mime ?? 'application/octet-stream',
        size: attachment.size ?? 0,
      })
    }

    if (this.onMessage) {
      this.onMessage({
        chatId,
        messageId: msgId != null ? String(msgId) : '',
        user: from.username ?? String(from.id),
        userId: String(from.id),
        text: text || (atts.length > 0 ? '(attachment)' : ''),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        attachments: atts,
        imagePath,
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
      void this.bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
        () => rmSync(file, { force: true }),
        err => {
          process.stderr.write(`claude2bot telegram: approval confirm failed: ${err}\n`)
          rmSync(file, { force: true })
        },
      )
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

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

  private cacheAttachment(messageId: string, entry: AttachmentMeta): void {
    const existing = this.attachmentCache.get(messageId) ?? []
    existing.push(entry)
    this.attachmentCache.set(messageId, existing)
    this.attachmentOrder.push(messageId)
    while (this.attachmentOrder.length > ATTACHMENT_CACHE_CAP) {
      const old = this.attachmentOrder.shift()!
      if (!this.attachmentOrder.includes(old)) {
        this.attachmentCache.delete(old)
      }
    }
  }
}
