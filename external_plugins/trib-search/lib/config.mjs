import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(currentDir, '..')
export const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(PLUGIN_ROOT, '.trib-search-data')
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
export const USAGE_PATH = path.join(DATA_DIR, 'usage.local.json')
export const CLI_HOME_DIR = path.join(DATA_DIR, 'cli-home')

export const DEFAULT_CONFIG = {
  rawProviders: ['serper', 'brave', 'perplexity', 'firecrawl', 'tavily'],
  rawMaxResults: 5,
  aiDefaultProvider: 'gemini',
  aiTimeoutMs: 120000,
  grokApiKey: '',
  firecrawlApiKey: '',
  aiModels: {
    grok: 'grok-4',
    gemini: 'gemini-2.5-pro',
    claude: 'sonnet',
    codex: 'gpt-5',
  },
  searchMode: 'search-first',  // 'search-first' | 'ai-first'
  requestTimeoutMs: 30000,
  crawl: {
    maxPages: 10,
    maxDepth: 1,
    sameDomainOnly: true,
  },
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

export function ensureDataDir() {
  ensureDir(DATA_DIR)
  ensureDir(CLI_HOME_DIR)
}

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export function loadConfig() {
  ensureDataDir()
  const config = readJson(CONFIG_PATH, null)
  if (!config) {
    writeJson(CONFIG_PATH, DEFAULT_CONFIG)
    process.stderr.write(
      `trib-search: default config created at ${CONFIG_PATH}\n` +
      '  use /setup to change provider priority and crawl defaults.\n',
    )
  }
  const resolved = config || DEFAULT_CONFIG
  return {
    ...DEFAULT_CONFIG,
    ...resolved,
    aiModels: {
      ...DEFAULT_CONFIG.aiModels,
      ...(resolved?.aiModels || {}),
    },
    crawl: {
      ...DEFAULT_CONFIG.crawl,
      ...(resolved?.crawl || {}),
    },
  }
}
