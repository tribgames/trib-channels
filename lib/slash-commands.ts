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
    .setDescription('Claude Code session control')

  // /claude stop
  claude.addSubcommand(sub =>
    sub.setName('stop').setDescription('Stop current task (SIGINT)'),
  )

  // /claude status
  claude.addSubcommand(sub =>
    sub.setName('status').setDescription('Show session status'),
  )

  // /claude config
  claude.addSubcommand(sub =>
    sub.setName('config').setDescription('Show configuration'),
  )

  // /claude compact
  claude.addSubcommand(sub =>
    sub.setName('compact').setDescription('Compact conversation'),
  )

  // /claude clear
  claude.addSubcommand(sub =>
    sub.setName('clear').setDescription('Clear conversation'),
  )

  // /claude new
  claude.addSubcommand(sub =>
    sub.setName('new').setDescription('Start new session'),
  )

  // /claude model [name]
  claude.addSubcommand(sub =>
    sub
      .setName('model')
      .setDescription('Switch model')
      .addStringOption(opt =>
        opt
          .setName('name')
          .setDescription('Model to switch to')
          .setRequired(true)
          .addChoices(
            { name: 'sonnet', value: 'sonnet' },
            { name: 'opus', value: 'opus' },
          ),
      ),
  )

  // /claude resume
  claude.addSubcommand(sub =>
    sub.setName('resume').setDescription('Resume previous session'),
  )

  // /claude schedule [action]
  claude.addSubcommand(sub =>
    sub
      .setName('schedule')
      .setDescription('Manage schedules')
      .addStringOption(opt =>
        opt
          .setName('action')
          .setDescription('Action to perform')
          .setRequired(true)
          .addChoices(
            { name: 'list', value: 'list' },
            { name: 'add', value: 'add' },
            { name: 'remove', value: 'remove' },
            { name: 'toggle', value: 'toggle' },
          ),
      )
      .addStringOption(opt =>
        opt
          .setName('name')
          .setDescription('Schedule name (required for add/remove/toggle)')
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('time')
          .setDescription('Time in HH:MM format (required for add)')
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('channel')
          .setDescription('Target channel label (required for add)')
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('prompt')
          .setDescription('Prompt text for the schedule (required for add)')
          .setRequired(false),
      ),
  )

  // /claude doctor
  claude.addSubcommand(sub =>
    sub.setName('doctor').setDescription('System diagnostics'),
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
    case 'config':
      ctx.notify(interaction.channelId, `slash:${interaction.user.username}`, '/config')
      await interaction.reply({ content: 'Loading config...', flags: 64 })
      return
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
      await interaction.reply({ content: `Unknown command: ${sub}`, flags: 64 })
  }
}

// ── Individual command handlers ──────────────────────────────────────

async function handleStop(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const ppid = ctx.serverProcess.ppid
  if (!ppid || ppid <= 1) {
    await interaction.reply({ content: 'Parent process not found.', flags: 64 })
    return
  }
  try {
    process.kill(ppid, 'SIGINT')
    await interaction.reply({ content: `SIGINT sent (PID: ${ppid})`, flags: 64 })
  } catch (err) {
    await interaction.reply({
      content: `Failed to send SIGINT: ${err instanceof Error ? err.message : String(err)}`,
      flags: 64,
    })
  }
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    '/status',
  )
  await interaction.reply({ content: 'Checking status...', flags: 64 })
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
    content: `Model switch request: **${model}** (forwarded to session)`,
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
  await interaction.reply({ content: 'Compact request forwarded to session.', flags: 64 })
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
  await interaction.reply({ content: 'Clear request forwarded to session.', flags: 64 })
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
  await interaction.reply({ content: 'New session request forwarded to session.', flags: 64 })
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
  await interaction.reply({ content: 'Resume request forwarded to session.', flags: 64 })
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
        await interaction.reply({ content: 'No schedules registered.', flags: 64 })
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

    case 'remove': {
      if (!name) {
        await interaction.reply({ content: 'Please specify a schedule name. (`/claude schedule remove [name]`)', flags: 64 })
        return
      }
      try {
        const configPath = join(DATA_DIR, 'config.json')
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as PluginConfig
        let found = false
        for (const key of ['nonInteractive', 'interactive'] as const) {
          const arr = config[key]
          if (!arr) continue
          const idx = arr.findIndex(s => s.name === name)
          if (idx >= 0) {
            arr.splice(idx, 1)
            found = true
            break
          }
        }
        if (!found) {
          await interaction.reply({ content: `Schedule "${name}" not found.`, flags: 64 })
          return
        }
        const { writeFileSync } = await import('fs')
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        await interaction.reply({ content: `Schedule "${name}" removed (effective from next tick).`, flags: 64 })
      } catch (err) {
        await interaction.reply({
          content: `Remove failed: ${err instanceof Error ? err.message : String(err)}`,
          flags: 64,
        })
      }
      return
    }

    case 'toggle': {
      if (!name) {
        await interaction.reply({ content: 'Please specify a schedule name. (`/claude schedule toggle [name]`)', flags: 64 })
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
          await interaction.reply({ content: `Schedule "${name}" not found.`, flags: 64 })
          return
        }
        const { writeFileSync } = await import('fs')
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        const entry = [...(config.nonInteractive ?? []), ...(config.interactive ?? [])].find(s => s.name === name)
        const state = entry?.enabled === false ? 'disabled' : 'enabled'
        await interaction.reply({ content: `Schedule "${name}" → **${state}** (effective from next tick)`, flags: 64 })
      } catch (err) {
        await interaction.reply({
          content: `Toggle failed: ${err instanceof Error ? err.message : String(err)}`,
          flags: 64,
        })
      }
      return
    }

    case 'add': {
      if (!name) {
        await interaction.reply({ content: 'Please specify a schedule name. (`/claude schedule add [name]`)', flags: 64 })
        return
      }
      const time = interaction.options.getString('time')
      const channel = interaction.options.getString('channel')
      const prompt = interaction.options.getString('prompt')
      if (!time || !channel || !prompt) {
        await interaction.reply({
          content: 'Missing required options. Usage: `/claude schedule add name:<name> time:<HH:MM> channel:<label> prompt:<text>`',
          flags: 64,
        })
        return
      }
      try {
        const configPath = join(DATA_DIR, 'config.json')
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as PluginConfig
        if (!config.interactive) config.interactive = []
        const exists = config.interactive.find(s => s.name === name)
        if (exists) {
          await interaction.reply({ content: `Schedule "${name}" already exists.`, flags: 64 })
          return
        }
        config.interactive.push({ name, time, channel, enabled: true })
        const { writeFileSync } = await import('fs')
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        // Write prompt file
        const promptsDir = ctx.config.promptsDir ?? join(DATA_DIR, 'prompts')
        const promptPath = join(promptsDir, `${name}.md`)
        writeFileSync(promptPath, prompt + '\n', 'utf8')
        await interaction.reply({
          content: `Schedule "${name}" added (time: ${time}, channel: ${channel}). Prompt saved to ${name}.md.`,
          flags: 64,
        })
      } catch (err) {
        await interaction.reply({
          content: `Add failed: ${err instanceof Error ? err.message : String(err)}`,
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
    lines.push('[PASS] Config file exists')
  } else {
    lines.push('[FAIL] Config file missing')
  }

  // 2. Bot token
  const hasToken =
    (ctx.config.backend === 'discord' && ctx.config.discord?.token) ||
    (ctx.config.backend === 'telegram' && ctx.config.telegram?.token)
  lines.push(hasToken ? '[PASS] Bot token configured' : '[FAIL] Bot token missing')

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
      lines.push('[WARN] access.json parse failed')
    }
  } else {
    lines.push('[WARN] access.json missing — configure with /claude2bot:access')
  }

  // 4. Schedules
  const statuses = ctx.scheduler.getStatus()
  lines.push(`[INFO] ${statuses.length} schedules registered`)

  // Check prompt files
  const promptsDir = ctx.config.promptsDir ?? join(DATA_DIR, 'prompts')
  for (const s of statuses) {
    if (s.type === 'proactive') continue
    const promptFile = join(promptsDir, `${s.name}.md`)
    if (!existsSync(promptFile)) {
      lines.push(`[WARN] Prompt missing: ${s.name}.md`)
    }
  }

  // 5. Channels
  if (ctx.config.channelsConfig) {
    const chCount = Object.keys(ctx.config.channelsConfig.channels).length
    lines.push(`[PASS] ${chCount} channels configured`)
  } else {
    lines.push('[WARN] channelsConfig not set')
  }

  // 6. Voice
  if (ctx.config.voice?.enabled) {
    lines.push('[INFO] Voice enabled')
  }

  // 7. Process health
  lines.push(`[INFO] PID ${process.pid}, uptime ${Math.floor(process.uptime() / 60)}m`)

  await interaction.reply({ content: '```\n' + lines.join('\n') + '\n```', flags: 64 })
}
