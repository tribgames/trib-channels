/**
 * Discord slash command definitions, registration, and handler logic.
 *
 * Commands are registered as guild commands (instant propagation).
 * All responses are ephemeral (visible only to the invoking user).
 */

import { REST, Routes, SlashCommandBuilder } from 'discord.js'
import type { ChatInputCommandInteraction, Client } from 'discord.js'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PluginConfig, WebhookEndpoint, EventRule } from '../backends/types.js'
import type { Scheduler } from './scheduler.js'
import { DATA_DIR } from './config.js'
import { runBotCommand, type CommandContext, type CommandResult } from './custom-commands.js'
import { controlClaudeSession } from './session-control.js'
import {
  detectRuntimeMode,
  runtimeModeHint,
  runtimeModeLabel,
  supportsInteractiveSessionCommands,
  supportsSessionControl,
  type RuntimeMode,
} from './runtime-mode.js'
import { t, getLang } from './i18n.js'

// ── Constants ────────────────────────────────────────────────────────

const EMBED_COLOR = 0x5865F2 // Discord blurple

// ── Types ────────────────────────────────────────────────────────────

export type NotifyFn = (channelId: string, user: string, text: string) => void

export interface SlashCommandContext {
  config: PluginConfig
  scheduler: Scheduler
  instanceId: string
  turnEndFile: string
  runtimeMode: RuntimeMode
  reloadRuntimeConfig: () => void
  /** Re-discover and rebind the current transcript/session context for a channel */
  refreshSessionContext: (channelId: string, mode?: 'same' | 'new') => Promise<void>
  /** Inject a command into the MCP session as a notification */
  notify: NotifyFn
  /** The MCP server's process (for stop command) */
  serverProcess: NodeJS.Process
}

// ── Command definitions ──────────────────────────────────────────────

function buildClaudeCommand(runtimeMode: RuntimeMode): SlashCommandBuilder {
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

  if (supportsInteractiveSessionCommands(runtimeMode)) {
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
  }

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


  // /claude2bot schedule [action] [name] [time] [channel]
  claude2bot.addSubcommand(sub =>
    sub.setName('schedule').setDescription('Manage schedules')
      .addStringOption(opt =>
        opt.setName('action').setDescription('list, add, remove, test').setRequired(false)
          .addChoices(
            { name: 'list', value: 'list' },
            { name: 'add', value: 'add' },
            { name: 'remove', value: 'remove' },
            { name: 'test', value: 'test' },
          ))
      .addStringOption(opt =>
        opt.setName('name').setDescription('Schedule name').setRequired(false))
      .addStringOption(opt =>
        opt.setName('time').setDescription('Time (HH:MM, hourly, every30m)').setRequired(false))
      .addStringOption(opt =>
        opt.setName('channel').setDescription('Target channel').setRequired(false)),
  )

  // /claude2bot autotalk [level]
  claude2bot.addSubcommand(sub =>
    sub.setName('autotalk').setDescription('Set autotalk frequency')
      .addStringOption(opt =>
        opt.setName('level').setDescription('OFF, or 1-5 (3/5/7/10/15 per day)').setRequired(false)),
  )

  // /claude2bot quiet [schedule]
  claude2bot.addSubcommand(sub =>
    sub.setName('quiet').setDescription('Set quiet hours')
      .addStringOption(opt =>
        opt.setName('schedule').setDescription('HH:MM-HH:MM or off').setRequired(false)),
  )

  // /claude2bot sleeping [action] [value]
  claude2bot.addSubcommand(sub =>
    sub.setName('sleeping').setDescription('Sleeping mode control')
      .addStringOption(opt =>
        opt.setName('action').setDescription('on, off, run, time').setRequired(false)
          .addChoices(
            { name: 'on', value: 'on' },
            { name: 'off', value: 'off' },
            { name: 'run', value: 'run' },
            { name: 'time', value: 'time' },
          ))
      .addStringOption(opt =>
        opt.setName('value').setDescription('Time value for "time" action (HH:MM)').setRequired(false)),
  )

  // /claude2bot profile
  claude2bot.addSubcommand(sub =>
    sub.setName('profile').setDescription('Show/edit bot profile'),
  )

  // /claude2bot summarize
  claude2bot.addSubcommand(sub =>
    sub.setName('summarize').setDescription('Summarize conversations and update memory (no restart)'),
  )

  // /claude2bot webhook [action] [name] [parser] [mode] [exec] [channel]
  claude2bot.addSubcommand(sub =>
    sub.setName('webhook').setDescription('Manage webhook endpoints')
      .addStringOption(opt =>
        opt.setName('action').setDescription('list, add, remove, test').setRequired(false)
          .addChoices(
            { name: 'list', value: 'list' },
            { name: 'add', value: 'add' },
            { name: 'remove', value: 'remove' },
            { name: 'test', value: 'test' },
          ))
      .addStringOption(opt =>
        opt.setName('name').setDescription('Endpoint name').setRequired(false))
      .addStringOption(opt =>
        opt.setName('parser').setDescription('Parser type').setRequired(false)
          .addChoices(
            { name: 'github', value: 'github' },
            { name: 'sentry', value: 'sentry' },
            { name: 'generic', value: 'generic' },
            { name: 'none (raw)', value: 'none' },
          ))
      .addStringOption(opt =>
        opt.setName('mode').setDescription('Processing mode').setRequired(false)
          .addChoices(
            { name: 'immediate', value: 'immediate' },
            { name: 'batch', value: 'batch' },
          ))
      .addStringOption(opt =>
        opt.setName('exec').setDescription('Execution type').setRequired(false)
          .addChoices(
            { name: 'interactive', value: 'interactive' },
            { name: 'non-interactive', value: 'non-interactive' },
            { name: 'script', value: 'script' },
          ))
      .addStringOption(opt =>
        opt.setName('channel').setDescription('Target channel label').setRequired(false)),
  )

  // /claude2bot event [action] [name]
  claude2bot.addSubcommand(sub =>
    sub.setName('event').setDescription('Manage event automation rules')
      .addStringOption(opt =>
        opt.setName('action').setDescription('list, remove, status').setRequired(false)
          .addChoices(
            { name: 'list', value: 'list' },
            { name: 'remove', value: 'remove' },
            { name: 'status', value: 'status' },
          ))
      .addStringOption(opt =>
        opt.setName('name').setDescription('Rule name').setRequired(false)),
  )

  return claude2bot
}

// ── Registration ─────────────────────────────────────────────────────

export async function registerSlashCommands(client: Client, token: string): Promise<void> {
  if (!client.user) return
  const rest = new REST({ version: '10' }).setToken(token)
  const runtimeMode = detectRuntimeMode()
  const commands = [buildClaude2BotCommand().toJSON()]
  if (supportsSessionControl(runtimeMode)) {
    commands.unshift(buildClaudeCommand(runtimeMode).toJSON())
  }

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
      process.stderr.write(`claude2bot: slash commands registered in guild ${(guild as any).name ?? guild.id} (mode=${runtimeMode})\n`)
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

  if (ctx.config.access) {
    lines.push(`**Access** \u{2705} ${(ctx.config.access.allowFrom ?? []).length} users, ${Object.keys(ctx.config.access.channels ?? {}).length} channels`)
  } else {
    lines.push('**Access** \u{26a0}\u{fe0f} Not configured')
  }

  const statuses = ctx.scheduler.getStatus()
  const promptsDir = ctx.config.promptsDir ?? join(DATA_DIR, 'prompts')
  const missingPrompts = statuses.filter(s => s.type !== 'proactive' && !existsSync(join(promptsDir, `${s.name}.md`)))
  let schedLine = `**Schedules** \u{2705} ${statuses.length} registered`
  if (missingPrompts.length > 0) schedLine += ` (\u{26a0}\u{fe0f} missing: ${missingPrompts.map(s => s.name).join(', ')})`
  lines.push(schedLine)

  if (ctx.config.channelsConfig) {
    lines.push(`**Channels** \u{2705} ${Object.keys(ctx.config.channelsConfig.channels).length} configured`)
  } else { lines.push('**Channels** \u{26a0}\u{fe0f} Not configured') }

  const mode = runtimeModeLabel(ctx.runtimeMode)
  const sessionControl = supportsSessionControl(ctx.runtimeMode)
  const interactiveCommands = supportsInteractiveSessionCommands(ctx.runtimeMode)
  lines.push(`**Runtime** ${mode}`)
  lines.push(`**Session Control** ${sessionControl ? '\u{2705}' : '\u{26a0}\u{fe0f}'} ${runtimeModeHint(ctx.runtimeMode)}`)
  lines.push(`**Interactive Commands** ${interactiveCommands ? '\u{2705} Enabled' : '\u{26a0}\u{fe0f} Hidden'}`)
  lines.push('**Voice** \u2705 Auto server transcription')
  lines.push(`**Process** PID ${process.pid}, uptime ${Math.floor(process.uptime() / 60)}m`)

  await interaction.reply({ embeds: [{ description: lines.join('\n'), color: allPass ? 0x57F287 : 0xFEE75C }], flags: 64 })
}

async function handleSetupOverview(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const tokenReady = Boolean(ctx.config.discord?.token)
  const channelCount = Object.keys(ctx.config.channelsConfig?.channels ?? {}).length
  const accessCount = Object.keys(ctx.config.access?.channels ?? {}).length
  const lines = [
    `**Setup Ready** ${tokenReady && channelCount > 0 ? '\u2705' : '\u26a0\uFE0F'}`,
    `**Token** ${tokenReady ? '\u2705' : '\u274c Missing'}`,
    `**Channels** ${channelCount > 0 ? `\u2705 ${channelCount}` : '\u274c Missing'}`,
    `**Access** ${accessCount > 0 ? `\u2705 ${accessCount}` : '\u274c Missing'}`,
    '',
    '**First Run**',
    '1. Open the tray app setup or Discord Developer Portal',
    '2. Create a bot and copy Bot Token + Client ID',
    '3. Invite the bot to your server',
    '4. Paste main/sub channel links or IDs into config',
    '',
    '**Simple Commands**',
    '`/claude2bot doctor`',
    '`/claude2bot profile`',
    '`/claude2bot summarize`',
    '',
    '**Parameterized Commands**',
    '`/claude2bot autotalk level:<1-5|OFF>`',
    '`/claude2bot quiet schedule:<HH:MM-HH:MM>`',
    '`/claude2bot sleeping action:<on|off|run|time>`',
    '`/claude2bot schedule action:<list|add|remove|test>`',
    '',
    '**Optional Add-ons**',
    'Launcher/tray: auto restart and background management',
    'ngrok: webhook exposure',
    'whisper CLI: voice transcription',
  ]

  await interaction.reply({
    embeds: [{
      title: 'claude2bot Setup',
      description: lines.join('\n'),
      color: EMBED_COLOR,
    }],
    flags: 64,
  })
}

// ── /claude2bot handlers ─────────────────────────────────────────────

/** Convert Discord locale to CommandContext lang ('ko' | 'en') */
function getCmdLang(locale: string): 'ko' | 'en' {
  return getLang(locale) === 'ko' ? 'ko' : 'en'
}

/** Reply to interaction with CommandResult (text, embeds, components) */
async function replyWithResult(
  interaction: ChatInputCommandInteraction,
  result: CommandResult,
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
    const result = await runBotCommand(args, {}, cmdCtx)
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
      return handleSetupOverview(interaction, ctx)
    case 'schedule': {
      const action = interaction.options.getString('action') ?? 'list'
      const name = interaction.options.getString('name')
      const time = interaction.options.getString('time')
      const channel = interaction.options.getString('channel')
      const args = ['schedule', action]
      if (name) args.push(name)
      if (time) args.push(`time=${time}`)
      if (channel) args.push(`channel=${channel}`)
      return handleBotCommandArgs(interaction, ctx, args)
    }
    case 'doctor':
      return handleDoctor(interaction, ctx)
    case 'autotalk': {
      const level = interaction.options.getString('level')
      return handleBotCommandArgs(interaction, ctx, level ? ['autotalk', level] : ['autotalk', 'status'])
    }
    case 'quiet': {
      const schedule = interaction.options.getString('schedule')
      return handleBotCommandArgs(interaction, ctx, schedule ? ['quiet', 'schedule', schedule] : ['quiet', 'status'])
    }
    case 'sleeping': {
      const action = interaction.options.getString('action') ?? 'status'
      const value = interaction.options.getString('value')
      const args = ['sleeping', action]
      if (value) args.push(value)
      return handleBotCommandArgs(interaction, ctx, args)
    }
    case 'profile':
      return handleBotCommandArgs(interaction, ctx, ['profile', 'status'])
    case 'summarize':
      return handleBotCommandArgs(interaction, ctx, ['sleeping', 'run'])
    case 'webhook': {
      const action = interaction.options.getString('action') ?? 'list'
      return handleWebhook(interaction, ctx, action)
    }
    case 'event': {
      const action = interaction.options.getString('action') ?? 'list'
      return handleEvent(interaction, ctx, action)
    }
    case 'workspace': {
      const wsPath = interaction.options.getString('path')
      if (wsPath) {
          await interaction.reply({
          embeds: [{ title: 'Workspace', description: `Use CLI: \`launcher workspace ${wsPath}\``, color: 0x5865F2 }],
          flags: 64,
        })
      } else {
        await interaction.reply({
          embeds: [{ title: 'Workspace', description: process.cwd(), color: 0x5865F2 }],
          flags: 64,
        })
      }
      return
    }
    default:
      await interaction.reply({ content: `Unknown command: ${sub}`, flags: 64 })
  }
}

// ── Webhook slash command handler ─────────────────────────────────────

async function handleWebhook(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
  action: string,
): Promise<void> {
  const configPath = join(DATA_DIR, 'config.json')

  switch (action) {
    case 'list': {
      const webhook = ctx.config.webhook
      if (!webhook?.enabled || !webhook.endpoints || Object.keys(webhook.endpoints).length === 0) {
        await interaction.reply({
          embeds: [{
            title: 'Webhook Endpoints',
            description: 'No webhook endpoints configured.\nUse `/claude2bot webhook add` to create one.',
            color: EMBED_COLOR,
          }],
          flags: 64,
        })
        return
      }

      const lines = Object.entries(webhook.endpoints).map(([name, ep]) => {
        const url = webhook.ngrokDomain
          ? `https://${webhook.ngrokDomain}/webhook/${name}`
          : `http://localhost:${webhook.port}/webhook/${name}`
        return `**${name}** — ${ep.mode} / ${ep.exec}\n  parser: \`${ep.parser ?? 'raw'}\` → channel: \`${ep.channel}\`\n  URL: \`${url}\``
      })

      await interaction.reply({
        embeds: [{
          title: `Webhook Endpoints (${Object.keys(webhook.endpoints).length})`,
          description: lines.join('\n\n'),
          footer: { text: `port: ${webhook.port} | batch: ${webhook.batchInterval}m` },
          color: EMBED_COLOR,
        }],
        flags: 64,
      })
      return
    }

    case 'add': {
      const name = interaction.options.getString('name')
      if (!name) {
        await interaction.reply({ content: 'Endpoint name is required. Usage: `/claude2bot webhook add name:<name>`', flags: 64 })
        return
      }

      const parser = interaction.options.getString('parser') ?? undefined
      const mode = (interaction.options.getString('mode') ?? 'batch') as 'immediate' | 'batch'
      const exec = (interaction.options.getString('exec') ?? 'interactive') as 'interactive' | 'non-interactive' | 'script'
      const channel = interaction.options.getString('channel') ?? ctx.config.channelsConfig?.main ?? 'general'

      // Build endpoint
      const endpoint: WebhookEndpoint = {
        execute: '{{raw}}',
        mode,
        exec,
        channel,
      }
      if (parser && parser !== 'none') {
        endpoint.parser = parser as 'github' | 'sentry' | 'generic'
      }

      // Update config
      try {
        const raw = readFileSync(configPath, 'utf8')
        const cfg = JSON.parse(raw)
        if (!cfg.webhook) {
          cfg.webhook = { enabled: true, port: 3333, endpoints: {}, batchInterval: 30 }
        }
        cfg.webhook.enabled = true
        cfg.webhook.endpoints[name] = endpoint
        writeFileSync(configPath, JSON.stringify(cfg, null, 2))
        ctx.reloadRuntimeConfig()

        const url = cfg.webhook.ngrokDomain
          ? `https://${cfg.webhook.ngrokDomain}/webhook/${name}`
          : `http://localhost:${cfg.webhook.port}/webhook/${name}`

        await interaction.reply({
          embeds: [{
            title: `Webhook Added: ${name}`,
            description: `mode: ${mode} | exec: ${exec} | parser: ${parser ?? 'raw'} | channel: ${channel}\n\nURL: \`${url}\``,
            color: 0x57F287,
          }],
          flags: 64,
        })
      } catch (err) {
        await interaction.reply({ content: `Failed to add webhook: ${err}`, flags: 64 })
      }
      return
    }

    case 'remove': {
      const name = interaction.options.getString('name')
      if (!name) {
        await interaction.reply({ content: 'Endpoint name is required.', flags: 64 })
        return
      }

      try {
        const raw = readFileSync(configPath, 'utf8')
        const cfg = JSON.parse(raw)
        if (!cfg.webhook?.endpoints?.[name]) {
          await interaction.reply({ content: `Endpoint "${name}" not found.`, flags: 64 })
          return
        }
        delete cfg.webhook.endpoints[name]
        writeFileSync(configPath, JSON.stringify(cfg, null, 2))
        ctx.reloadRuntimeConfig()

        await interaction.reply({
          embeds: [{
            title: `Webhook Removed: ${name}`,
            color: 0xED4245,
          }],
          flags: 64,
        })
      } catch (err) {
        await interaction.reply({ content: `Failed to remove webhook: ${err}`, flags: 64 })
      }
      return
    }

    case 'test': {
      const name = interaction.options.getString('name')
      if (!name) {
        await interaction.reply({ content: 'Endpoint name is required.', flags: 64 })
        return
      }

      const port = ctx.config.webhook?.port ?? 3333
      const testBody = JSON.stringify({ test: true, source: 'slash-command', timestamp: new Date().toISOString() })

      try {
        const { request } = await import('http')
        await new Promise<void>((resolve, reject) => {
          const req = request({
            hostname: 'localhost',
            port,
            path: `/webhook/${name}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (res) => {
            let data = ''
            res.on('data', (chunk: Buffer) => { data += chunk })
            res.on('end', () => {
              interaction.reply({
                embeds: [{
                  title: `Webhook Test: ${name}`,
                  description: `Status: ${res.statusCode}\nResponse: \`${data.substring(0, 200)}\``,
                  color: res.statusCode === 200 ? 0x57F287 : 0xED4245,
                }],
                flags: 64,
              }).catch(() => {})
              resolve()
            })
          })
          req.on('error', (err) => {
            interaction.reply({ content: `Test failed: ${err.message}`, flags: 64 }).catch(() => {})
            reject(err)
          })
          req.write(testBody)
          req.end()
        })
      } catch { /* handled in callbacks */ }
      return
    }

    default:
      await interaction.reply({ content: `Unknown webhook action: ${action}`, flags: 64 })
  }
}

// ── Event slash command handler ───────────────────────────────────────

async function handleEvent(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
  action: string,
): Promise<void> {
  const configPath = join(DATA_DIR, 'config.json')

  switch (action) {
    case 'list': {
      const rules = ctx.config.events?.rules?.filter(r => r.enabled !== false) ?? []
      if (rules.length === 0) {
        await interaction.reply({
          embeds: [{
            title: 'Event Rules',
            description: 'No event rules configured.\nTell Claude to add one: "GitHub PR 오면 알려줘"',
            color: EMBED_COLOR,
          }],
          flags: 64,
        })
        return
      }

      const lines = rules.map(r => {
        const trigger = r.source === 'watcher' ? `match: \`${r.match}\`` :
                        r.source === 'webhook' ? `parser: \`${r.parser ?? 'raw'}\`` :
                        `path: \`${r.path}\``
        return `**${r.name}** — ${r.source} / ${r.exec}\n  ${trigger} → ${r.priority} priority → channel: \`${r.channel}\``
      })

      await interaction.reply({
        embeds: [{
          title: `Event Rules (${rules.length})`,
          description: lines.join('\n\n'),
          color: EMBED_COLOR,
        }],
        flags: 64,
      })
      return
    }

    case 'remove': {
      const name = interaction.options.getString('name')
      if (!name) {
        await interaction.reply({ content: 'Rule name is required.', flags: 64 })
        return
      }

      try {
        const raw = readFileSync(configPath, 'utf8')
        const cfg = JSON.parse(raw)
        const rules: EventRule[] = cfg.events?.rules ?? []
        const idx = rules.findIndex(r => r.name === name)
        if (idx === -1) {
          await interaction.reply({ content: `Rule "${name}" not found.`, flags: 64 })
          return
        }
        rules.splice(idx, 1)
        if (!cfg.events) cfg.events = {}
        cfg.events.rules = rules
        writeFileSync(configPath, JSON.stringify(cfg, null, 2))
        ctx.reloadRuntimeConfig()

        await interaction.reply({
          embeds: [{
            title: `Event Removed: ${name}`,
            color: 0xED4245,
          }],
          flags: 64,
        })
      } catch (err) {
        await interaction.reply({ content: `Failed to remove rule: ${err}`, flags: 64 })
      }
      return
    }

    case 'status': {
      const rules = ctx.config.events?.rules?.filter(r => r.enabled !== false) ?? []
      const webhookEnabled = ctx.config.webhook?.enabled ?? false
      const port = ctx.config.webhook?.port ?? 3333

      await interaction.reply({
        embeds: [{
          title: 'Event System Status',
          description: [
            `**Rules:** ${rules.length} active`,
            `**Webhook server:** ${webhookEnabled ? `ON (port ${port})` : 'OFF'}`,
            `**Sources:** ${[...new Set(rules.map(r => r.source))].join(', ') || 'none'}`,
          ].join('\n'),
          color: EMBED_COLOR,
        }],
        flags: 64,
      })
      return
    }

    default:
      await interaction.reply({ content: `Unknown event action: ${action}`, flags: 64 })
  }
}
