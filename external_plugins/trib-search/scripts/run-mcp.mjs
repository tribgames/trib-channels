#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd()
const pluginData = process.env.CLAUDE_PLUGIN_DATA || path.join(pluginRoot, '.trib-search-data')
const logPath = path.join(pluginData, 'run-mcp.log')

fs.mkdirSync(pluginData, { recursive: true })

function log(message) {
  fs.writeFileSync(
    logPath,
    `[${new Date().toISOString()}] ${message}\n`,
    { flag: 'a' },
  )
}

log(`start root=${pluginRoot} data=${pluginData}`)

function readLocalConfig() {
  try {
    const configPath = path.join(pluginData, 'config.json')
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

const localConfig = readLocalConfig()

const child = spawn('node', [path.join(pluginRoot, 'server.mjs')], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(localConfig?.grokApiKey
      ? {
          GROK_API_KEY: localConfig.grokApiKey,
          XAI_API_KEY: localConfig.grokApiKey,
        }
      : {}),
    ...(localConfig?.firecrawlApiKey
      ? {
          FIRECRAWL_API_KEY: localConfig.firecrawlApiKey,
        }
      : {}),
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: pluginData,
  },
})

child.on('exit', (code, signal) => {
  log(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  process.exit(code ?? 0)
})

child.on('error', error => {
  log(`spawn error=${error}`)
  process.stderr.write(`trib-search run-mcp failed: ${error}\n`)
  process.exit(1)
})
