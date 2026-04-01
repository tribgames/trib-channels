/**
 * Functional command parser and handlers for /bot(...) and /profile(...).
 *
 * Syntax: /cmd(arg1, arg2, key="value", key2="value2")
 * - Positional args fill sub, action, name in order
 * - key=value pairs go into params
 * - Quoted strings preserve spaces
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { DATA_DIR, loadConfig, loadBotConfig, saveBotConfig, loadProfileConfig, saveProfileConfig } from './config.js'
import type { PluginConfig, TimedSchedule } from '../backends/types.js'
import type { Scheduler } from './scheduler.js'
import { t } from './i18n.js'

// ── Types ────────────────────────────────────────────────────────────

export interface ParsedCommand {
  cmd: string                    // 'bot' | 'profile'
  args: string[]                 // positional args
  params: Record<string, string> // key=value pairs
}

export interface CommandResult {
  text?: string
  embeds?: Record<string, unknown>[]
  components?: Record<string, unknown>[]
}

export interface CommandContext {
  scheduler: Scheduler
  channelId: string
  userId: string
  lang: 'ko' | 'en'
  reloadRuntimeConfig?: () => void
}

function makeParsedCommand(
  cmd: ParsedCommand['cmd'],
  args: string[] = [],
  params: Record<string, string> = {},
): ParsedCommand {
  return { cmd, args, params }
}

// ── Parser ───────────────────────────────────────────────────────────

/**
 * Parse /cmd(arg1, arg2, key="val") into structured form.
 * Returns null if input is not a functional command.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const match = input.match(/^\/(bot|profile)\s*\((.*)?\)\s*$/s)
  if (!match) return null

  const cmd = match[1]
  const inner = (match[2] ?? '').trim()
  if (!inner) return { cmd, args: [], params: {} }

  const args: string[] = []
  const params: Record<string, string> = {}

  // Tokenize: split on commas, respecting quoted strings
  const tokens: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true
      quoteChar = ch
    } else if (ch === ',') {
      tokens.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) tokens.push(current.trim())

  for (const token of tokens) {
    const eqIdx = token.indexOf('=')
    if (eqIdx > 0) {
      const key = token.slice(0, eqIdx).trim()
      let val = token.slice(eqIdx + 1).trim()
      // Strip surrounding quotes from value
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      params[key] = val
    } else {
      args.push(token)
    }
  }

  return { cmd, args, params }
}

// ── Config helpers ───────────────────────────────────────────────────

function savePluginConfig(config: PluginConfig): void {
  const configPath = join(DATA_DIR, 'config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
}

function refreshRuntime(ctx: CommandContext): void {
  if (ctx.reloadRuntimeConfig) ctx.reloadRuntimeConfig()
  else ctx.scheduler.restart()
}

// ── /bot handler ─────────────────────────────────────────────────────

export async function handleBotCommand(
  parsed: ParsedCommand,
  ctx: CommandContext,
): Promise<CommandResult> {
  const sub = parsed.args[0] ?? 'status'

  switch (sub) {
    case 'schedule':
      return handleSchedule(parsed, ctx)
    case 'autotalk':
      return handleAutotalk(parsed, ctx)
    case 'quiet':
      return handleQuiet(parsed, ctx)
    case 'activity':
      return handleActivity(parsed, ctx)
    case 'profile':
      return handleBotProfile(parsed, ctx)
    case 'sleeping':
      return handleSleeping(parsed, ctx)
    case 'display':
      return handleDisplay(parsed, ctx)
    case 'status':
      return handleBotStatus(ctx)
    case 'help':
      return {
        embeds: [{
          title: 'trib-channels Commands',
          description: [
            '**Simple**',
            '`/bot status`',
            '`/bot profile`',
            '`/bot schedule list`',
            '',
            '**Parameterized**',
            '`/bot autotalk on|off|freq=1-5`',
            '`/bot quiet schedule HH:MM-HH:MM`',
            '`/bot sleeping on|off|run|time HH:MM`',
            '`/bot display view|hide`',
            '`/bot schedule add ...`',
            '',
            '**Guided setup**',
            'Use `/trib-channels setup` for first-run onboarding.',
          ].join('\n'),
          color: 0x5865F2,
        }],
      }
    default:
      return { text: t('unknown_sub', ctx.lang, { sub }) }
  }
}

// ── /bot(status) ─────────────────────────────────────────────────────

function handleBotStatus(_ctx: CommandContext): CommandResult {
  const config = loadConfig()
  const bot = loadBotConfig()
  const ni = config.nonInteractive ?? []
  const i = config.interactive ?? []

  const lines: string[] = []
  lines.push(`**Schedules** ${ni.length + i.length} registered`)

  const autotalkStatus = bot.autotalk?.enabled ? `freq=${bot.autotalk.freq ?? 3}, active` : 'inactive'
  lines.push(`**Autotalk** ${autotalkStatus}`)

  const quietParts: string[] = []
  if (bot.quiet?.schedule) quietParts.push(bot.quiet.schedule)
  if (bot.quiet?.autotalk) quietParts.push(`autotalk ${bot.quiet.autotalk}`)
  lines.push(`**Quiet** ${quietParts.length > 0 ? quietParts.join(', ') : 'none'}`)

  const chCount = Object.keys(config.channelsConfig?.channels ?? {}).length
  lines.push(`**Channels** ${chCount}`)

  const profile = loadProfileConfig()
  lines.push(`**Profile** ${profile.name || '-'}`)

  return {
    embeds: [{
      title: '\u2699\uFE0F Bot Dashboard',
      description: lines.join('\n'),
      color: 0x5865F2,
    }],
  }
}

// ── /bot(activity, ...) ─────────────────────────────────────────────

function handleActivity(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const action = parsed.args[1] ?? 'list'
  switch (action) {
    case 'list':
      return activityList(ctx)
    case 'add':
      return activityAdd(parsed, ctx)
    case 'remove':
      return activityRemove(parsed, ctx)
    default:
      return { text: t('unknown_action', ctx.lang, { action }) }
  }
}

function activityList(ctx: CommandContext): CommandResult {
  const config = loadConfig()
  const channels = config.channelsConfig?.channels ?? {}
  const main = config.channelsConfig?.main ?? ''
  const entries = Object.entries(channels)

  if (entries.length === 0) {
    return {
      embeds: [{
        title: '\uD83D\uDCE1 Activity Channels',
        description: t('activity.empty', ctx.lang),
        color: 0x5865F2,
      }],
    }
  }

  // Render the list in the embed description.
  const chLines = entries.map(([name, entry]) => {
    const star = name === main ? ' \u2B50' : ''
    return `**${name}${star}** — ${entry.mode} (\`${entry.id}\`)`
  })

// [components removed]

  // Remove buttons (max 5 per row)
// [components removed]


  return {
    embeds: [{ title: '\uD83D\uDCE1 Activity Channels', description: chLines.join('\n'), color: 0x5865F2 }],
  }
}

function activityAdd(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('activity.missing_name', ctx.lang) }

  const id = parsed.params.id
  if (!id) return { text: t('activity.missing_id', ctx.lang) }

  const mode = (parsed.params.mode ?? 'interactive') as 'interactive' | 'monitor'

  const config = loadConfig()
  if (!config.channelsConfig) {
    config.channelsConfig = { main: name, channels: {} }
  }

  if (config.channelsConfig.channels[name]) {
    return { text: t('activity.exists', ctx.lang, { name }) }
  }

  config.channelsConfig.channels[name] = { id, mode }
  if (!config.access) {
    config.access = {
      dmPolicy: 'pairing',
      allowFrom: [],
      channels: {},
    }
  }
  if (!config.access.channels[id]) {
    config.access.channels[id] = { requireMention: true, allowFrom: [] }
  }
  savePluginConfig(config)
  refreshRuntime(ctx)

  return { text: t('activity.added', ctx.lang, { name }) }
}

function activityRemove(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('activity.missing_name', ctx.lang) }

  const config = loadConfig()
  if (!config.channelsConfig?.channels[name]) {
    return { text: t('activity.not_found', ctx.lang, { name }) }
  }

  const removedId = config.channelsConfig.channels[name].id
  delete config.channelsConfig.channels[name]
  if (removedId && config.access?.channels?.[removedId]) {
    delete config.access.channels[removedId]
  }
  savePluginConfig(config)
  refreshRuntime(ctx)

  return { text: t('activity.removed', ctx.lang, { name }) }
}

// ── /bot(profile) ───────────────────────────────────────────────────

function handleBotProfile(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  // /bot(profile, set, name="...", ...) — parameter-based update
  if ((parsed.args[1] === 'set' || Object.keys(parsed.params).length > 0) && parsed.args[0] === 'profile') {
    return handleProfileCommand(
      { cmd: 'profile', args: ['set'], params: parsed.params },
      ctx,
    )
  }

  // Default view: show the profile with edit and navigation buttons.
  const profile = loadProfileConfig()
  const entries = Object.entries(profile).filter(([_, v]) => v !== undefined)

// [components removed]

  if (entries.length === 0) {
    return {
      embeds: [{
        title: '\uD83D\uDC64 Profile',
        description: t('profile.empty', ctx.lang),
        color: 0x57F287,
      }],
    }
  }

  const profileLines = entries.map(([k, v]) => `**${k}**: ${v}`)

  return {
    embeds: [{ title: '\uD83D\uDC64 Profile', description: profileLines.join('\n'), color: 0x57F287 }],
  }
}

// ── /bot(autotalk, ...) ──────────────────────────────────────────────

function handleAutotalk(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const action = parsed.args[1] ?? 'status'
  const bot = loadBotConfig()

  // /bot(autotalk, freq=N) — frequency is passed as a named parameter.
  if (parsed.params.freq) {
    const freq = Math.max(1, Math.min(5, parseInt(parsed.params.freq, 10) || 3))
    if (!bot.autotalk) bot.autotalk = {}
    bot.autotalk.freq = freq
    saveBotConfig(bot)
    refreshRuntime(ctx)
    return { text: t('autotalk.freq_updated', ctx.lang, { freq: String(freq) }) }
  }

  switch (action) {
    case 'status':
    case 'list': {
      const freq = bot.autotalk?.freq ?? '-'
      const enabled = bot.autotalk?.enabled ?? false
      const statusEmoji = enabled ? '\u2705' : '\u274C'

      return {
        embeds: [{
          title: `\uD83D\uDCAC ${t('autotalk.status', ctx.lang)}`,
          description: `**Freq**: ${freq}\n**Status**: ${statusEmoji} ${enabled ? 'ON' : 'OFF'}`,
          color: 0x5865F2,
        }],
      }
    }
    case 'on': {
      if (!bot.autotalk) bot.autotalk = {}
      bot.autotalk.enabled = true
      saveBotConfig(bot)
      refreshRuntime(ctx)
      return { text: t('autotalk.enabled', ctx.lang) }
    }
    case 'off': {
      if (!bot.autotalk) bot.autotalk = {}
      bot.autotalk.enabled = false
      saveBotConfig(bot)
      refreshRuntime(ctx)
      return { text: t('autotalk.disabled', ctx.lang) }
    }
    default:
      return { text: t('unknown_action', ctx.lang, { action }) }
  }
}

// ── /bot(quiet, ...) ────────────────────────────────────────────────

function handleQuiet(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const action = parsed.args[1] ?? 'status'
  const bot = loadBotConfig()
  const value = parsed.args[2] ?? parsed.params.value

  switch (action) {
    case 'status':
    case 'list': {
      const q = bot.quiet ?? {}
      const lines: string[] = [
        `**\uC2A4\uCF00\uC904 \uBC29\uD574\uAE08\uC9C0**: ${q.schedule ?? '-'}`,
        `**\uC790\uC728\uB300\uD654 \uBC29\uD574\uAE08\uC9C0**: ${q.autotalk ?? '-'}`,
        `**\uACF5\uD734\uC77C \uAD6D\uAC00**: ${q.holidays ?? '-'}`,
        `**\uC2DC\uAC04\uB300**: ${q.timezone ?? 'system'}`,
      ]

      return {
        embeds: [{
          title: `\uD83D\uDD15 ${t('quiet.status', ctx.lang)}`,
          description: lines.join('\n'),
          color: 0x5865F2,
        }],
      }
    }
    case 'schedule': {
      if (!value) return { text: t('unknown_action', ctx.lang, { action: 'schedule (value required)' }) }
      if (!bot.quiet) bot.quiet = {}
      bot.quiet.schedule = value
      saveBotConfig(bot)
      refreshRuntime(ctx)
      return { text: t('quiet.updated', ctx.lang) }
    }
    case 'autotalk': {
      if (!value) return { text: t('unknown_action', ctx.lang, { action: 'autotalk (value required)' }) }
      if (!bot.quiet) bot.quiet = {}
      bot.quiet.autotalk = value
      saveBotConfig(bot)
      refreshRuntime(ctx)
      return { text: t('quiet.updated', ctx.lang) }
    }
    case 'holidays': {
      if (!value) return { text: t('unknown_action', ctx.lang, { action: 'holidays (value required)' }) }
      if (!bot.quiet) bot.quiet = {}
      bot.quiet.holidays = value
      saveBotConfig(bot)
      refreshRuntime(ctx)
      return { text: t('quiet.updated', ctx.lang) }
    }
    case 'timezone': {
      if (!value) return { text: t('unknown_action', ctx.lang, { action: 'timezone (value required)' }) }
      if (!bot.quiet) bot.quiet = {}
      bot.quiet.timezone = value
      saveBotConfig(bot)
      refreshRuntime(ctx)
      return { text: t('quiet.updated', ctx.lang) }
    }
    default:
      return { text: t('unknown_action', ctx.lang, { action }) }
  }
}

// ── /bot(sleeping, ...) ──────────────────────────────────────────────

function handleSleeping(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const action = parsed.args[1] ?? 'status'

  switch (action) {
    case 'status': {
      const config = loadBotConfig()
      const enabled = config?.sleepEnabled !== false
      const time = config?.sleepTime ?? '03:00'

      return {
        embeds: [{
          title: '\uD83E\uDDE0 Memory Summarize',
          description: `**Status**: ${enabled ? 'ON' : 'OFF'}\n**Summarize Time**: ${time}`,
          color: 0x5865F2,
        }],
      }
    }
    case 'on': {
      writeBotField('sleepEnabled', true)
      return { text: 'Memory Summarize enabled.' }
    }
    case 'off': {
      writeBotField('sleepEnabled', false)
      return { text: 'Memory Summarize disabled.' }
    }
    case 'time': {
      const time = parsed.args[2] ?? parsed.params.time
      if (!time) return { text: 'Usage: /bot sleeping time HH:MM' }
      writeBotField('sleepTime', time)
      return { text: `Summarize time set to ${time}` }
    }
    case 'now':
    case 'run': {
      return { text: 'Use `/trib-channels memory sleep` or MCP `memory_cycle` tool to run memory summarize.' }
    }
    default:
      return { text: t('unknown_action', ctx.lang, { action }) }
  }
}

// ── /bot(display, ...) ──────────────────────────────────────────────

function handleDisplay(parsed: ParsedCommand, _ctx: CommandContext): CommandResult {
  const mode = parsed.args[1]

  if (!mode) {
    const config = loadBotConfig()
    const displayMode = config?.displayMode ?? 'view'
    return {
      embeds: [{
        title: '\uD83D\uDDA5 Display Mode',
        description: `**Current**: ${displayMode}`,
        color: 0x5865F2,
      }],
    }
  }

  if (mode === 'view' || mode === 'hide') {
    writeBotField('displayMode', mode)
    return { text: `Display mode set to ${mode}.` }
  }

  return { text: 'Usage: /bot display [view|hide]' }
}

// ── Bot config helpers (sleeping, display) ──────────────────────────

function writeBotField(key: string, value: any): void {
  const bot = loadBotConfig()
  ;(bot as any)[key] = value
  saveBotConfig(bot)
}

// ── /bot(schedule, ...) ──────────────────────────────────────────────

async function handleSchedule(
  parsed: ParsedCommand,
  ctx: CommandContext,
): Promise<CommandResult> {
  const action = parsed.args[1] ?? 'list'

  switch (action) {
    case 'list':
      return scheduleList(ctx)
    case 'detail':
      return scheduleDetail(parsed, ctx)
    case 'add':
      return scheduleAdd(parsed, ctx)
    case 'edit':
      return scheduleEdit(parsed, ctx)
    case 'remove':
      return scheduleRemove(parsed, ctx)
    case 'test':
      return scheduleTest(parsed, ctx)
    default:
      return { text: t('unknown_action', ctx.lang, { action }) }
  }
}

function scheduleList(ctx: CommandContext): CommandResult {
  const config = loadConfig()
  const all: Array<TimedSchedule & { type: string }> = [
    ...(config.nonInteractive ?? []).map(s => ({ ...s, type: 'non-interactive' })),
    ...(config.interactive ?? []).map(s => ({ ...s, type: 'interactive' })),
  ]

  if (all.length === 0) {
    return { text: t('schedule.empty', ctx.lang) }
  }

  // Render the list in the embed description.
  const lines = all.map(s => {
    const status = s.enabled === false ? ' [OFF]' : ''
    const days = s.days ?? 'daily'
    return `**${s.name}** — ${s.time} ${days}${status}`
  })

  // Build select menu options (max 25 per Discord limit)
  const options = all.slice(0, 25).map(s => ({
    label: s.name,
    value: s.name,
    description: `${s.time} (${s.type})`.substring(0, 100),
  }))

// [components removed]

  if (options.length > 0) {
  }


  return {
    embeds: [{
      title: '\uD83D\uDCC5 Schedule',
      description: lines.join('\n'),
      color: 0x5865F2,
    }],
  }
}

function scheduleDetail(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('schedule.missing_name', ctx.lang) }

  const config = loadConfig()
  let entry: TimedSchedule | undefined
  let schedType = ''

  for (const [key, label] of [['interactive', 'interactive'], ['nonInteractive', 'non-interactive']] as const) {
    const list = config[key]
    if (!list) continue
    const found = list.find(s => s.name === name)
    if (found) { entry = found; schedType = label; break }
  }

  if (!entry) return { text: t('schedule.not_found', ctx.lang, { name }) }

  // Render the details in the embed description.
  const detailLines = [
    `**Time**: ${entry.time}`,
    `**Period**: ${entry.days ?? 'daily'}`,
    `**Mode**: ${schedType}`,
    `**Channel**: ${entry.channel}`,
    `**Exec**: ${entry.exec ?? 'prompt'}`,
    `**active**: ${entry.enabled !== false ? 'Yes' : 'No'}`,
  ]
  if (entry.script) detailLines.push(`**Script**: ${entry.script}`)

  return {
    embeds: [{
      title: `\uD83D\uDCC4 ${name}`,
      description: detailLines.join('\n'),
      color: 0x5865F2,
    }],
  }
}

function scheduleAdd(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('schedule.missing_name', ctx.lang) }

  const time = parsed.params.time
  const channel = parsed.params.channel ?? 'general'
  if (!time) return { text: t('schedule.missing_fields', ctx.lang) }

  const mode = parsed.params.mode ?? 'interactive'
  const days = (parsed.params.period ?? parsed.params.days ?? 'daily') as 'daily' | 'weekday'
  const prompt = parsed.params.prompt

  const config = loadConfig()
  const targetKey = mode === 'non-interactive' ? 'nonInteractive' : 'interactive'

  // Reject duplicate names across both schedule groups.
  const existsI = (config.interactive ?? []).find(s => s.name === name)
  const existsN = (config.nonInteractive ?? []).find(s => s.name === name)
  if (existsI || existsN) {
    return { text: t('schedule.exists', ctx.lang, { name }) }
  }

  if (!config[targetKey]) (config as any)[targetKey] = []
  const arr = (config as any)[targetKey] as TimedSchedule[]
  arr.push({ name, time, channel, days, enabled: true })
  savePluginConfig(config)

  // Write the prompt file when prompt content is provided.
  if (prompt) {
    const promptsDir = config.promptsDir ?? join(DATA_DIR, 'prompts')
    mkdirSync(promptsDir, { recursive: true })
    const promptPath = join(promptsDir, `${name}.md`)
    writeFileSync(promptPath, prompt + '\n', 'utf8')
  }

  refreshRuntime(ctx)
  return { text: t('schedule.added', ctx.lang, { name, mode, time }) }
}

function scheduleEdit(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('schedule.missing_name', ctx.lang) }

  const config = loadConfig()

  // Find the schedule in either array.
  let entry: TimedSchedule | undefined
  for (const key of ['interactive', 'nonInteractive'] as const) {
    const list = config[key]
    if (!list) continue
    const found = list.find(s => s.name === name)
    if (found) { entry = found; break }
  }

  if (!entry) return { text: t('schedule.not_found', ctx.lang, { name }) }

  // Apply the provided parameter overrides.
  if (parsed.params.time) entry.time = parsed.params.time
  if (parsed.params.channel) entry.channel = parsed.params.channel
  if (parsed.params.period || parsed.params.days) entry.days = (parsed.params.period ?? parsed.params.days) as 'daily' | 'weekday'
  if (parsed.params.enabled !== undefined) entry.enabled = parsed.params.enabled !== 'false'
  if (parsed.params.exec) entry.exec = parsed.params.exec as 'prompt' | 'script' | 'script+prompt'
  if (parsed.params.script) entry.script = parsed.params.script

  // Update the prompt file when new prompt content is provided.
  if (parsed.params.prompt) {
    const promptsDir = config.promptsDir ?? join(DATA_DIR, 'prompts')
    mkdirSync(promptsDir, { recursive: true })
    const promptPath = join(promptsDir, `${name}.md`)
    writeFileSync(promptPath, parsed.params.prompt + '\n', 'utf8')
  }

  savePluginConfig(config)
  refreshRuntime(ctx)
  return { text: t('schedule.edited', ctx.lang, { name }) }
}

function scheduleRemove(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('schedule.missing_name', ctx.lang) }

  const config = loadConfig()
  let found = false

  for (const key of ['interactive', 'nonInteractive'] as const) {
    const list = config[key]
    if (!list) continue
    const idx = list.findIndex(s => s.name === name)
    if (idx >= 0) {
      list.splice(idx, 1)
      found = true
      break
    }
  }

  if (!found) return { text: t('schedule.not_found', ctx.lang, { name }) }

  savePluginConfig(config)
  refreshRuntime(ctx)
  return { text: t('schedule.removed', ctx.lang, { name }) }
}

async function scheduleTest(parsed: ParsedCommand, ctx: CommandContext): Promise<CommandResult> {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('schedule.missing_name', ctx.lang) }

  const result = await ctx.scheduler.triggerManual(name)
  return { text: `${t('schedule.triggered', ctx.lang, { name })}\n${result}` }
}

// ── /profile handler ─────────────────────────────────────────────────

export function handleProfileCommand(
  parsed: ParsedCommand,
  ctx: CommandContext,
): CommandResult {
  const action = parsed.args[0] ?? (Object.keys(parsed.params).length > 0 ? 'set' : 'status')

  switch (action) {
    case 'status': {
      const profile = loadProfileConfig()
      const entries = Object.entries(profile).filter(([_, v]) => v !== undefined)
      if (entries.length === 0) {
        return { text: t('profile.empty', ctx.lang) }
      }

      const profileFields = entries.map(([k, v]) => ({
        name: k, value: String(v), inline: false,
      }))

      return {
        embeds: [{
          title: '\uD504\uB85C\uD544',
          color: 0x57F287,
          fields: profileFields,
        }],
      }
    }
    case 'set':
    default: {
      const profile = loadProfileConfig()

      // Merge new parameter values into the existing profile.
      for (const [key, val] of Object.entries(parsed.params)) {
        ;(profile as Record<string, string>)[key.toLowerCase()] = val
      }

      saveProfileConfig(profile)

      const lines = Object.entries(profile)
        .filter(([_, v]) => v !== undefined)
        .map(([k, v]) => `- **${k}**: ${v}`)
      return { text: t('profile.updated', ctx.lang) + '\n' + lines.join('\n') }
    }
  }
}

// ── Router ───────────────────────────────────────────────────────────

/**
 * Check if a message is a custom command and handle it.
 * Returns a CommandResult if handled, null if not a command.
 */
export async function routeCustomCommand(
  text: string,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  const parsed = parseCommand(text)
  if (!parsed) return null

  return dispatchParsedCommand(parsed, ctx)
}

async function dispatchParsedCommand(
  parsed: ParsedCommand,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  switch (parsed.cmd) {
    case 'bot':
      return handleBotCommand(parsed, ctx)
    case 'profile':
      return handleProfileCommand(parsed, ctx)
    default:
      return null
  }
}

export function runProfileCommand(
  args: string[],
  params: Record<string, string>,
  ctx: CommandContext,
): CommandResult {
  return handleProfileCommand(makeParsedCommand('profile', args, params), ctx)
}

export async function runBotCommand(
  args: string[],
  params: Record<string, string>,
  ctx: CommandContext,
): Promise<CommandResult> {
  return handleBotCommand(makeParsedCommand('bot', args, params), ctx)
}
