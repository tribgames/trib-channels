/**
 * Config loading — reads plugin config from CLAUDE_PLUGIN_DATA/config.json
 * and instantiates the appropriate backend.
 */

import { readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { DiscordBackend } from '../backends/discord.js'
import { TelegramBackend } from '../backends/telegram.js'
import type { ChannelBackend, PluginConfig } from '../backends/types.js'

export const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), '.claude', 'plugins', 'data', 'claude2bot')

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
        config.discord.stateDir ?? join(homedir(), '.claude', 'channels', 'discord')
      mkdirSync(stateDir, { recursive: true })
      return new DiscordBackend(config.discord, stateDir)
    }
    case 'telegram': {
      if (!config.telegram?.token) {
        process.stderr.write('claude2bot: telegram.token required in config.json\n')
        process.exit(1)
      }
      const stateDir =
        config.telegram.stateDir ?? join(homedir(), '.claude', 'channels', 'telegram')
      mkdirSync(stateDir, { recursive: true })
      return new TelegramBackend(config.telegram, stateDir)
    }
    default:
      process.stderr.write(`claude2bot: unknown backend "${config.backend}"\n`)
      process.exit(1)
  }
}
