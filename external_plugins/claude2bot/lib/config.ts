/**
 * Config loading — reads plugin config from CLAUDE_PLUGIN_DATA/config.json
 * and instantiates the appropriate backend.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { DiscordBackend } from '../backends/discord.js'
import type { AccessConfig, ChannelBackend, PluginConfig, BotConfig, ProfileConfig } from '../backends/types.js'

if (!process.env.CLAUDE_PLUGIN_DATA) {
  process.stderr.write(
    'claude2bot: CLAUDE_PLUGIN_DATA not set.\n' +
    '  This plugin must be run through Claude Code (claude --channels plugin:claude2bot@claude2bot).\n',
  )
  process.exit(1)
}

export const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA

export const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT ?? new URL('..', import.meta.url).pathname

const CONFIG_FILE = join(DATA_DIR, 'config.json')

const DEFAULT_ACCESS: AccessConfig = {
  dmPolicy: 'pairing',
  allowFrom: [],
  channels: {},
}

const DEFAULT_CONFIG = {
  backend: 'discord',
  discord: { token: '' },
  access: DEFAULT_ACCESS,
  channelsConfig: {
    main: 'general',
    channels: {
      general: { id: '', mode: 'interactive' },
    },
  },
}

export function loadConfig(): PluginConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as PluginConfig
    return {
      ...raw,
      access: {
        ...DEFAULT_ACCESS,
        ...(raw.access ?? {}),
        allowFrom: raw.access?.allowFrom ?? [],
        channels: raw.access?.channels ?? {},
        pending: raw.access?.pending ?? {},
      },
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
      process.stderr.write(
        `claude2bot: default config created at ${CONFIG_FILE}\n` +
        `  edit discord.token and channelsConfig.channels.general.id to connect.\n`,
      )
      return DEFAULT_CONFIG as PluginConfig
    }
    throw err
  }
}

export function createBackend(config: PluginConfig): ChannelBackend {
  if (config.backend !== 'discord') {
    process.stderr.write(`claude2bot: unsupported backend "${config.backend}" (discord only)\n`)
    process.exit(1)
  }

  if (!config.discord?.token) {
    process.stderr.write('claude2bot: discord.token required in config.json\n')
    process.exit(1)
  }

  const stateDir =
    config.discord.stateDir ?? join(DATA_DIR, 'discord')
  mkdirSync(stateDir, { recursive: true })
  return new DiscordBackend({
    ...config.discord,
    configPath: CONFIG_FILE,
    access: config.access,
  }, stateDir)
}

// ── bot.json ──────────────────────────────────────────────────────────

const BOT_FILE = join(DATA_DIR, 'bot.json')

export function loadBotConfig(): BotConfig {
  try {
    return JSON.parse(readFileSync(BOT_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function saveBotConfig(bot: BotConfig): void {
  writeFileSync(BOT_FILE, JSON.stringify(bot, null, 2) + '\n')
}

// ── profile.json ──────────────────────────────────────────────────────

const PROFILE_FILE = join(DATA_DIR, 'profile.json')

export function loadProfileConfig(): ProfileConfig {
  try {
    return JSON.parse(readFileSync(PROFILE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function saveProfileConfig(profile: ProfileConfig): void {
  writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2) + '\n')
}
