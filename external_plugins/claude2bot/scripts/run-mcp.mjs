#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { copyFile, access } from 'fs/promises'
import { constants } from 'fs'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { homedir } from 'os'

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
const pluginData = process.env.CLAUDE_PLUGIN_DATA

if (!pluginRoot) {
  process.stderr.write('run-mcp: CLAUDE_PLUGIN_ROOT is required\n')
  process.exit(1)
}

if (!pluginData) {
  process.stderr.write('run-mcp: CLAUDE_PLUGIN_DATA is required\n')
  process.exit(1)
}

// If cache version exists, defer to it (marketplace source should not run MCP directly)
const cacheMarker = join(homedir(), '.claude', 'plugins', 'cache', 'claude2bot', 'claude2bot')
if (existsSync(cacheMarker) && !pluginRoot.replace(/\\/g, '/').includes('/cache/')) {
  process.exit(0)
}

const manifestPath = join(pluginRoot, 'package.json')
const lockfilePath = join(pluginRoot, 'package-lock.json')
const dataManifestPath = join(pluginData, 'package.json')
const dataLockfilePath = join(pluginData, 'package-lock.json')
const dataNodeModules = join(pluginData, 'node_modules')
const tsxBin = join(
  dataNodeModules,
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
)
const logPath = join(pluginData, 'run-mcp.log')

function log(message) {
  writeFileSync(
    logPath,
    `[${new Date().toISOString()}] ${message}\n`,
    { flag: 'a' },
  )
}

function fileContents(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function runInstall(command, args) {
  const result = spawnSync(command, args, {
    cwd: pluginData,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

async function syncDependenciesIfNeeded() {
  mkdirSync(pluginData, { recursive: true })
  log(`invoked root=${pluginRoot} data=${pluginData}`)

  let needsInstall = false
  if (fileContents(manifestPath) !== fileContents(dataManifestPath)) {
    needsInstall = true
  }
  if (!(await isExecutable(tsxBin))) {
    needsInstall = true
  }

  if (!needsInstall) {
    return
  }

  log('dependency sync required')
  rmSync(dataNodeModules, { recursive: true, force: true })
  await copyFile(manifestPath, dataManifestPath)

  if (fileContents(lockfilePath) != null) {
    await copyFile(lockfilePath, dataLockfilePath)
    runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--silent'])
    log('npm ci completed')
    return
  }

  runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--silent'])
  log('npm install completed')
}

await syncDependenciesIfNeeded()

const serverTs = join(pluginRoot, 'server.ts')
const spawnEnv = {
  ...process.env,
  NODE_PATH: process.env.NODE_PATH
    ? `${dataNodeModules}${process.platform === 'win32' ? ';' : ':'}${process.env.NODE_PATH}`
    : dataNodeModules,
}

const child = process.platform === 'win32'
  ? (() => {
      const tsxCliPath = join(dataNodeModules, 'tsx', 'dist', 'cli.mjs')
      log(`exec node ${tsxCliPath} ${serverTs}`)
      return spawn('node', [tsxCliPath, serverTs], { cwd: pluginRoot, stdio: 'inherit', env: spawnEnv })
    })()
  : (() => {
      log(`exec ${tsxBin} ${serverTs}`)
      return spawn(tsxBin, [serverTs], { cwd: pluginRoot, stdio: 'inherit', env: spawnEnv })
    })()

child.on('exit', (code, signal) => {
  log(`child exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  process.exit(code ?? 0)
})
child.on('error', err => {
  log(`spawn failed: ${err}`)
  process.stderr.write(`run-mcp: spawn failed: ${err}\n`)
  process.exit(1)
})
