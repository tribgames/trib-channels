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

  const lines: string[] = []
  lines.push(`**스케줄** ${ni.length + i.length}개 등록`)

  const autotalkStatus = bot.autotalk?.enabled ? `freq=${bot.autotalk.freq ?? 3}, 활성` : '비활성'
  lines.push(`**자율대화** ${autotalkStatus}`)

  const quietParts: string[] = []
  if (bot.quiet?.schedule) quietParts.push(bot.quiet.schedule)
  if (bot.quiet?.autotalk) quietParts.push(`자율대화 ${bot.quiet.autotalk}`)
  lines.push(`**방해금지** ${quietParts.length > 0 ? quietParts.join(', ') : '없음'}`)

  const chCount = Object.keys(config.channelsConfig?.channels ?? {}).length
  lines.push(`**활동채널** ${chCount}개`)

  const profile = loadProfileConfig()
  lines.push(`**프로필** ${profile.name || '-'}`)

  return {
    embeds: [{
      title: '\u2699\uFE0F Bot 대시보드',
      description: lines.join('\n'),
      color: 0x5865F2,
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 1, label: '스케줄', custom_id: 'bot_schedule' },
        { type: 2, style: 1, label: '자율대화', custom_id: 'bot_autotalk' },
        { type: 2, style: 1, label: '방해금지', custom_id: 'bot_quiet' },
        { type: 2, style: 1, label: '활동채널', custom_id: 'bot_activity' },
        { type: 2, style: 2, label: '프로필', custom_id: 'bot_profile' },
      ],
    }, {
      type: 1,
      components: [
        { type: 2, style: 4, label: '\u2715', custom_id: 'gui_close' },
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

  if (entries.length === 0) {
    return {
      embeds: [{
        title: '\uD83D\uDCE1 활동 채널',
        description: t('activity.empty', ctx.lang),
        color: 0x5865F2,
      }],
      components: [{
        type: 1,
        components: [
          { type: 2, style: 1, label: '추가', custom_id: 'activity_add' },
          { type: 2, style: 2, label: '\u2190 메인', custom_id: 'gui_back' },
          { type: 2, style: 4, label: '\u2715', custom_id: 'gui_close' },
        ],
      }],
    }
  }

  // description 형태로 목록 표시
  const chLines = entries.map(([name, entry]) => {
    const star = name === main ? ' \u2B50' : ''
    return `**${name}${star}** — ${entry.mode} (\`${entry.id}\`)`
  })

  const components: Record<string, unknown>[] = []

  // Remove buttons (max 5 per row)
  const removeButtons = entries.map(([name]) => ({
    type: 2, style: 4, label: `${name}`, custom_id: `activity_remove:${name}`,
  }))
  for (let i = 0; i < removeButtons.length; i += 5) {
    components.push({ type: 1, components: removeButtons.slice(i, i + 5) })
  }

  components.push({
    type: 1,
    components: [
      { type: 2, style: 1, label: '추가', custom_id: 'activity_add' },
      { type: 2, style: 2, label: '\u2190 메인', custom_id: 'gui_back' },
      { type: 2, style: 4, label: '\u2715', custom_id: 'gui_close' },
    ],
  })

  return {
    embeds: [{ title: '\uD83D\uDCE1 활동 채널', description: chLines.join('\n'), color: 0x5865F2 }],
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

  // Default: show profile + edit/nav buttons
  const profile = loadProfileConfig()
  const entries = Object.entries(profile).filter(([_, v]) => v !== undefined)

  const navComponents: Record<string, unknown>[] = [{
    type: 1,
    components: [
      { type: 2, style: 1, label: '편집', custom_id: 'profile_edit' },
      { type: 2, style: 2, label: '\u2190 메인', custom_id: 'gui_back' },
      { type: 2, style: 4, label: '\u2715', custom_id: 'gui_close' },
    ],
  }]

  if (entries.length === 0) {
    return {
      embeds: [{
        title: '\uD83D\uDC64 프로필',
        description: t('profile.empty', ctx.lang),
        color: 0x57F287,
      }],
      components: navComponents,
    }
  }

  const profileLines = entries.map(([k, v]) => `**${k}**: ${v}`)

  return {
    embeds: [{ title: '\uD83D\uDC64 프로필', description: profileLines.join('\n'), color: 0x57F287 }],
    components: navComponents,
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
          title: `\uD83D\uDCAC ${t('autotalk.status', ctx.lang)}`,
          description: `**빈도**: ${freq}\n**상태**: ${statusEmoji} ${enabled ? 'ON' : 'OFF'}`,
          color: 0x5865F2,
        }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 1, label: '빈도 변경', custom_id: 'autotalk_freq' },
            enabled
              ? { type: 2, style: 4, label: 'OFF', custom_id: 'autotalk_off' }
              : { type: 2, style: 3, label: 'ON', custom_id: 'autotalk_on' },
            { type: 2, style: 2, label: '\u2190 메인', custom_id: 'gui_back' },
            { type: 2, style: 4, label: '\u2715', custom_id: 'gui_close' },
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
          title: `\uD83D\uDD15 ${t('quiet.status', ctx.lang)}`,
          description: lines.join('\n'),
          color: 0x5865F2,
        }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 1, label: '설정 변경', custom_id: 'quiet_set' },
            { type: 2, style: 2, label: '\u2190 메인', custom_id: 'gui_back' },
            { type: 2, style: 4, label: '\u2715', custom_id: 'gui_close' },
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

  // description 형태로 목록 표시
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

  const components: Record<string, unknown>[] = []

  if (options.length > 0) {
    components.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: 'schedule_select',
        placeholder: '스케줄 선택',
        options,
      }],
    })
  }

  components.push({
    type: 1,
    components: [
      { type: 2, style: 1, label: '추가', custom_id: 'sched_add' },
      { type: 2, style: 2, label: '\u2190 메인', custom_id: 'gui_back' },
      { type: 2, style: 4, label: '\u2715', custom_id: 'gui_close' },
    ],
  })

  return {
    embeds: [{
      title: '\uD83D\uDCC5 스케줄',
      description: lines.join('\n'),
      color: 0x5865F2,
    }],
    components,
  }
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

  // description 형태로 상세 표시
  const detailLines = [
    `**시간**: ${entry.time}`,
    `**주기**: ${entry.days ?? 'daily'}`,
    `**모드**: ${schedType}`,
    `**채널**: ${entry.channel}`,
    `**실행**: ${entry.exec ?? 'prompt'}`,
    `**활성**: ${entry.enabled !== false ? 'Yes' : 'No'}`,
  ]
  if (entry.script) detailLines.push(`**스크립트**: ${entry.script}`)

  return {
    embeds: [{
      title: `\uD83D\uDCC4 ${name}`,
      description: detailLines.join('\n'),
      color: 0x5865F2,
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 1, label: '편집', custom_id: `sched_edit:${name}` },
        { type: 2, style: 4, label: '삭제', custom_id: `sched_remove:${name}` },
        { type: 2, style: 2, label: '테스트', custom_id: `sched_test:${name}` },
        { type: 2, style: 2, label: '\u2190 목록', custom_id: 'bot_schedule' },
        { type: 2, style: 4, label: '\u2715', custom_id: 'gui_close' },
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
          title: '\uD504\uB85C\uD544',
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
