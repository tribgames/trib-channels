/**
 * Functional command parser and handlers for /bot(...) and /profile(...).
 *
 * Syntax: /cmd(arg1, arg2, key="value", key2="value2")
 * - Positional args fill sub, action, name in order
 * - key=value pairs go into params
 * - Quoted strings preserve spaces
 */

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DATA_DIR, loadBotConfig, saveBotConfig, loadProfileConfig, saveProfileConfig } from './config.js'
import type { PluginConfig, TimedSchedule } from '../backends/types.js'
import type { Scheduler } from './scheduler.js'

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

function loadPluginConfig(): PluginConfig {
  const configPath = join(DATA_DIR, 'config.json')
  return JSON.parse(readFileSync(configPath, 'utf8'))
}

function savePluginConfig(config: PluginConfig): void {
  const configPath = join(DATA_DIR, 'config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
}

// ── i18n ─────────────────────────────────────────────────────────────

const msg: Record<string, Record<'ko' | 'en', string>> = {
  'schedule.empty': {
    ko: '등록된 스케줄이 없습니다.',
    en: 'No schedules configured.',
  },
  'schedule.added': {
    ko: '스케줄 "{name}" 추가 완료 ({mode}, {time})',
    en: 'Schedule "{name}" added ({mode}, {time})',
  },
  'schedule.exists': {
    ko: '스케줄 "{name}"이(가) 이미 존재합니다.',
    en: 'Schedule "{name}" already exists.',
  },
  'schedule.not_found': {
    ko: '스케줄 "{name}"을(를) 찾을 수 없습니다.',
    en: 'Schedule "{name}" not found.',
  },
  'schedule.removed': {
    ko: '스케줄 "{name}" 삭제 완료.',
    en: 'Schedule "{name}" removed.',
  },
  'schedule.edited': {
    ko: '스케줄 "{name}" 수정 완료.',
    en: 'Schedule "{name}" updated.',
  },
  'schedule.triggered': {
    ko: '스케줄 "{name}" 수동 실행 중...',
    en: 'Triggering schedule "{name}"...',
  },
  'schedule.missing_name': {
    ko: '스케줄 이름이 필요합니다.',
    en: 'Schedule name is required.',
  },
  'schedule.missing_fields': {
    ko: 'time, channel 필드가 필요합니다.',
    en: 'time and channel fields are required.',
  },
  'profile.empty': {
    ko: '프로필이 설정되지 않았습니다.',
    en: 'No profile configured.',
  },
  'profile.updated': {
    ko: '프로필 업데이트 완료.',
    en: 'Profile updated.',
  },
  'unknown_action': {
    ko: '알 수 없는 명령: {action}',
    en: 'Unknown action: {action}',
  },
  'unknown_sub': {
    ko: '알 수 없는 서브커맨드: {sub}',
    en: 'Unknown subcommand: {sub}',
  },
  'autotalk.status': {
    ko: '자율대화 상태',
    en: 'Autotalk Status',
  },
  'autotalk.freq_updated': {
    ko: '자율대화 빈도가 {freq}(으)로 변경되었습니다.',
    en: 'Autotalk frequency updated to {freq}.',
  },
  'autotalk.enabled': {
    ko: '자율대화가 활성화되었습니다.',
    en: 'Autotalk enabled.',
  },
  'autotalk.disabled': {
    ko: '자율대화가 비활성화되었습니다.',
    en: 'Autotalk disabled.',
  },
  'quiet.status': {
    ko: '방해금지 설정',
    en: 'Quiet Settings',
  },
  'quiet.updated': {
    ko: '방해금지 설정이 업데이트되었습니다.',
    en: 'Quiet settings updated.',
  },
  'activity.empty': {
    ko: '등록된 활동 채널이 없습니다.',
    en: 'No activity channels configured.',
  },
  'activity.added': {
    ko: '채널 "{name}" 추가 완료.',
    en: 'Channel "{name}" added.',
  },
  'activity.exists': {
    ko: '채널 "{name}"이(가) 이미 존재합니다.',
    en: 'Channel "{name}" already exists.',
  },
  'activity.not_found': {
    ko: '채널 "{name}"을(를) 찾을 수 없습니다.',
    en: 'Channel "{name}" not found.',
  },
  'activity.removed': {
    ko: '채널 "{name}" 삭제 완료.',
    en: 'Channel "{name}" removed.',
  },
  'activity.missing_name': {
    ko: '채널 이름이 필요합니다.',
    en: 'Channel name is required.',
  },
  'activity.missing_id': {
    ko: '채널 ID가 필요합니다.',
    en: 'Channel ID is required.',
  },
}

function t(key: string, lang: 'ko' | 'en', vars?: Record<string, string>): string {
  let text = msg[key]?.[lang] ?? msg[key]?.['en'] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(`{${k}}`, v)
    }
  }
  return text
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
    case 'status':
      return handleBotStatus(ctx)
    default:
      return { text: t('unknown_sub', ctx.lang, { sub }) }
  }
}

// ── /bot(status) ─────────────────────────────────────────────────────

function handleBotStatus(_ctx: CommandContext): CommandResult {
  const config = loadPluginConfig()
  const bot = loadBotConfig()
  const ni = config.nonInteractive ?? []
  const i = config.interactive ?? []
  const p = config.proactive

  const fields: Array<{ name: string; value: string; inline: boolean }> = []
  fields.push({ name: 'Backend', value: config.backend, inline: false })
  fields.push({ name: 'Schedules', value: `${ni.length} non-interactive\n${i.length} interactive`, inline: false })
  if (p) {
    fields.push({ name: 'Proactive', value: `freq=${p.frequency}, ${p.items.length} topic(s)`, inline: false })
  }
  if (config.voice?.enabled) {
    fields.push({ name: 'Voice', value: `lang=${config.voice.language ?? 'auto'}`, inline: false })
  }
  const main = config.channelsConfig?.main
  if (main) {
    const chCount = Object.keys(config.channelsConfig?.channels ?? {}).length
    fields.push({ name: 'Channels', value: `main="${main}", ${chCount} total`, inline: false })
  }
  // bot.json fields
  if (bot.quiet) {
    const qParts: string[] = []
    if (bot.quiet.schedule) qParts.push(`schedule: ${bot.quiet.schedule}`)
    if (bot.quiet.autotalk) qParts.push(`autotalk: ${bot.quiet.autotalk}`)
    if (bot.quiet.holidays) qParts.push(`holidays: ${bot.quiet.holidays}`)
    if (qParts.length > 0) {
      fields.push({ name: 'Quiet', value: qParts.join('\n'), inline: false })
    }
  }
  if (bot.autotalk) {
    fields.push({ name: 'Autotalk', value: `freq=${bot.autotalk.freq ?? '-'}, enabled=${bot.autotalk.enabled ?? false}`, inline: false })
  }

  return {
    embeds: [{
      title: '\u{1F916} Bot \uC124\uC815',
      description: '\uD0ED\uC744 \uC120\uD0DD\uD558\uC138\uC694',
      color: 0x5865F2,
      fields,
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 1, label: '\uC2A4\uCF00\uC904', custom_id: 'bot_schedule' },
        { type: 2, style: 1, label: '\uC790\uC728\uB300\uD654', custom_id: 'bot_autotalk' },
        { type: 2, style: 1, label: '\uBC29\uD574\uAE08\uC9C0', custom_id: 'bot_quiet' },
        { type: 2, style: 1, label: '\uD65C\uB3D9\uCC44\uB110', custom_id: 'bot_activity' },
        { type: 2, style: 1, label: '\uD504\uB85C\uD544', custom_id: 'bot_profile' },
      ],
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
  const config = loadPluginConfig()
  const channels = config.channelsConfig?.channels ?? {}
  const main = config.channelsConfig?.main ?? ''
  const entries = Object.entries(channels)

  const components: Record<string, unknown>[] = [{
    type: 1,
    components: [
      { type: 2, style: 1, label: '\uCD94\uAC00', custom_id: 'activity_add' },
    ],
  }]

  if (entries.length === 0) {
    return {
      embeds: [{
        title: '\u{1F4E1} \uD65C\uB3D9 \uCC44\uB110',
        description: t('activity.empty', ctx.lang),
        color: 0x5865F2,
      }],
      components,
    }
  }

  const fields = entries.map(([name, entry]) => ({
    name: name === main ? `${name} \u2B50` : name,
    value: `ID: \`${entry.id}\`\nMode: ${entry.mode}`,
    inline: false,
  }))

  // Remove buttons (max 5 per row)
  const removeButtons = entries.map(([name]) => ({
    type: 2, style: 4, label: `${name}`, custom_id: `activity_remove:${name}`,
  }))
  for (let i = 0; i < removeButtons.length; i += 5) {
    components.push({ type: 1, components: removeButtons.slice(i, i + 5) })
  }

  return {
    embeds: [{ title: '\u{1F4E1} \uD65C\uB3D9 \uCC44\uB110', color: 0x5865F2, fields }],
    components,
  }
}

function activityAdd(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('activity.missing_name', ctx.lang) }

  const id = parsed.params.id
  if (!id) return { text: t('activity.missing_id', ctx.lang) }

  const mode = (parsed.params.mode ?? 'interactive') as 'interactive' | 'monitor'

  const config = loadPluginConfig()
  if (!config.channelsConfig) {
    config.channelsConfig = { main: name, channels: {} }
  }

  if (config.channelsConfig.channels[name]) {
    return { text: t('activity.exists', ctx.lang, { name }) }
  }

  config.channelsConfig.channels[name] = { id, mode }
  savePluginConfig(config)

  return { text: t('activity.added', ctx.lang, { name }) }
}

function activityRemove(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('activity.missing_name', ctx.lang) }

  const config = loadPluginConfig()
  if (!config.channelsConfig?.channels[name]) {
    return { text: t('activity.not_found', ctx.lang, { name }) }
  }

  delete config.channelsConfig.channels[name]
  savePluginConfig(config)

  return { text: t('activity.removed', ctx.lang, { name }) }
}

// ── /bot(profile) ───────────────────────────────────────────────────

function handleBotProfile(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  // /bot(profile, set, name="...", ...) — param-based update
  if ((parsed.args[1] === 'set' || Object.keys(parsed.params).length > 0) && parsed.args[0] === 'profile') {
    return handleProfileCommand(
      { cmd: 'profile', args: ['set'], params: parsed.params },
      ctx,
    )
  }

  // Default: show profile + edit button
  const profile = loadProfileConfig()
  const entries = Object.entries(profile).filter(([_, v]) => v !== undefined)

  const components: Record<string, unknown>[] = [{
    type: 1,
    components: [
      { type: 2, style: 1, label: '\uD3B8\uC9D1', custom_id: 'profile_edit' },
    ],
  }]

  if (entries.length === 0) {
    return {
      embeds: [{
        title: '\u{1F464} \uD504\uB85C\uD544',
        description: t('profile.empty', ctx.lang),
        color: 0x57F287,
      }],
      components,
    }
  }

  const fields = entries.map(([k, v]) => ({
    name: k, value: String(v), inline: false,
  }))

  return {
    embeds: [{ title: '\u{1F464} \uD504\uB85C\uD544', color: 0x57F287, fields }],
    components,
  }
}

// ── /bot(autotalk, ...) ──────────────────────────────────────────────

function handleAutotalk(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const action = parsed.args[1] ?? 'status'
  const bot = loadBotConfig()

  // /bot(autotalk, freq=N) — freq passed as param
  if (parsed.params.freq) {
    const freq = Math.max(1, Math.min(5, parseInt(parsed.params.freq, 10) || 3))
    if (!bot.autotalk) bot.autotalk = {}
    bot.autotalk.freq = freq
    saveBotConfig(bot)
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
          title: `\u{1F4AC} ${t('autotalk.status', ctx.lang)}`,
          description: `**\uBE48\uB3C4**: ${freq}\n**\uC0C1\uD0DC**: ${statusEmoji} ${enabled ? 'ON' : 'OFF'}`,
          color: 0x5865F2,
        }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 1, label: '\uBE48\uB3C4 \uBCC0\uACBD', custom_id: 'autotalk_freq' },
            enabled
              ? { type: 2, style: 4, label: 'OFF', custom_id: 'autotalk_off' }
              : { type: 2, style: 3, label: 'ON', custom_id: 'autotalk_on' },
          ],
        }],
      }
    }
    case 'on': {
      if (!bot.autotalk) bot.autotalk = {}
      bot.autotalk.enabled = true
      saveBotConfig(bot)
      return { text: t('autotalk.enabled', ctx.lang) }
    }
    case 'off': {
      if (!bot.autotalk) bot.autotalk = {}
      bot.autotalk.enabled = false
      saveBotConfig(bot)
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
          title: `\u{1F515} ${t('quiet.status', ctx.lang)}`,
          description: lines.join('\n'),
          color: 0x5865F2,
        }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 1, label: '\uC124\uC815 \uBCC0\uACBD', custom_id: 'quiet_set' },
          ],
        }],
      }
    }
    case 'schedule': {
      if (!value) return { text: t('unknown_action', ctx.lang, { action: 'schedule (value required)' }) }
      if (!bot.quiet) bot.quiet = {}
      bot.quiet.schedule = value
      saveBotConfig(bot)
      return { text: t('quiet.updated', ctx.lang) }
    }
    case 'autotalk': {
      if (!value) return { text: t('unknown_action', ctx.lang, { action: 'autotalk (value required)' }) }
      if (!bot.quiet) bot.quiet = {}
      bot.quiet.autotalk = value
      saveBotConfig(bot)
      return { text: t('quiet.updated', ctx.lang) }
    }
    case 'holidays': {
      if (!value) return { text: t('unknown_action', ctx.lang, { action: 'holidays (value required)' }) }
      if (!bot.quiet) bot.quiet = {}
      bot.quiet.holidays = value
      saveBotConfig(bot)
      return { text: t('quiet.updated', ctx.lang) }
    }
    case 'timezone': {
      if (!value) return { text: t('unknown_action', ctx.lang, { action: 'timezone (value required)' }) }
      if (!bot.quiet) bot.quiet = {}
      bot.quiet.timezone = value
      saveBotConfig(bot)
      return { text: t('quiet.updated', ctx.lang) }
    }
    default:
      return { text: t('unknown_action', ctx.lang, { action }) }
  }
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
  const config = loadPluginConfig()
  const all: Array<TimedSchedule & { type: string }> = [
    ...(config.nonInteractive ?? []).map(s => ({ ...s, type: 'non-interactive' })),
    ...(config.interactive ?? []).map(s => ({ ...s, type: 'interactive' })),
  ]

  if (all.length === 0) {
    return { text: t('schedule.empty', ctx.lang) }
  }

  const fields = all.map(s => {
    const status = s.enabled === false ? ' [OFF]' : ''
    const days = s.days ?? 'daily'
    const exec = s.exec ?? 'prompt'
    return { name: s.name, value: `${s.time} ${days} [${exec}]${status}`, inline: false }
  })

  // proactive는 /claude bot autotalk에서 별도 관리 — 스케줄 목록에서 숨김

  // Build select menu options (max 25 per Discord limit)
  const options = all.slice(0, 25).map(s => ({
    label: s.name,
    value: s.name,
    description: `${s.time} (${s.type})`.substring(0, 100),
  }))

  const result: CommandResult = {
    embeds: [{
      title: '\u{1F4CB} \uC2A4\uCF00\uC904 \uBAA9\uB85D',
      color: 0x5865F2,
      fields,
    }],
  }

  if (options.length > 0) {
    result.components = [{
      type: 1,
      components: [{
        type: 3,
        custom_id: 'schedule_select',
        placeholder: '\uC2A4\uCF00\uC904 \uC120\uD0DD',
        options,
      }],
    }]
  }

  return result
}

function scheduleDetail(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('schedule.missing_name', ctx.lang) }

  const config = loadPluginConfig()
  let entry: TimedSchedule | undefined
  let schedType = ''

  for (const [key, label] of [['interactive', 'interactive'], ['nonInteractive', 'non-interactive']] as const) {
    const list = config[key]
    if (!list) continue
    const found = list.find(s => s.name === name)
    if (found) { entry = found; schedType = label; break }
  }

  if (!entry) return { text: t('schedule.not_found', ctx.lang, { name }) }

  const fields = [
    { name: 'Time', value: entry.time, inline: false },
    { name: 'Days', value: entry.days ?? 'daily', inline: false },
    { name: 'Type', value: schedType, inline: false },
    { name: 'Channel', value: entry.channel, inline: false },
    { name: 'Exec', value: entry.exec ?? 'prompt', inline: false },
    { name: 'Enabled', value: entry.enabled !== false ? 'Yes' : 'No', inline: false },
  ]
  if (entry.script) {
    fields.push({ name: 'Script', value: entry.script, inline: false })
  }
  if (entry.prompt) {
    fields.push({ name: 'Prompt', value: entry.prompt, inline: false })
  }

  return {
    embeds: [{
      title: `\u{1F4C4} ${name}`,
      color: 0x5865F2,
      fields,
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 1, label: '\uD3B8\uC9D1', custom_id: `sched_edit:${name}` },
        { type: 2, style: 4, label: '\uC81C\uAC70', custom_id: `sched_remove:${name}` },
        { type: 2, style: 2, label: '\uD14C\uC2A4\uD2B8', custom_id: `sched_test:${name}` },
      ],
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

  const config = loadPluginConfig()
  const targetKey = mode === 'non-interactive' ? 'nonInteractive' : 'interactive'

  // Check duplicates in both arrays
  const existsI = (config.interactive ?? []).find(s => s.name === name)
  const existsN = (config.nonInteractive ?? []).find(s => s.name === name)
  if (existsI || existsN) {
    return { text: t('schedule.exists', ctx.lang, { name }) }
  }

  if (!config[targetKey]) (config as any)[targetKey] = []
  const arr = (config as any)[targetKey] as TimedSchedule[]
  arr.push({ name, time, channel, days, enabled: true })
  savePluginConfig(config)

  // Write prompt file if provided
  if (prompt) {
    const promptsDir = config.promptsDir ?? join(DATA_DIR, 'prompts')
    const promptPath = join(promptsDir, `${name}.md`)
    writeFileSync(promptPath, prompt + '\n', 'utf8')
  }

  ctx.scheduler.restart()
  return { text: t('schedule.added', ctx.lang, { name, mode, time }) }
}

function scheduleEdit(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('schedule.missing_name', ctx.lang) }

  const config = loadPluginConfig()

  // Find in either array
  let entry: TimedSchedule | undefined
  for (const key of ['interactive', 'nonInteractive'] as const) {
    const list = config[key]
    if (!list) continue
    const found = list.find(s => s.name === name)
    if (found) { entry = found; break }
  }

  if (!entry) return { text: t('schedule.not_found', ctx.lang, { name }) }

  // Apply param overrides
  if (parsed.params.time) entry.time = parsed.params.time
  if (parsed.params.channel) entry.channel = parsed.params.channel
  if (parsed.params.period || parsed.params.days) entry.days = (parsed.params.period ?? parsed.params.days) as 'daily' | 'weekday'
  if (parsed.params.enabled !== undefined) entry.enabled = parsed.params.enabled !== 'false'
  if (parsed.params.exec) entry.exec = parsed.params.exec as 'prompt' | 'script' | 'script+prompt'
  if (parsed.params.script) entry.script = parsed.params.script

  // Update prompt file if provided
  if (parsed.params.prompt) {
    const promptsDir = config.promptsDir ?? join(DATA_DIR, 'prompts')
    const promptPath = join(promptsDir, `${name}.md`)
    writeFileSync(promptPath, parsed.params.prompt + '\n', 'utf8')
  }

  savePluginConfig(config)
  ctx.scheduler.restart()
  return { text: t('schedule.edited', ctx.lang, { name }) }
}

function scheduleRemove(parsed: ParsedCommand, ctx: CommandContext): CommandResult {
  const name = parsed.args[2] ?? parsed.params.name
  if (!name) return { text: t('schedule.missing_name', ctx.lang) }

  const config = loadPluginConfig()
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
  ctx.scheduler.restart()
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
          title: '\u{1F464} \uD504\uB85C\uD544',
          color: 0x57F287,
          fields: profileFields,
        }],
      }
    }
    case 'set':
    default: {
      const profile = loadProfileConfig()

      // Merge new params
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

  switch (parsed.cmd) {
    case 'bot':
      return handleBotCommand(parsed, ctx)
    case 'profile':
      return handleProfileCommand(parsed, ctx)
    default:
      return null
  }
}
