/**
 * Discord slash command definitions, registration, and handler logic.
 *
 * Commands are registered as guild commands (instant propagation).
 * All responses are ephemeral (visible only to the invoking user).
 */

import { REST, Routes, SlashCommandBuilder } from 'discord.js'
import type { ChatInputCommandInteraction, Client } from 'discord.js'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { PluginConfig } from '../backends/types.js'
import type { Scheduler } from './scheduler.js'
import { DATA_DIR } from './config.js'
import { handleBotCommand } from './custom-commands.js'
import type { CommandContext } from './custom-commands.js'
import { controlClaudeSession } from './session-control.js'

// ── Constants ────────────────────────────────────────────────────────

const EMBED_COLOR = 0x5865F2 // Discord blurple

// ── i18n ─────────────────────────────────────────────────────────────

type Lang = 'en' | 'ko' | 'ja' | 'zh'

/** Cached config language override (read from config.json on first call) */
let configLangCache: Lang | null | undefined = undefined

function getConfigLang(): Lang | null {
  if (configLangCache !== undefined) return configLangCache
  try {
    const configPath = join(DATA_DIR, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const lang = config.language as string | undefined
    if (lang === 'en' || lang === 'ko' || lang === 'ja' || lang === 'zh') {
      configLangCache = lang
      return lang
    }
  } catch { /* ignore */ }
  configLangCache = null
  return null
}

function getLang(locale: string): Lang {
  const override = getConfigLang()
  if (override) return override
  if (locale === 'ko') return 'ko'
  if (locale === 'ja') return 'ja'
  if (locale.startsWith('zh')) return 'zh'
  return 'en'
}

const i18n: Record<string, Record<Lang, string>> = {
  'session.command_forwarded': {
    en: 'Forwarded `{command}` to the Claude session. The result will appear in the channel.',
    ko: 'Claude 세션에 `{command}` 요청을 전달했습니다. 결과는 채널에 표시됩니다.',
    ja: 'Claude セッションに`{command}`を転送しました。結果はチャンネルに表示されます。',
    zh: '已将`{command}`转发到 Claude 会话。结果会显示在频道中。',
  },
  'model.switched': {
    en: 'Model switch request: **{model}** (forwarded to session)',
    ko: 'Model switch requested: **{model}** (forwarded to session)',
    ja: 'モデル切替リクエスト: **{model}** (セッションに転送済み)',
    zh: '模型切换请求: **{model}** (已转发到会话)',
  },
  'compact.forwarded': {
    en: 'Compact request forwarded to session.',
    ko: 'Context compact request forwarded to session.',
    ja: '圧縮リクエストをセッションに転送しました。',
    zh: '压缩请求已转发到会话。',
  },
  'clear.forwarded': {
    en: 'Clear request forwarded to session.',
    ko: 'Clear request forwarded to session.',
    ja: 'クリアリクエストをセッションに転送しました。',
    zh: '清除请求已转发到会话。',
  },
  'new.forwarded': {
    en: 'New session request forwarded to session.',
    ko: 'New session request forwarded to session.',
    ja: '新しいセッションリクエストをセッションに転送しました。',
    zh: '新建会话请求已转发到会话。',
  },
  'unknown_command': {
    en: 'Unknown command: {cmd}',
    ko: 'Unknown command: {cmd}',
    ja: '不明なコマンド: {cmd}',
    zh: '未知命令: {cmd}',
  },
}

function t(key: string, locale: string, vars?: Record<string, string | number>): string {
  const lang = getLang(locale)
  let text = i18n[key]?.[lang] ?? i18n[key]?.en ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}

// ── Types ────────────────────────────────────────────────────────────

export type NotifyFn = (channelId: string, user: string, text: string) => void

export interface SlashCommandContext {
  config: PluginConfig
  scheduler: Scheduler
  instanceId: string
  turnEndFile: string
  reloadRuntimeConfig: () => void
  /** Re-discover and rebind the current transcript/session context for a channel */
  refreshSessionContext: (channelId: string, mode?: 'same' | 'new') => Promise<void>
  /** Inject a command into the MCP session as a notification */
  notify: NotifyFn
  /** The MCP server's process (for stop command) */
  serverProcess: NodeJS.Process
}

// ── Command definitions ──────────────────────────────────────────────

function buildClaudeCommand(): SlashCommandBuilder {
  const claude = new SlashCommandBuilder()
    .setName('claude')
    .setDescription('Claude Code session control')
    .setDescriptionLocalizations({
      ko: 'Claude Code session control',
      ja: 'Claude Code セッション制御',
      'zh-CN': 'Claude Code 会话控制',
      'zh-TW': 'Claude Code 工作階段控制',
      'pt-BR': 'Controle de sessao Claude Code',
      'es-ES': 'Control de sesion Claude Code',
    })

  // /claude stop
  claude.addSubcommand(sub =>
    sub.setName('stop').setDescription('Stop current task')
      .setDescriptionLocalizations({
        ko: 'Stop current task',
        ja: '現在のタスクを停止',
        'zh-CN': '停止当前任务',
        'zh-TW': '停止目前任務',
        'pt-BR': 'Parar tarefa atual',
        'es-ES': 'Detener tarea actual',
      }),
  )

  // /claude status
  claude.addSubcommand(sub =>
    sub.setName('status').setDescription('Show session status')
      .setDescriptionLocalizations({
        ko: 'Check session status',
        ja: 'セッション状態確認',
        'zh-CN': '查看会话状态',
        'zh-TW': '查看工作階段狀態',
        'pt-BR': 'Ver status da sessao',
        'es-ES': 'Ver estado de la sesion',
      }),
  )

  // /claude usage
  claude.addSubcommand(sub =>
    sub.setName('usage').setDescription('Show session usage')
      .setDescriptionLocalizations({
        ko: '세션 사용량 보기',
        ja: 'セッション使用量を表示',
        'zh-CN': '查看会话使用量',
        'zh-TW': '查看工作階段使用量',
        'pt-BR': 'Ver uso da sessao',
        'es-ES': 'Ver uso de la sesion',
      }),
  )

  // /claude config
  claude.addSubcommand(sub =>
    sub.setName('config').setDescription('Show configuration')
      .setDescriptionLocalizations({
        ko: 'Check config',
        ja: '設定確認',
        'zh-CN': '查看配置',
        'zh-TW': '查看設定',
        'pt-BR': 'Ver configuracao',
        'es-ES': 'Ver configuracion',
      }),
  )

  // /claude compact
  claude.addSubcommand(sub =>
    sub.setName('compact').setDescription('Compact conversation')
      .setDescriptionLocalizations({
        ko: 'Compact conversation',
        ja: '会話を圧縮',
        'zh-CN': '压缩对话',
        'zh-TW': '壓縮對話',
        'pt-BR': 'Compactar conversa',
        'es-ES': 'Compactar conversacion',
      }),
  )

  // /claude clear
  claude.addSubcommand(sub =>
    sub.setName('clear').setDescription('Clear conversation')
      .setDescriptionLocalizations({
        ko: 'Clear conversation',
        ja: '会話をクリア',
        'zh-CN': '清除对话',
        'zh-TW': '清除對話',
        'pt-BR': 'Limpar conversa',
        'es-ES': 'Limpiar conversacion',
      }),
  )

  // /claude new
  claude.addSubcommand(sub =>
    sub.setName('new').setDescription('Start new session')
      .setDescriptionLocalizations({
        ko: '새 세션 시작',
        ja: '新しいセッションを開始',
        'zh-CN': '新建会话',
        'zh-TW': '新建工作階段',
        'pt-BR': 'Iniciar nova sessao',
        'es-ES': 'Iniciar nueva sesion',
      }),
  )

  // /claude model [name]
  claude.addSubcommand(sub =>
    sub
      .setName('model')
      .setDescription('Switch model')
      .setDescriptionLocalizations({
        ko: '모델 전환',
        ja: 'モデル切替',
        'zh-CN': '切换模型',
        'zh-TW': '切換模型',
        'pt-BR': 'Trocar modelo',
        'es-ES': 'Cambiar modelo',
      })
      .addStringOption(opt =>
        opt
          .setName('name')
          .setDescription('Model to switch to')
          .setDescriptionLocalizations({
            ko: '전환할 모델',
            ja: '切り替えるモデル',
            'zh-CN': '要切换的模型',
            'zh-TW': '要切換的模型',
            'pt-BR': 'Modelo para trocar',
            'es-ES': 'Modelo a cambiar',
          })
          .setRequired(true)
          .addChoices(
            { name: 'sonnet', value: 'sonnet' },
            { name: 'opus', value: 'opus' },
            { name: 'haiku', value: 'haiku' },
          ),
      )
      .addStringOption(opt =>
        opt
          .setName('effort')
          .setDescription('Reasoning effort level')
          .setDescriptionLocalizations({
            ko: '추론 노력 수준',
            ja: '推論レベル',
            'zh-CN': '推理级别',
            'zh-TW': '推理等級',
            'pt-BR': 'Nivel de esforco',
            'es-ES': 'Nivel de esfuerzo',
          })
          .setRequired(false)
          .addChoices(
            { name: 'low', value: 'low' },
            { name: 'medium', value: 'medium' },
            { name: 'high', value: 'high' },
            { name: 'max', value: 'max' },
          ),
      ),
  )

  return claude
}

function buildClaude2BotCommand(): SlashCommandBuilder {
  const claude2bot = new SlashCommandBuilder()
    .setName('claude2bot')
    .setDescription('claude2bot setup and operations')
    .setDescriptionLocalizations({
      ko: 'claude2bot 설정 및 운영',
      ja: 'claude2bot の設定と運用',
      'zh-CN': 'claude2bot 设置与运维',
      'zh-TW': 'claude2bot 設定與操作',
      'pt-BR': 'Configuracao e operacao do claude2bot',
      'es-ES': 'Configuracion y operacion de claude2bot',
    })

  claude2bot.addSubcommand(sub =>
    sub.setName('setup').setDescription('Open the claude2bot setup dashboard')
      .setDescriptionLocalizations({
        ko: 'claude2bot 설정 대시보드 열기',
        ja: 'claude2bot 設定ダッシュボードを開く',
        'zh-CN': '打开 claude2bot 设置面板',
        'zh-TW': '開啟 claude2bot 設定面板',
        'pt-BR': 'Abrir painel de configuracao do claude2bot',
        'es-ES': 'Abrir panel de configuracion de claude2bot',
      }),
  )

  claude2bot.addSubcommand(sub =>
    sub.setName('schedule').setDescription('Open claude2bot schedule management')
      .setDescriptionLocalizations({
        ko: 'claude2bot 스케줄 관리 열기',
        ja: 'claude2bot スケジュール管理を開く',
        'zh-CN': '打开 claude2bot 计划管理',
        'zh-TW': '開啟 claude2bot 排程管理',
        'pt-BR': 'Abrir gerenciamento de agendamentos do claude2bot',
        'es-ES': 'Abrir gestion de programaciones de claude2bot',
      }),
  )

  claude2bot.addSubcommand(sub =>
    sub.setName('doctor').setDescription('Run claude2bot diagnostics')
      .setDescriptionLocalizations({
        ko: 'claude2bot 진단 실행',
        ja: 'claude2bot 診断を実行',
        'zh-CN': '运行 claude2bot 诊断',
        'zh-TW': '執行 claude2bot 診斷',
        'pt-BR': 'Executar diagnostico do claude2bot',
        'es-ES': 'Ejecutar diagnostico de claude2bot',
      }),
  )

  return claude2bot
}

// ── Registration ─────────────────────────────────────────────────────

export async function registerSlashCommands(client: Client, token: string): Promise<void> {
  if (!client.user) return
  const rest = new REST({ version: '10' }).setToken(token)
  const commands = [buildClaudeCommand().toJSON(), buildClaude2BotCommand().toJSON()]

  // Fetch guilds if the local cache is empty.
  let guilds = client.guilds.cache
  if (guilds.size === 0) {
    process.stderr.write('claude2bot: guild cache empty, fetching...\n')
    try {
      const fetched = await client.guilds.fetch()
      guilds = fetched as any
    } catch (e) {
      process.stderr.write(`claude2bot: guild fetch failed: ${e}\n`)
    }
  }

  if (guilds.size === 0) {
    process.stderr.write('claude2bot: WARNING: no guilds found, slash commands not registered\n')
    return
  }

  // Register to all guilds the bot is in (guild commands propagate instantly)
  for (const guild of guilds.values()) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands },
      )
      process.stderr.write(`claude2bot: slash commands registered in guild ${(guild as any).name ?? guild.id}\n`)
    } catch (err) {
      process.stderr.write(`claude2bot: failed to register slash commands in ${(guild as any).name ?? guild.id}: ${err}\n`)
    }
  }
}

// ── Handler ──────────────────────────────────────────────────────────

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  if (interaction.commandName === 'claude2bot') {
    return handleClaude2BotCommand(interaction, ctx)
  }

  const sub = interaction.options.getSubcommand()

  switch (sub) {
    case 'stop':
      return handleStop(interaction, ctx)
    case 'status':
      return handleSessionPassthrough(interaction, ctx, '/status', 'Status')
    case 'usage':
      return handleSessionPassthrough(interaction, ctx, '/usage', 'Usage')
    case 'config':
      return handleSessionPassthrough(interaction, ctx, '/config', 'Config')
    case 'model':
      return handleModel(interaction, ctx)
    case 'compact':
      return handleCompact(interaction, ctx)
    case 'clear':
      return handleClear(interaction, ctx)
    case 'new':
      return handleNew(interaction, ctx)
    default:
      await interaction.reply({ content: t('unknown_command', interaction.locale, { cmd: sub }), flags: 64 })
  }
}

// ── Individual command handlers ──────────────────────────────────────

async function handleStop(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const { writeFileSync } = await import('fs')
  const result = await controlClaudeSession(ctx.instanceId, { type: 'interrupt' })

  // Escape-based interruption may not trigger Stop, so write turn-end directly.
  try {
    writeFileSync(ctx.turnEndFile, String(Date.now()))
  } catch {}

  await interaction.reply({
    embeds: [{ title: 'Stop', description: result.ok ? 'Stopped' : result.message, color: result.ok ? 0xED4245 : 0xFEE75C }],
    flags: 64,
  })
}

// ── session control helper ──────────────────────────────────────────
async function sendSessionCommand(ctx: SlashCommandContext, command: string) {
  return controlClaudeSession(ctx.instanceId, { type: 'send', text: command })
}

async function handleSessionPassthrough(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
  command: string,
  title: string,
): Promise<void> {
  const result = await sendSessionCommand(ctx, command)
  await interaction.reply({
    embeds: [{
      title,
      description: result.ok ? t('session.command_forwarded', interaction.locale, { command }) : result.message,
      color: result.ok ? EMBED_COLOR : 0xFEE75C,
    }],
    flags: 64,
  })
}

async function handleModel(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const model = interaction.options.getString('name', true)
  const effort = interaction.options.getString('effort')
  const modelResult = await sendSessionCommand(ctx, `/model ${model}`)
  const ok = modelResult.ok
  let effortOk = true
  if (effort && ok) {
    const effortResult = await sendSessionCommand(ctx, `/effort ${effort}`)
    effortOk = effortResult.ok
  }
  const desc = ok
    ? t('model.switched', interaction.locale, { model }) + (effort ? ` (effort: ${effort})` : '')
    : modelResult.message
  await interaction.reply({
    embeds: [{ title: 'Model', description: desc, color: ok && effortOk ? EMBED_COLOR : 0xFEE75C }],
    flags: 64,
  })
}

async function handleCompact(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const result = await sendSessionCommand(ctx, '/compact')
  await interaction.reply({ embeds: [{ title: 'Compact', description: result.ok ? t('compact.forwarded', interaction.locale) : result.message, color: result.ok ? EMBED_COLOR : 0xFEE75C }], flags: 64 })
}

async function handleClear(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const result = await sendSessionCommand(ctx, '/clear')
  if (result.ok) {
    await ctx.refreshSessionContext(interaction.channelId, 'same')
  }
  await interaction.reply({ embeds: [{ title: 'Clear', description: result.ok ? t('clear.forwarded', interaction.locale) : result.message, color: result.ok ? EMBED_COLOR : 0xFEE75C }], flags: 64 })
}

async function handleNew(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const result = await sendSessionCommand(ctx, '/new')
  if (result.ok) {
    await ctx.refreshSessionContext(interaction.channelId, 'new')
  }
  await interaction.reply({ embeds: [{ title: 'New Session', description: result.ok ? t('new.forwarded', interaction.locale) : result.message, color: result.ok ? EMBED_COLOR : 0xFEE75C }], flags: 64 })
}

async function handleDoctor(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  let allPass = true
  const lines: string[] = []

  const configPath = join(DATA_DIR, 'config.json')
  const configOk = existsSync(configPath)
  lines.push(`**Config** ${configOk ? '\u{2705}' : '\u{274c} Missing'}`)
  if (!configOk) allPass = false

  const hasToken = ctx.config.backend === 'discord' && ctx.config.discord?.token
  lines.push(`**Token** ${hasToken ? '\u{2705}' : '\u{274c} Missing'}`)
  if (!hasToken) allPass = false

  const stateDir = ctx.config.discord?.stateDir ?? join(DATA_DIR, 'discord')
  const accessPath = join(stateDir, 'access.json')
  if (existsSync(accessPath)) {
    try {
      const access = JSON.parse(readFileSync(accessPath, 'utf8'))
      lines.push(`**Access** \u{2705} ${(access.allowFrom ?? []).length} users, ${Object.keys(access.channels ?? {}).length} channels`)
    } catch { lines.push('**Access** \u{274c} Parse failed'); allPass = false }
  } else { lines.push('**Access** \u{26a0}\u{fe0f} Not configured') }

  const statuses = ctx.scheduler.getStatus()
  const promptsDir = ctx.config.promptsDir ?? join(DATA_DIR, 'prompts')
  const missingPrompts = statuses.filter(s => s.type !== 'proactive' && !existsSync(join(promptsDir, `${s.name}.md`)))
  let schedLine = `**Schedules** \u{2705} ${statuses.length} registered`
  if (missingPrompts.length > 0) schedLine += ` (\u{26a0}\u{fe0f} missing: ${missingPrompts.map(s => s.name).join(', ')})`
  lines.push(schedLine)

  if (ctx.config.channelsConfig) {
    lines.push(`**Channels** \u{2705} ${Object.keys(ctx.config.channelsConfig.channels).length} configured`)
  } else { lines.push('**Channels** \u{26a0}\u{fe0f} Not configured') }

  lines.push(`**Voice** ${ctx.config.voice?.enabled ? '\u{2705} Enabled' : 'Disabled'}`)
  lines.push(`**Process** PID ${process.pid}, uptime ${Math.floor(process.uptime() / 60)}m`)

  await interaction.reply({ embeds: [{ description: lines.join('\n'), color: allPass ? 0x57F287 : 0xFEE75C }], flags: 64 })
}

// ── /claude2bot handlers ─────────────────────────────────────────────

/** Convert Discord locale to CommandContext lang ('ko' | 'en') */
function getCmdLang(locale: string): 'ko' | 'en' {
  return getLang(locale) === 'ko' ? 'ko' : 'en'
}

/** Reply to interaction with CommandResult (text, embeds, components) */
async function replyWithResult(
  interaction: ChatInputCommandInteraction,
  result: { text?: string; embeds?: Record<string, unknown>[]; components?: Record<string, unknown>[] },
): Promise<void> {
  const payload: Record<string, unknown> = { flags: 64 }
  if (result.text) payload.content = result.text
  if (result.embeds?.length) payload.embeds = result.embeds
  if (result.components?.length) payload.components = result.components
  if (!result.text && !result.embeds?.length) payload.content = 'OK'
  await interaction.reply(payload as any)
}

async function handleBotCommandArgs(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
  args: string[],
): Promise<void> {
  const cmdCtx: CommandContext = {
    scheduler: ctx.scheduler,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    lang: getCmdLang(interaction.locale),
    reloadRuntimeConfig: ctx.reloadRuntimeConfig,
  }
  try {
    const result = await handleBotCommand(
      { cmd: 'bot', args, params: {} },
      cmdCtx,
    )
    await replyWithResult(interaction, result)
  } catch (err) {
    await interaction.reply({ content: `Error: ${err instanceof Error ? err.message : String(err)}`, flags: 64 })
  }
}

async function handleClaude2BotCommand(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const sub = interaction.options.getSubcommand(false) ?? 'setup'

  switch (sub) {
    case 'setup':
      return handleBotCommandArgs(interaction, ctx, ['status'])
    case 'schedule':
      return handleBotCommandArgs(interaction, ctx, ['schedule', 'list'])
    case 'doctor':
      return handleDoctor(interaction, ctx)
    default:
      await interaction.reply({ content: `Unknown command: ${sub}`, flags: 64 })
  }
}
