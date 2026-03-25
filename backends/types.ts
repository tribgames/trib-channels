/**
 * ChannelBackend — abstract interface for messaging platform integrations.
 *
 * Each backend (Discord, Telegram, Slack, etc.) implements this interface
 * to provide a unified messaging layer to the MCP server.
 */

// ── Inbound message from a messaging platform ──────────────────────────

export interface AttachmentInfo {
  name: string
  contentType: string
  /** Size in bytes */
  size: number
}

export interface InboundMessage {
  chatId: string
  messageId: string
  user: string
  userId: string
  text: string
  /** ISO 8601 timestamp */
  ts: string
  attachments: AttachmentInfo[]
  /** Local file path of an inline image (Telegram photos) */
  imagePath?: string
}

// ── Outbound types ─────────────────────────────────────────────────────

export interface SendOptions {
  /** Message ID to thread/reply under */
  replyTo?: string
  /** Absolute file paths to attach */
  files?: string[]
  /** Discord embed objects (passed directly to Discord API) */
  embeds?: Record<string, unknown>[]
  /** Discord message components (Action Row, Button, Select Menu, etc.) */
  components?: Record<string, unknown>[]
}

export interface SendResult {
  /** IDs of sent message(s) — may be split into multiple chunks */
  sentIds: string[]
}

export interface FetchedMessage {
  id: string
  user: string
  text: string
  /** ISO 8601 timestamp */
  ts: string
  isMe: boolean
  attachmentCount: number
}

export interface DownloadedFile {
  path: string
  name: string
  contentType: string
  /** Size in bytes */
  size: number
}

// ── Backend interface ──────────────────────────────────────────────────

export interface ChannelBackend {
  /** Backend identifier (e.g. "discord", "telegram") */
  readonly name: string

  /**
   * Connect to the messaging platform.
   * Must be called before any other method.
   */
  connect(): Promise<void>

  /**
   * Gracefully disconnect from the platform.
   */
  disconnect(): Promise<void>

  /**
   * Send a message to a chat. Long messages are automatically chunked
   * per platform limits. Returns IDs of all sent message parts.
   */
  sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<SendResult>

  /**
   * Fetch recent messages from a channel, oldest first.
   */
  fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]>

  /**
   * Add an emoji reaction to a message.
   */
  react(chatId: string, messageId: string, emoji: string): Promise<void>

  /**
   * Remove the bot's emoji reaction from a message.
   */
  removeReaction(chatId: string, messageId: string, emoji: string): Promise<void>

  /**
   * Edit a previously sent message. Returns the edited message ID.
   */
  editMessage(chatId: string, messageId: string, text: string): Promise<string>

  /**
   * Download all attachments from a message. Returns local file paths.
   */
  downloadAttachment(chatId: string, messageId: string): Promise<DownloadedFile[]>

  /**
   * Validate that an outbound message to this chat is allowed.
   * Throws if the channel is not in the allowlist.
   */
  validateChannel(chatId: string): Promise<void>

  /**
   * Start the typing indicator for a channel.
   * Sends the initial typing event and sets up a repeating interval.
   */
  startTyping(channelId: string): void

  /**
   * Stop the typing indicator for a channel.
   * Clears the repeating interval if active.
   */
  stopTyping(channelId: string): void

  /**
   * Callback invoked when an inbound message passes the access gate.
   * Set by the MCP server to route messages as notifications.
   */
  onMessage: ((msg: InboundMessage) => void) | null

  /**
   * Callback invoked when a Discord interaction (button click, select menu) occurs.
   */
  onInteraction: ((interaction: { type: string; customId: string; userId: string; channelId: string; values?: string[]; message?: { id: string } }) => void) | null

  /**
   * Callback invoked when a Discord slash command is received.
   * Set by the MCP server to handle /claude subcommands.
   * Only meaningful for Discord backend; other backends should set to null.
   */
  onSlashCommand: ((interaction: any) => void) | null

  /**
   * Callback invoked when a functional command (/bot, /profile) is detected.
   * The replyFn sends the response back to the same channel.
   */
  onCustomCommand: ((text: string, channelId: string, userId: string, replyFn: (text: string, opts?: { embeds?: Record<string, unknown>[]; components?: Record<string, unknown>[] }) => Promise<void>) => void) | null
}

// ── Channel types ─────────────────────────────────────────────────────

export interface ChannelEntry {
  /** Platform-specific channel ID */
  id: string
  /** "interactive" = listen + respond, "monitor" = listen only, report to main */
  mode: 'interactive' | 'monitor'
}

export interface ChannelsConfig {
  /** Label of the main channel (key in channels map) */
  main: string
  /** Named channels — key is a human-readable label, value has id + mode */
  channels: Record<string, ChannelEntry>
}

// ── Access types ──────────────────────────────────────────────────────

export interface ChannelAccessPolicy {
  /** Whether the bot requires an @mention to respond */
  requireMention: boolean
  /** User IDs allowed to interact; empty = everyone */
  allowFrom: string[]
}

// ── Voice types ───────────────────────────────────────────────────────

export interface VoiceConfig {
  /** Whether voice message transcription is enabled */
  enabled: boolean
  /** Whisper binary name or absolute path (default: auto-detect whisper-cli) */
  command?: string
  /** GGML model file path (omit to use whisper's built-in default) */
  model?: string
  /** BCP-47 language code or "auto" for auto-detect (default: "auto") */
  language?: string
}

// ── Backend config types ───────────────────────────────────────────────

export interface DiscordBackendConfig {
  token: string
  stateDir?: string
  accessMode?: 'static' | 'dynamic'
}

export interface TelegramBackendConfig {
  token: string
  stateDir?: string
  accessMode?: 'static' | 'dynamic'
}

export interface PluginConfig {
  backend: 'discord' | 'telegram'
  telegram?: TelegramBackendConfig
  discord?: DiscordBackendConfig
  /** Named channel configuration */
  channelsConfig?: ChannelsConfig
  /** MD file paths to inject as additional context into instructions */
  contextFiles?: string[]
  /** Spawns a separate claude -p session at the scheduled time */
  nonInteractive?: TimedSchedule[]
  /** Injects prompt into the current session at the scheduled time */
  interactive?: TimedSchedule[]
  /** Bot-initiated conversation based on frequency and idle guard */
  proactive?: ProactiveConfig
  /** Directory containing prompt .md files */
  promptsDir?: string
  /** Voice message transcription settings */
  voice?: VoiceConfig
}

// ── Bot config (bot.json) ─────────────────────────────────────────────

export interface QuietConfig {
  /** Quiet hours for timed schedules "HH:MM-HH:MM" (e.g. "23:00-07:00") */
  schedule?: string
  /** Quiet hours for autotalk/proactive "HH:MM-HH:MM" (e.g. "23:00-09:00") */
  autotalk?: string
  /** ISO 3166-1 alpha-2 country code for public holiday lookup (e.g. "KR") */
  holidays?: string
  /** IANA timezone for date evaluation (e.g. "Asia/Seoul"). Default: system tz */
  timezone?: string
}

export interface AutotalkConfig {
  /** Frequency level 1-5 */
  freq?: number
  /** Whether autotalk is enabled */
  enabled?: boolean
}

export interface BotConfig {
  quiet?: QuietConfig
  autotalk?: AutotalkConfig
}

// ── Profile config (profile.json) ────────────────────────────────────

export interface ProfileConfig {
  name?: string
  role?: string
  lang?: string
  tone?: string
  [key: string]: string | undefined
}

// ── Schedule types ─────────────────────────────────────────────────────

/** Shared shape for non-interactive and interactive schedules */
export interface TimedSchedule {
  /** Unique name (kebab-case), also used as prompt filename */
  name: string
  /** "HH:MM" (24h), "hourly", or interval like "every5m", "every10m", "every30m" */
  time: string
  /** "daily" or "weekday" (Mon-Fri, skips weekends). Default: "daily" */
  days?: 'daily' | 'weekday'
  /** Target channel label (resolved to ID via channelsConfig) */
  channel: string
  /** Prompt file path relative to promptsDir, or absolute path */
  prompt?: string
  /** Whether this schedule is enabled (default: true) */
  enabled?: boolean
  /** Execution mode: 'prompt' (default), 'script', or 'script+prompt' */
  exec?: 'prompt' | 'script' | 'script+prompt'
  /** Script filename in scripts directory (e.g. 'market.js') */
  script?: string
}

/** A single proactive conversation topic */
export interface ProactiveItem {
  /** Topic name — also used as prompt filename ({topic}.md) */
  topic: string
  /** Target channel label (resolved to ID via channelsConfig) */
  channel: string
}

/** Configuration for bot-initiated proactive conversations */
export interface ProactiveConfig {
  /** Frequency level 1-5 (1 = ~1/day, 2 = ~2/day, 3 = ~4/day, 4 = ~7/day, 5 = ~10/day) */
  frequency: number
  /** Whether to append proactive-feedback.md to prompts */
  feedback: boolean
  /** Topic items — each gets its own prompt file */
  items: ProactiveItem[]
  /** Do-not-disturb start time "HH:MM" (e.g. "23:00") */
  dndStart?: string
  /** Do-not-disturb end time "HH:MM" (e.g. "07:00") */
  dndEnd?: string
}
