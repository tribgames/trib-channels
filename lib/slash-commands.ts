/**
 * Discord slash command definitions, registration, and handler logic.
 *
 * Commands are registered as guild commands (instant propagation).
 * All responses are ephemeral (visible only to the invoking user).
 */

import { REST, Routes, SlashCommandBuilder, SlashCommandSubcommandBuilder } from 'discord.js'
import type { ChatInputCommandInteraction, Client } from 'discord.js'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { PluginConfig, ChannelsConfig } from '../backends/types.js'
import type { Scheduler } from './scheduler.js'
import { DATA_DIR } from './config.js'

// ── Types ────────────────────────────────────────────────────────────

export type NotifyFn = (channelId: string, user: string, text: string) => void

export interface SlashCommandContext {
  config: PluginConfig
  scheduler: Scheduler
  /** Inject a command into the MCP session as a notification */
  notify: NotifyFn
  /** The MCP server's process (for stop command) */
  serverProcess: NodeJS.Process
}

// ── Command definitions ──────────────────────────────────────────────

function buildCommands(): SlashCommandBuilder {
  const claude = new SlashCommandBuilder()
    .setName('claude')
    .setDescription('Claude Code 세션 제어')

  // /claude stop
  claude.addSubcommand(sub =>
    sub.setName('stop').setDescription('현재 작업 중단 (SIGINT)'),
  )

  // /claude status
  claude.addSubcommand(sub =>
    sub.setName('status').setDescription('세션 상태, 토큰, 모델 표시'),
  )

  // /claude model [name]
  claude.addSubcommand(sub =>
    sub
      .setName('model')
      .setDescription('모델 전환')
      .addStringOption(opt =>
        opt
          .setName('name')
          .setDescription('전환할 모델')
          .setRequired(true)
          .addChoices(
            { name: 'sonnet', value: 'sonnet' },
            { name: 'opus', value: 'opus' },
          ),
      ),
  )

  // /claude compact
  claude.addSubcommand(sub =>
    sub.setName('compact').setDescription('대화 컨텍스트 압축'),
  )

  // /claude clear
  claude.addSubcommand(sub =>
    sub.setName('clear').setDescription('대화 초기화'),
  )

  // /claude new
  claude.addSubcommand(sub =>
    sub.setName('new').setDescription('새 세션 시작'),
  )

  // /claude resume
  claude.addSubcommand(sub =>
    sub.setName('resume').setDescription('이전 세션 이어하기'),
  )

  // /claude schedule [action]
  claude.addSubcommand(sub =>
    sub
      .setName('schedule')
      .setDescription('스케줄 관리')
      .addStringOption(opt =>
        opt
          .setName('action')
          .setDescription('수행할 작업')
          .setRequired(true)
          .addChoices(
            { name: 'list', value: 'list' },
            { name: 'run', value: 'run' },
            { name: 'toggle', value: 'toggle' },
          ),
      )
      .addStringOption(opt =>
        opt
          .setName('name')
          .setDescription('스케줄 이름 (run/toggle 시 필수)')
          .setRequired(false),
      ),
  )

  // /claude doctor
  claude.addSubcommand(sub =>
    sub.setName('doctor').setDescription('봇/훅/연결 상태 진단'),
  )

  return claude
}

// ── Registration ─────────────────────────────────────────────────────

export async function registerSlashCommands(client: Client, token: string): Promise<void> {
  if (!client.user) return
  const rest = new REST({ version: '10' }).setToken(token)
  const commands = [buildCommands().toJSON()]

  // Register to all guilds the bot is in (guild commands propagate instantly)
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands },
      )
      process.stderr.write(`claude2bot: slash commands registered in guild ${guild.name}\n`)
    } catch (err) {
      process.stderr.write(`claude2bot: failed to register slash commands in ${guild.name}: ${err}\n`)
    }
  }
}

// ── Handler ──────────────────────────────────────────────────────────

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const sub = interaction.options.getSubcommand()

  switch (sub) {
    case 'stop':
      return handleStop(interaction, ctx)
    case 'status':
      return handleStatus(interaction, ctx)
    case 'model':
      return handleModel(interaction, ctx)
    case 'compact':
      return handleCompact(interaction, ctx)
    case 'clear':
      return handleClear(interaction, ctx)
    case 'new':
      return handleNew(interaction, ctx)
    case 'resume':
      return handleResume(interaction, ctx)
    case 'schedule':
      return handleSchedule(interaction, ctx)
    case 'doctor':
      return handleDoctor(interaction, ctx)
    default:
      await interaction.reply({ content: `알 수 없는 명령: ${sub}`, flags: 64 })
  }
}

// ── Individual command handlers ──────────────────────────────────────

async function handleStop(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const ppid = ctx.serverProcess.ppid
  if (!ppid || ppid <= 1) {
    await interaction.reply({ content: '부모 프로세스를 찾을 수 없습니다.', flags: 64 })
    return
  }
  try {
    process.kill(ppid, 'SIGINT')
    await interaction.reply({ content: `SIGINT 전송 완료 (PID: ${ppid})`, flags: 64 })
  } catch (err) {
    await interaction.reply({
      content: `SIGINT 전송 실패: ${err instanceof Error ? err.message : String(err)}`,
      flags: 64,
    })
  }
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const lines: string[] = []

  // Backend
  lines.push(`**Backend**: ${ctx.config.backend}`)

  // Channels
  const chCfg = ctx.config.channelsConfig
  if (chCfg) {
    lines.push(`**Main channel**: ${chCfg.main}`)
    const chCount = Object.keys(chCfg.channels).length
    lines.push(`**Channels**: ${chCount}개 등록`)
  }

  // Schedules
  const statuses = ctx.scheduler.getStatus()
  const nonInteractive = statuses.filter(s => s.type === 'non-interactive')
  const interactive = statuses.filter(s => s.type === 'interactive')
  const proactive = statuses.filter(s => s.type === 'proactive')
  lines.push(`**Schedules**: non-interactive ${nonInteractive.length}, interactive ${interactive.length}, proactive ${proactive.length}`)

  // Voice
  lines.push(`**Voice**: ${ctx.config.voice?.enabled ? 'enabled' : 'disabled'}`)

  // Process
  lines.push(`**PID**: ${process.pid} (parent: ${process.ppid})`)
  const uptimeMin = Math.floor(process.uptime() / 60)
  lines.push(`**Uptime**: ${uptimeMin}분`)
  const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1)
  lines.push(`**Memory**: ${memMB}MB`)

  await interaction.reply({ content: lines.join('\n'), flags: 64 })
}

async function handleModel(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const model = interaction.options.getString('name', true)

  // Inject as a channel notification — the session will interpret /model command
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    `/model ${model}`,
  )

  await interaction.reply({
    content: `모델 전환 요청: **${model}** (세션에 전달됨)`,
    flags: 64,
  })
}

async function handleCompact(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    '/compact',
  )
  await interaction.reply({ content: '컨텍스트 압축 요청이 세션에 전달되었습니다.', flags: 64 })
}

async function handleClear(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    '/clear',
  )
  await interaction.reply({ content: '대화 초기화 요청이 세션에 전달되었습니다.', flags: 64 })
}

async function handleNew(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    '/new',
  )
  await interaction.reply({ content: '새 세션 시작 요청이 세션에 전달되었습니다.', flags: 64 })
}

async function handleResume(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    '/resume',
  )
  await interaction.reply({ content: '세션 이어하기 요청이 세션에 전달되었습니다.', flags: 64 })
}

async function handleSchedule(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const action = interaction.options.getString('action', true)
  const name = interaction.options.getString('name')

  switch (action) {
    case 'list': {
      const statuses = ctx.scheduler.getStatus()
      if (statuses.length === 0) {
        await interaction.reply({ content: '등록된 스케줄이 없습니다.', flags: 64 })
        return
      }
      const lines = statuses.map(s => {
        const state = s.running ? ' **[RUNNING]**' : ''
        const last = s.lastFired ? ` | last: ${s.lastFired}` : ''
        return `\`${s.name}\` — ${s.time} ${s.days} (${s.type})${state}${last}`
      })
      await interaction.reply({ content: lines.join('\n'), flags: 64 })
      return
    }

    case 'run': {
      if (!name) {
        await interaction.reply({ content: '스케줄 이름을 지정해주세요. (`/claude schedule run [name]`)', flags: 64 })
        return
      }
      try {
        const result = await ctx.scheduler.triggerManual(name)
        await interaction.reply({ content: result, flags: 64 })
      } catch (err) {
        await interaction.reply({
          content: `실행 실패: ${err instanceof Error ? err.message : String(err)}`,
          flags: 64,
        })
      }
      return
    }

    case 'toggle': {
      if (!name) {
        await interaction.reply({ content: '스케줄 이름을 지정해주세요. (`/claude schedule toggle [name]`)', flags: 64 })
        return
      }
      // Toggle enabled state in config.json
      try {
        const configPath = join(DATA_DIR, 'config.json')
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as PluginConfig
        let found = false
        for (const arr of [config.nonInteractive, config.interactive]) {
          if (!arr) continue
          const entry = arr.find(s => s.name === name)
          if (entry) {
            entry.enabled = entry.enabled === false ? true : false
            found = true
            break
          }
        }
        if (!found) {
          await interaction.reply({ content: `스케줄 "${name}"을 찾을 수 없습니다.`, flags: 64 })
          return
        }
        const { writeFileSync } = await import('fs')
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        const entry = [...(config.nonInteractive ?? []), ...(config.interactive ?? [])].find(s => s.name === name)
        const state = entry?.enabled === false ? 'disabled' : 'enabled'
        await interaction.reply({ content: `스케줄 "${name}" → **${state}** (다음 틱부터 적용)`, flags: 64 })
      } catch (err) {
        await interaction.reply({
          content: `토글 실패: ${err instanceof Error ? err.message : String(err)}`,
          flags: 64,
        })
      }
      return
    }
  }
}

async function handleDoctor(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const lines: string[] = []

  // 1. Config
  const configPath = join(DATA_DIR, 'config.json')
  if (existsSync(configPath)) {
    lines.push('[PASS] Config 파일 존재')
  } else {
    lines.push('[FAIL] Config 파일 없음')
  }

  // 2. Bot token
  const hasToken =
    (ctx.config.backend === 'discord' && ctx.config.discord?.token) ||
    (ctx.config.backend === 'telegram' && ctx.config.telegram?.token)
  lines.push(hasToken ? '[PASS] 봇 토큰 설정됨' : '[FAIL] 봇 토큰 없음')

  // 3. Access control
  const stateDir = ctx.config.discord?.stateDir ?? join(DATA_DIR, 'discord')
  const accessPath = join(stateDir, 'access.json')
  if (existsSync(accessPath)) {
    try {
      const access = JSON.parse(readFileSync(accessPath, 'utf8'))
      const userCount = (access.allowFrom ?? []).length
      const chCount = Object.keys(access.channels ?? {}).length
      lines.push(`[PASS] Access: ${userCount} users, ${chCount} channels`)
    } catch {
      lines.push('[WARN] access.json 파싱 실패')
    }
  } else {
    lines.push('[WARN] access.json 없음 — /claude2bot:access 로 설정')
  }

  // 4. Schedules
  const statuses = ctx.scheduler.getStatus()
  lines.push(`[INFO] 스케줄 ${statuses.length}개 등록`)

  // Check prompt files
  const promptsDir = ctx.config.promptsDir ?? join(DATA_DIR, 'prompts')
  for (const s of statuses) {
    if (s.type === 'proactive') continue
    const promptFile = join(promptsDir, `${s.name}.md`)
    if (!existsSync(promptFile)) {
      lines.push(`[WARN] 프롬프트 없음: ${s.name}.md`)
    }
  }

  // 5. Channels
  if (ctx.config.channelsConfig) {
    const chCount = Object.keys(ctx.config.channelsConfig.channels).length
    lines.push(`[PASS] 채널 설정 ${chCount}개`)
  } else {
    lines.push('[WARN] channelsConfig 미설정')
  }

  // 6. Voice
  if (ctx.config.voice?.enabled) {
    lines.push('[INFO] Voice 활성화')
  }

  // 7. Process health
  lines.push(`[INFO] PID ${process.pid}, uptime ${Math.floor(process.uptime() / 60)}분`)

  await interaction.reply({ content: '```\n' + lines.join('\n') + '\n```', flags: 64 })
}
