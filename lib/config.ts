/**
 * Config loading — reads plugin config from CLAUDE_PLUGIN_DATA/config.json
 * and instantiates the appropriate backend.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { DiscordBackend } from '../backends/discord.js'
import { TelegramBackend } from '../backends/telegram.js'
import type { ChannelBackend, PluginConfig, BotConfig, ProfileConfig } from '../backends/types.js'

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

export function loadConfig(): PluginConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(
        `claude2bot: config not found at ${CONFIG_FILE}\n` +
        `  create it with: { "backend": "discord", "discord": { "token": "MTIz..." } }\n`,
      )
      process.exit(1)
    }
    throw err
  }
}

export function createBackend(config: PluginConfig): ChannelBackend {
  switch (config.backend) {
    case 'discord': {
      if (!config.discord?.token) {
        process.stderr.write('claude2bot: discord.token required in config.json\n')
        process.exit(1)
      }
      const stateDir =
        config.discord.stateDir ?? join(DATA_DIR, 'discord')
      mkdirSync(stateDir, { recursive: true })
      return new DiscordBackend(config.discord, stateDir)
    }
    case 'telegram': {
      if (!config.telegram?.token) {
        process.stderr.write('claude2bot: telegram.token required in config.json\n')
        process.exit(1)
      }
      const stateDir =
        config.telegram.stateDir ?? join(DATA_DIR, 'telegram')
      mkdirSync(stateDir, { recursive: true })
      return new TelegramBackend(config.telegram, stateDir)
    }
    default:
      process.stderr.write(`claude2bot: unknown backend "${config.backend}"\n`)
      process.exit(1)
  }
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
