#!/usr/bin/env node

import { execFileSync, spawnSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import readline from 'readline'
import { cleanMemoryText, getMemoryStore } from './lib/memory.mjs'
import { embedText } from './lib/embedding-provider.mjs'

const MARKETPLACE_NAME = 'claude2bot'
const PLUGIN_SPEC = 'claude2bot@claude2bot'
const MARKETPLACE_SOURCE =
  process.env.CLAUDE2BOT_MARKETPLACE_SOURCE ?? 'https://github.com/claude2bot/claude2bot'
const DEFAULT_SCOPE = process.env.CLAUDE2BOT_INSTALL_SCOPE ?? 'user'
const CONFIG_PATH = join(homedir(), '.claude2bot-launcher.json')
const STATE_PATH = join(homedir(), '.claude2bot-launcher-state.json')
const WEZTERM_DATA_HOME = join(homedir(), '.local', 'share', 'wezterm')
const WEZTERM_RUNTIME_DIR = join(homedir(), '.local', 'share', 'wezterm')
const WEZTERM_SOCKET_PATH = join(WEZTERM_RUNTIME_DIR, 'sock')
const PLUGIN_DATA_DIR = join(homedir(), '.claude', 'plugins', 'data', 'claude2bot-claude2bot')
const HISTORY_DIR = join(PLUGIN_DATA_DIR, 'history')
const VOICE_MODEL_DIR = join(PLUGIN_DATA_DIR, 'voice', 'models')
const DEFAULT_WHISPER_MODEL_NAME = 'ggml-base.bin'
const DEFAULT_WHISPER_MODEL_PATH = join(VOICE_MODEL_DIR, DEFAULT_WHISPER_MODEL_NAME)
const DEFAULT_WHISPER_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_WHISPER_MODEL_NAME}`
const WEZTERM_WORKSPACE = 'default'
const WEZTERM_PROCESS_NAME = 'wezterm-gui'
const STARTUP_CONFIRM_SEQUENCE =
  process.env.CLAUDE2BOT_LAUNCHER_CONFIRM_SEQUENCE === '0'
    ? []
    : (process.env.CLAUDE2BOT_LAUNCHER_CONFIRM_SEQUENCE ?? '1,1')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
const INTERNAL_COMMANDS = new Set(['__confirm-wezterm'])
const LAUNCHER_EXEC_PATH = process.execPath
const LAUNCHER_ENTRY_PATH =
  process.argv[1] && process.argv[1].endsWith('.mjs')
    ? resolve(process.argv[1])
    : ''
const USER_ARGS = LAUNCHER_ENTRY_PATH ? process.argv.slice(2) : process.argv.slice(1)
const DEFAULT_DISPLAY_MODE = 'view'
const MAX_MEMORY_CONSOLIDATE_DAYS = 2
const MAX_MEMORY_CANDIDATES_PER_DAY = 40
const MAX_MEMORY_CONSOLIDATE_BATCHES_PER_DAY = 4
const MAX_MEMORY_CONTEXTUALIZE_ITEMS = 24
const MEMORY_FLUSH_DEFAULT_MAX_DAYS = 1
const MEMORY_FLUSH_DEFAULT_MAX_CANDIDATES = 20
const MEMORY_FLUSH_DEFAULT_MAX_BATCHES = 1
const MEMORY_FLUSH_DEFAULT_MIN_PENDING = 8
const MEMORY_CLAUDE_MODEL = 'sonnet'
const MEMORY_CLAUDE_EFFORT = 'medium'
const MEMORY_RUNNER_PATH = join(resourceDir(), 'scripts', 'claude-safe-runner.mjs')

let launcherMemoryStore = null
function getLauncherMemoryStore() {
  if (!launcherMemoryStore) {
    launcherMemoryStore = getMemoryStore(PLUGIN_DATA_DIR)
  }
  return launcherMemoryStore
}

function selfArgs(args) {
  return LAUNCHER_ENTRY_PATH ? [LAUNCHER_ENTRY_PATH, ...args] : args
}

function resourceDir() {
  if (LAUNCHER_ENTRY_PATH) {
    return dirname(LAUNCHER_ENTRY_PATH)
  }

  const execPath = process.execPath
  const appMatch = execPath.match(/^(.*\/[^/]+\.app)\/Contents\/MacOS\/[^/]+$/)
  if (appMatch) {
    return join(appMatch[1], 'Contents', 'Resources')
  }

  return dirname(execPath)
}

function resolveWezTermConfigPath() {
  return join(resourceDir(), 'launcher-wezterm.lua')
}

function launcherWindowTitle(workspacePath) {
  return `claude2bot launcher — ${resolve(workspacePath)}`
}

function printHelp() {
  process.stdout.write([
    'claude2bot launcher',
    '',
    'Commands:',
    '  install                Add marketplace and install/enable the plugin',
    '  update                 Update the plugin and marketplace metadata',
    '  launch                 Open Claude Code in launcher mode',
    '  restart                Restart the launcher-managed Claude session',
  '  stop                   Stop all launcher processes and clean up',
    '  doctor                 Show environment and installation status',
    '  workspace [path]       Show or set the default workspace path',
    '  display [hide|view]    Show or set the launcher display mode',
    '  install-ngrok          Install ngrok for webhook exposure',
    '  install-voice          Install voice dependencies (ffmpeg + whisper)',
    '  memory-flush          Consolidate recent pending memory candidates',
    '  memory-rebuild        Rebuild facts/tasks/signals from all stored candidates',
    '  memory-rebuild-recent Rebuild recent facts/tasks/signals using current semantic rules',
    '  memory-prune-recent   Keep only recent consolidated memory (facts/tasks/signals/profile)',
    '  sleep-cycle            Run sleeping mode: summarize, restart session',
    '  summarize              Summarize conversations without restart',
    '  config <key> [value]   Get/set config (autotalk, quiet, sleeping, sleeping-time)',
    '',
    'Options:',
    `  --scope <scope>        Plugin install scope (default: ${DEFAULT_SCOPE})`,
    '  --workspace <path>     Override the workspace path for this run',
    `  --display <mode>       Override display mode for this run (${DEFAULT_DISPLAY_MODE})`,
    '',
  ].join('\n') + '\n')
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonFile(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmpPath, filePath)
  return value
}

function readLauncherConfig() {
  return readJsonFile(CONFIG_PATH, {})
}

function writeLauncherConfig(config) {
  return writeJsonFile(CONFIG_PATH, config)
}

function readLauncherState() {
  return readJsonFile(STATE_PATH, {})
}

// Keep in sync with lib/launcher-state.ts weztermEnv()
function weztermEnv() {
  mkdirSync(WEZTERM_DATA_HOME, { recursive: true })
  mkdirSync(WEZTERM_RUNTIME_DIR, { recursive: true })
  return {
    ...process.env,
    XDG_DATA_HOME: WEZTERM_DATA_HOME,
    XDG_RUNTIME_DIR: WEZTERM_RUNTIME_DIR,
    WEZTERM_UNIX_SOCKET: WEZTERM_SOCKET_PATH,
    CLAUDE2BOT_WEZTERM_SOCKET: WEZTERM_SOCKET_PATH,
  }
}

function writeLauncherState(patch) {
  const next = { ...readLauncherState(), ...patch, updatedAt: Date.now() }
  return writeJsonFile(STATE_PATH, next)
}

function resetLauncherState(patch = {}) {
  const next = { ...patch, updatedAt: Date.now() }
  return writeJsonFile(STATE_PATH, next)
}

function trayAppPath() {
  if (LAUNCHER_ENTRY_PATH) {
    return join(dirname(LAUNCHER_ENTRY_PATH), 'dist', 'Claude2BotLauncher.app')
  }

  const execPath = process.execPath
  const appMatch = execPath.match(/^(.*\/)[^/]+\.app\/Contents\/MacOS\/[^/]+$/)
  if (appMatch) {
    return join(appMatch[1], 'Claude2BotLauncher.app')
  }

  return join(dirname(process.cwd()), 'dist', 'Claude2BotLauncher.app')
}

function ensureTrayAppRunningMac() {
  const appPath = trayAppPath()
  if (!existsSync(appPath)) return
  try {
    execFileSync(resolveCommand('open') || 'open', ['-g', appPath], { stdio: 'ignore' })
  } catch (e) {
    process.stderr.write(`[launcher] tray app launch failed: ${e.message}\n`)
  }
}

function latestSessionForWorkspace(workspacePath) {
  try {
    const sessionsDir = join(homedir(), '.claude', 'sessions')
    const files = readdirSync(sessionsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => join(sessionsDir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

    for (const file of files) {
      try {
        const session = JSON.parse(readFileSync(file, 'utf8'))
        if (resolve(session.cwd ?? '') === resolve(workspacePath)) {
          return {
            file,
            pid: session.pid,
            sessionId: session.sessionId,
            mtimeMs: statSync(file).mtimeMs,
          }
        }
      } catch {
        // expected: individual session file may be corrupt or locked
        continue
      }
    }
  } catch {
    // expected: sessions directory may not exist yet
  }

  return null
}

function setWorkspaceConfig(workspacePath) {
  const config = readLauncherConfig()
  config.workspacePath = resolve(workspacePath)
  writeLauncherConfig(config)
  return config.workspacePath
}

function normalizeDisplayMode(value) {
  return value === 'hide' ? 'hide' : 'view'
}

function setDisplayModeConfig(displayMode) {
  const config = readLauncherConfig()
  config.displayMode = normalizeDisplayMode(displayMode)
  writeLauncherConfig(config)
  return config.displayMode
}

function getConfiguredWorkspace() {
  const config = readLauncherConfig()
  const value = config.workspacePath
  if (!value) return ''
  return resolve(value)
}

function getConfiguredDisplayMode() {
  const config = readLauncherConfig()
  return normalizeDisplayMode(config.displayMode ?? DEFAULT_DISPLAY_MODE)
}

function workspaceExists(workspacePath) {
  return Boolean(workspacePath) && existsSync(workspacePath)
}

function getOption(name, fallback) {
  const idx = USER_ARGS.indexOf(name)
  if (idx >= 0 && USER_ARGS[idx + 1]) return USER_ARGS[idx + 1]
  return fallback
}

function getIntegerOption(name, fallback) {
  const raw = getOption(name, '')
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function claudePromptEnv() {
  return {
    ...process.env,
    CLAUDE2BOT_NO_CONNECT: '1',
  }
}

function claudeMemoryPromptArgs(prompt = null) {
  const args = [
    MEMORY_RUNNER_PATH,
    '--model', MEMORY_CLAUDE_MODEL,
    '--effort', MEMORY_CLAUDE_EFFORT,
    '--no-connect',
  ]
  if (prompt != null) args.push(prompt)
  return args
}

function execClaudeMemoryPrompt(prompt, options = {}) {
  return execFileSync(process.execPath, [
    ...claudeMemoryPromptArgs(),
    '--cwd', options.cwd ?? process.cwd(),
    '--timeout-ms', String(Number(options.timeout ?? 120000)),
    '--prompt',
    prompt,
  ], {
    encoding: 'utf8',
    timeout: Number(options.timeout ?? 120000) + 2000,
    env: process.env,
  }).trim()
}

function spawnClaudeMemoryPrompt(input, options = {}) {
  return spawnSync(process.execPath, [
    ...claudeMemoryPromptArgs(),
    '--cwd', options.cwd ?? process.cwd(),
    '--timeout-ms', String(Number(options.timeout ?? 600000)),
  ], {
    cwd: options.cwd,
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: process.env,
    timeout: Number(options.timeout ?? 600000) + 2000,
  })
}

function commandSearchPaths() {
  const paths = new Set((process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean))
  for (const extra of [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local', 'bin'),
    '/Applications/WezTerm.app/Contents/MacOS',
    '/usr/bin',
    '/bin',
    // Windows WezTerm paths
    'C:\\Program Files\\WezTerm',
    'C:\\Program Files (x86)\\WezTerm',
    join(homedir(), 'scoop', 'apps', 'wezterm', 'current'),
    join(homedir(), 'AppData', 'Local', 'Programs', 'WezTerm'),
  ]) {
    paths.add(extra)
  }
  return [...paths]
}

function resolveCommand(name) {
  const which = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = execFileSync(which, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (out) return out.split(/\r?\n/)[0].trim()
  } catch {
    // expected: command may not be in PATH
  }

  for (const dir of commandSearchPaths()) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
    if (process.platform === 'win32' && existsSync(`${candidate}.exe`)) return `${candidate}.exe`
    if (process.platform === 'win32' && existsSync(`${candidate}.cmd`)) return `${candidate}.cmd`
  }

  return ''
}

function hasCommand(name) {
  return Boolean(resolveCommand(name))
}

function resolveWezTermCommand() {
  return resolveCommand('wezterm') || ''
}

function run(cmd, args, inherit = false) {
  const resolved = resolveCommand(cmd) || cmd
  return execFileSync(resolved, args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
}

function runShell(command, inherit = false) {
  if (process.platform === 'win32') {
    const pwsh = resolveCommand('powershell.exe') || 'powershell.exe'
    return execFileSync(pwsh, ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
  }
  const sh = resolveCommand('sh') || 'sh'
  return execFileSync(sh, ['-lc', command], {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function resolveWorkspace(cliWorkspace) {
  if (cliWorkspace) return resolve(cliWorkspace)

  const configured = getConfiguredWorkspace()
  if (configured) return configured

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return process.cwd()
  }

  const current = process.cwd()
  const answer = await ask(`Workspace path not configured. Enter a workspace path or press Enter to use ${current}: `)
  const workspacePath = answer || current
  return setWorkspaceConfig(workspacePath)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`
}

function marketplaceList() {
  return run('claude', ['plugin', 'marketplace', 'list'])
}

function pluginList() {
  return run('claude', ['plugin', 'list'])
}

function getPluginBlock(output) {
  return output.split('\n\n').find(part => part.includes(`❯ ${PLUGIN_SPEC}`)) ?? ''
}

function ensureMarketplace() {
  const out = marketplaceList()
  if (!out.includes(`❯ ${MARKETPLACE_NAME}`)) {
    run('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE], true)
  }
}

function ensureClaudeInstalled() {
  if (hasCommand('claude')) return

  // Prefer user-level install scripts (no sudo)
  if (process.platform === 'win32') {
    runShell('irm https://claude.ai/install.ps1 | iex', true)
    return
  }

  // curl installer installs to ~/.claude/bin (user-level, no sudo)
  runShell('curl -fsSL https://claude.ai/install.sh | bash', true)
}

function ensureNodeTooling() {
  if (hasCommand('npm') && hasCommand('npx')) return

  // brew install node doesn't require sudo on Apple Silicon
  if (process.platform === 'darwin' && hasCommand('brew')) {
    run('brew', ['install', 'node'], true)
    if (hasCommand('npm')) return
  }

  if (process.platform === 'win32' && hasCommand('winget')) {
    run('winget', ['install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-package-agreements', '--accept-source-agreements'], true)
    if (hasCommand('npm')) return
  }

  throw new Error('Node.js is required. Install from https://nodejs.org')
}

function ensurePlugin(scope) {
  const out = pluginList()
  const installed = out.includes(`❯ ${PLUGIN_SPEC}`)
  if (!installed) {
    run('claude', ['plugin', 'install', '--scope', scope, PLUGIN_SPEC], true)
    return
  }

  const block = getPluginBlock(out)
  if (block.includes('Status: ✘ disabled')) {
    run('claude', ['plugin', 'enable', PLUGIN_SPEC], true)
  }
}

function updatePlugin() {
  ensureMarketplace()
  run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE_NAME], true)
  run('claude', ['plugin', 'update', PLUGIN_SPEC], true)
}

function installPlugin(scope) {
  ensureClaudeInstalled()
  ensureNodeTooling()
  ensureMarketplace()
  ensurePlugin(scope)
}

function ensureWezTermInstalled() {
  if (resolveWezTermCommand()) return

  if (process.platform === 'darwin' && hasCommand('brew')) {
    run('brew', ['install', '--cask', 'wezterm'], true)
    if (resolveWezTermCommand()) return
  }

  if (process.platform === 'win32' && hasCommand('winget')) {
    run('winget', ['install', 'wez.wezterm', '-e', '--accept-package-agreements', '--accept-source-agreements'], true)
    if (resolveWezTermCommand()) return
  }

  throw new Error('WezTerm is required but could not be installed automatically.')
}

function ensureNgrokInstalled() {
  if (hasCommand('ngrok')) return

  if (process.platform === 'darwin' && hasCommand('brew')) {
    run('brew', ['install', '--cask', 'ngrok'], true)
    if (hasCommand('ngrok')) return
  }

  if (process.platform === 'win32' && hasCommand('winget')) {
    run('winget', ['install', '-e', '--id', 'Ngrok.Ngrok', '--accept-package-agreements', '--accept-source-agreements'], true)
    if (hasCommand('ngrok')) return
  }

  throw new Error('ngrok is required but could not be installed automatically.')
}

function ensureWhisperModelInstalled() {
  if (existsSync(DEFAULT_WHISPER_MODEL_PATH)) return

  mkdirSync(VOICE_MODEL_DIR, { recursive: true })

  if (process.platform === 'win32') {
    const pwsh = resolveCommand('powershell.exe') || 'powershell.exe'
    execFileSync(pwsh, ['-NoProfile', '-Command', `
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri '${DEFAULT_WHISPER_MODEL_URL}' -OutFile '${DEFAULT_WHISPER_MODEL_PATH.replace(/\\/g, '\\\\')}'
    `], { stdio: 'inherit' })
  } else {
    run('curl', ['-L', '-o', DEFAULT_WHISPER_MODEL_PATH, DEFAULT_WHISPER_MODEL_URL], true)
  }

  if (!existsSync(DEFAULT_WHISPER_MODEL_PATH)) {
    throw new Error(`Failed to download whisper model: ${DEFAULT_WHISPER_MODEL_PATH}`)
  }
}

function installVoiceDependencies() {
  if (process.platform === 'darwin') {
    if (!hasCommand('brew')) {
      throw new Error('Homebrew is required to install voice dependencies on macOS.')
    }
    if (!hasCommand('ffmpeg')) {
      run('brew', ['install', 'ffmpeg'], true)
    }
    if (!hasCommand('whisper-cpp') && !hasCommand('whisper')) {
      run('brew', ['install', 'whisper-cpp'], true)
    }
    ensureWhisperModelInstalled()
    return
  }

  if (process.platform === 'win32') {
    if (hasCommand('winget')) {
      if (!hasCommand('ffmpeg')) {
        run('winget', ['install', '-e', '--id', 'Gyan.FFmpeg', '--accept-package-agreements', '--accept-source-agreements'], true)
      }
      if (!hasCommand('whisper-cpp') && !hasCommand('whisper')) {
        const pwsh = resolveCommand('powershell.exe') || 'powershell.exe'
        execFileSync(pwsh, ['-NoProfile', '-Command', 'Start-Process "https://github.com/ggml-org/whisper.cpp/releases"'], {
          stdio: 'inherit',
        })
      }
      ensureWhisperModelInstalled()
      return
    }
    throw new Error('winget is required to install voice dependencies on Windows.')
  }

  throw new Error('Automatic voice dependency install is not supported on this platform.')
}

function ensureWezTermMuxRunning(wezterm) {
  const env = weztermEnv()
  const configArgs = ['--config-file', resolveWezTermConfigPath()]

  // Check if mux server is reachable via socket
  try {
    execFileSync(wezterm, [...configArgs, 'cli', 'list'], {
      env,
      stdio: 'ignore',
      timeout: 5000,
    })
    return // mux is already running
  } catch {
    // mux not available — start it
  }

  // Clean stale PID lock if the process is dead
  const pidFile = join(WEZTERM_DATA_HOME, 'pid')
  try {
    const stalePid = Number(readFileSync(pidFile, 'utf8').trim())
    if (stalePid) {
      try { process.kill(stalePid, 0) } catch { unlinkSync(pidFile) }
    }
  } catch { /* no pid file or not readable */ }

  // Start wezterm-mux-server --daemonize (headless, no GUI)
  const muxServer = resolveCommand('wezterm-mux-server')
  if (muxServer) {
    try {
      execFileSync(muxServer, [...configArgs, '--daemonize'], {
        env,
        stdio: 'ignore',
        timeout: 10000,
      })
    } catch (e) {
      process.stderr.write(`[launcher] mux-server daemonize failed: ${e.message}\n`)
    }
  }

  // Wait for mux socket to become available
  for (let i = 0; i < 20; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    try {
      execFileSync(wezterm, [...configArgs, 'cli', 'list'], {
        env,
        stdio: 'ignore',
        timeout: 3000,
      })
      return // mux is ready
    } catch {
      // not yet
    }
  }
  throw new Error('Failed to start WezTerm mux server.')
}

function cleanupDefaultMuxPanes() {
  // Kill all default panes created by mux-server startup
  // so that 'wezterm connect' only shows our Claude pane
  try {
    const panes = listWezTermPaneItems()
    for (const p of panes) {
      const id = p?.pane_id ?? p?.paneId
      if (id != null) {
        try { weztermCli(['kill-pane', '--pane-id', String(id)]) } catch { /* may already be gone */ }
      }
    }
  } catch { /* no panes or cli not available */ }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getLaunchSignals(content, tailLength = 4000) {
  const tail = content.slice(-tailLength)
  const devWarning = tail.includes('WARNING: Loading development channels') && tail.includes('Enter to confirm')
  const trustWarning =
    tail.includes('Quick safety check:') &&
    tail.includes('Enter to confirm') &&
    (tail.includes('Yes, I trust this folder') || tail.includes('1. Yes'))

  return {
    tail,
    needsConfirmation: devWarning || trustWarning,
    channelReady:
      tail.includes('Listening for channel messages from: plugin:claude2bot@claude2bot') ||
      tail.includes('/remote-control is active'),
    connecting: tail.includes('Connecting'),
  }
}

function wezTermStatePatch(pane, patch = {}) {
  return {
    terminalWindowId: pane?.windowId ?? null,
    weztermPaneId: pane?.paneId ?? null,
    weztermTabId: pane?.tabId ?? null,
    weztermWindowId: pane?.windowId ?? null,
    weztermWorkspace: pane?.workspace ?? WEZTERM_WORKSPACE,
    ...patch,
  }
}

function weztermCli(args, inherit = false) {
  const wezterm = resolveWezTermCommand()
  if (!wezterm) throw new Error('WezTerm is not installed.')
  return execFileSync(wezterm, ['--config-file', resolveWezTermConfigPath(), 'cli', ...args], {
    encoding: 'utf8',
    env: weztermEnv(),
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'ignore'],
  })
}

function normalizeWorkspaceCandidate(value) {
  if (!value) return ''
  if (typeof value === 'string' && value.startsWith('file://')) {
    try {
      return resolve(decodeURIComponent(new URL(value).pathname))
    } catch {
      return ''
    }
  }
  return resolve(String(value))
}

function listWezTermPaneItems() {
  try {
    const raw = weztermCli(['list', '--format', 'json']).trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parsePaneId(value) {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeWezTermPane(item) {
  return {
    paneId: parsePaneId(item?.pane_id ?? item?.paneId),
    tabId: parsePaneId(item?.tab_id ?? item?.tabId),
    windowId: parsePaneId(item?.window_id ?? item?.windowId),
    workspace: item?.workspace ?? WEZTERM_WORKSPACE,
    cwd: normalizeWorkspaceCandidate(item?.cwd ?? item?.working_dir ?? ''),
  }
}

function listWezTermPanes() {
  return listWezTermPaneItems()
    .map(normalizeWezTermPane)
    .filter(item => item.paneId != null)
    .sort((a, b) => (b.paneId ?? 0) - (a.paneId ?? 0))
}

function cleanupManagedWezTermPane() {
  const state = readLauncherState()
  if (state?.terminalApp !== 'WezTerm' || state.weztermPaneId == null) return
  try {
    weztermCli(['kill-pane', '--pane-id', String(state.weztermPaneId)])
  } catch {
    // expected: pane may have already been closed
  }
}

function findWezTermPane(workspacePath) {
  const expectedWorkspace = WEZTERM_WORKSPACE
  const expectedCwd = resolve(workspacePath)
  const panes = listWezTermPanes()
    .filter(item => item.workspace === expectedWorkspace && item.cwd === expectedCwd)

  return panes[0] ?? null
}

function findWezTermPaneById(paneId) {
  const target = Number(paneId)
  if (!Number.isFinite(target)) return null
  return listWezTermPanes().find(item => item.paneId === target) ?? null
}

function getWezTermPaneText(paneId) {
  try {
    return weztermCli(['get-text', '--pane-id', String(paneId)], false)
  } catch {
    return ''
  }
}

function sendWezTermText(paneId, text) {
  weztermCli(['send-text', '--pane-id', String(paneId), '--no-paste', text], false)
}

async function sendWezTermChoice(paneId, choice) {
  sendWezTermText(paneId, String(choice))
  await sleep(120)
  sendWezTermText(paneId, '\r')
}

function setWezTermWindowTitle(windowId, title) {
  try {
    weztermCli(['set-window-title', '--window-id', String(windowId), title], false)
  } catch (e) {
    process.stderr.write(`[launcher] set window title failed: ${e.message}\n`)
  }
}

function isWezTermGuiRunning() {
  try {
    const result = execFileSync('pgrep', ['-x', WEZTERM_PROCESS_NAME], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return result.length > 0
  } catch {
    return false
  }
}

function startWezTermGui() {
  const wezterm = resolveWezTermCommand()
  if (!wezterm) return
  spawn(wezterm, [
    '--config-file', resolveWezTermConfigPath(),
    'connect',
    'unix',
  ], {
    detached: true,
    env: weztermEnv(),
    stdio: 'ignore',
  }).unref()
  // Wait briefly for GUI to start
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
}

function ensureWezTermGuiRunning() {
  if (isWezTermGuiRunning()) return
  startWezTermGui()
}

function showWezTermWindow(paneId) {
  ensureWezTermGuiRunning()
  try {
    weztermCli(['activate-pane', '--pane-id', String(paneId)], false)
  } catch (e) {
    process.stderr.write(`[launcher] activate pane failed: ${e.message}\n`)
  }
  const target = findWezTermPaneById(paneId)
  if (target?.tabId != null) {
    try {
      weztermCli(['activate-tab', '--tab-id', String(target.tabId)], false)
    } catch (e) {
      process.stderr.write(`[launcher] activate tab failed: ${e.message}\n`)
    }
  }
  if (process.platform === 'darwin') {
    execFileSync(resolveCommand('swift') || 'swift', ['-e', `
import AppKit
if let app = NSWorkspace.shared.runningApplications.first(where: {
  let name = ($0.localizedName ?? "").lowercased()
  let path = ($0.executableURL?.path ?? "").lowercased()
  return name.contains("wezterm") || path.hasSuffix("/${WEZTERM_PROCESS_NAME}")
}) {
  app.unhide()
  app.activate(options: [])
}
`], { stdio: 'ignore' })
  }
}

function hideWezTermApp() {
  if (process.platform === 'darwin') {
    try {
      execFileSync(resolveCommand('swift') || 'swift', ['-e', `
import AppKit
if let app = NSWorkspace.shared.runningApplications.first(where: {
  let name = ($0.localizedName ?? "").lowercased()
  let path = ($0.executableURL?.path ?? "").lowercased()
  return name.contains("wezterm") || path.hasSuffix("/${WEZTERM_PROCESS_NAME}")
}) {
  app.hide()
}
`], { stdio: 'ignore' })
      return
    } catch { /* fall through to hard kill on failure */ }
  }

  try {
    execFileSync('pkill', ['-9', '-x', WEZTERM_PROCESS_NAME], { stdio: 'ignore' })
  } catch { /* no GUI running */ }
}

function syncWezTermState() {
  const state = readLauncherState()
  if (!state || state.terminalApp !== 'WezTerm' || state.weztermPaneId == null) return state
  const pane = findWezTermPaneById(state.weztermPaneId)
  if (!pane) {
    return writeLauncherState({
      connected: false,
      weztermPaneId: null,
      weztermTabId: null,
      weztermWindowId: null,
      terminalWindowId: null,
    })
  }
  if (state.weztermPaneId === pane.paneId && state.weztermWindowId === pane.windowId) return state
  return writeLauncherState({
    weztermPaneId: pane.paneId,
    weztermTabId: pane.tabId,
    weztermWindowId: pane.windowId,
    terminalWindowId: pane.windowId,
    weztermWorkspace: pane.workspace,
    connected: true,
  })
}

function runPowerShell(lines, inherit = false) {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', lines.join('; ')], {
    stdio: inherit ? 'inherit' : 'ignore',
  })
}

function hidePowerShellWindow(windowTitle) {
  runPowerShell([
    'Add-Type @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class Win32 {',
    '  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '}',
    '\'@',
    `$hwnd = [Win32]::FindWindow($null, '${windowTitle.replace(/'/g, "''")}')`,
    'if ($hwnd -eq [IntPtr]::Zero) { exit 1 }',
    '[Win32]::ShowWindowAsync($hwnd, 0) | Out-Null',
  ])
}

function killExistingWatcher() {
  const state = readLauncherState()
  if (state?.watcherPid) {
    try {
      process.kill(state.watcherPid, 0)
      process.kill(state.watcherPid)
    } catch {
      // expected: watcher process may have already exited
    }
  }
}

function spawnWezTermWarningWatcher(paneId, windowId, workspacePath) {
  killExistingWatcher()
  const child = spawn(process.execPath, [
    ...selfArgs(['__confirm-wezterm', String(paneId), String(windowId), workspacePath]),
  ], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE2BOT_LAUNCHER_CONFIRM_SEQUENCE: STARTUP_CONFIRM_SEQUENCE.join(','),
    },
  })
  child.unref()
  writeLauncherState({ watcherPid: child.pid })
}

function markWezTermReady(paneId, windowId, workspacePath) {
  const latestSession = workspacePath ? latestSessionForWorkspace(workspacePath) : null
  const displayMode = getConfiguredDisplayMode()
  writeLauncherState(wezTermStatePatch({ paneId, windowId, workspace: WEZTERM_WORKSPACE }, {
    runtimeMode: 'launcher',
    phase: 'ready',
    workspacePath,
    terminalApp: 'WezTerm',
    displayMode,
    connected: true,
    sessionId: latestSession?.sessionId,
    claudePid: latestSession?.pid,
  }))
  if (displayMode === 'view') {
    try { showWezTermWindow(paneId) } catch { /* best-effort: final show */ }
  } else {
    try { hideWezTermApp() } catch { /* best-effort: final hide */ }
  }
}

function waitForWezTermPane(workspacePath, paneId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const pane = Number.isFinite(paneId)
      ? findWezTermPaneById(paneId)
      : findWezTermPane(workspacePath)
    if (pane?.paneId != null) return pane
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  return null
}

function launchClaude(workspacePath, displayMode) {
  const claudeArgs = [
    '--dangerously-load-development-channels',
    `plugin:${PLUGIN_SPEC}`,
  ]
  const launchCwd = resolve(workspacePath)
  const wezterm = resolveWezTermCommand()
  if ((process.platform === 'darwin' || process.platform === 'win32') && wezterm) {
    cleanupManagedWezTermPane()
    const windowTitle = launcherWindowTitle(launchCwd)
    const command =
      process.platform === 'win32'
        ? [
            'powershell.exe',
            '-NoExit',
            '-Command',
            `$env:CLAUDE2BOT_LAUNCHER='1'; Set-Location -LiteralPath '${launchCwd.replace(/'/g, "''")}'; claude ${claudeArgs.join(' ')}`,
          ]
        : [
            'sh',
            '-lc',
            `cd ${shellQuote(launchCwd)}; export CLAUDE2BOT_LAUNCHER=1; claude ${claudeArgs.map(shellQuote).join(' ')}`,
          ]

    resetLauncherState({
      runtimeMode: 'launcher',
      phase: 'launching',
      workspacePath: launchCwd,
      terminalApp: 'WezTerm',
      launcherExecPath: LAUNCHER_EXEC_PATH,
      launcherEntryPath: LAUNCHER_ENTRY_PATH || undefined,
      displayMode,
      connected: false,
      windowTitle,
    })

    // Ensure WezTerm mux server is running, then clean default panes
    // so 'wezterm connect' only shows our Claude pane
    ensureWezTermMuxRunning(wezterm)
    cleanupDefaultMuxPanes()

    // Always use mux spawn — enables instant show/hide toggle without restart
    const spawnOut = weztermCli([
      'spawn',
      '--new-window',
      '--workspace', WEZTERM_WORKSPACE,
      '--cwd', launchCwd,
      '--',
      ...command,
    ]).trim()
    const paneId = Number(spawnOut)

    const pane = waitForWezTermPane(launchCwd, paneId)
    writeLauncherState(wezTermStatePatch(pane))

    if (pane?.windowId != null) {
      setWezTermWindowTitle(pane.windowId, windowTitle)
    }

    writeLauncherState({ phase: 'warning_confirm' })
    if (pane?.paneId != null) {
      const initialSignals = getLaunchSignals(getWezTermPaneText(pane.paneId))
      if (initialSignals.channelReady) {
        markWezTermReady(pane.paneId, pane.windowId ?? 0, launchCwd)
        ensureTrayAppRunningMac()
        return
      }
      spawnWezTermWarningWatcher(pane.paneId, pane.windowId ?? 0, launchCwd)
    }
    ensureTrayAppRunningMac()
    return
  }
  throw new Error('WezTerm backend is required and no supported WezTerm installation was found.')
}

// ── Sleep Cycle ─────────────────────────────────────────────────────

function cleanConversationText(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')              // code blocks
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, '')       // table rows
    .replace(/`([^`]+)`/g, '$1')                  // inline code → plain
    .replace(/\*\*/g, '')                         // bold
    .replace(/^#{1,4}\s+/gm, '')                  // headers
    .replace(/^>\s?/gm, '')                       // blockquotes
    .replace(/^[-*]\s+/gm, '')                    // bullet prefixes
    .replace(/https?:\/\/\S+/g, '')               // URLs
    .replace(/<channel[^>]*>\n?([\s\S]*?)\n?<\/channel>/g, '$1')  // channel tags
    .replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]/gu, '')     // emoji
    .replace(/[ \t]+/g, ' ')                      // collapse spaces
    .replace(/\n{2,}/g, '\n')                     // collapse blank lines
    .replace(/^\s+|\s+$/gm, '')                   // trim lines
    .trim()
}

function extractPingPong(transcriptPaths) {
  const paths = Array.isArray(transcriptPaths) ? transcriptPaths : [transcriptPaths]
  const results = []
  let lastKey = ''
  for (const tp of paths) {
    try {
      const lines = readFileSync(tp, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const d = JSON.parse(line)
          const role = d.message?.role
          if (!role || (role !== 'user' && role !== 'assistant')) continue
          const content = d.message?.content
          let text = ''
          if (typeof content === 'string') {
            text = content
          } else if (Array.isArray(content)) {
            text = content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n')
          }
          if (!text.trim()) continue
          if (text.includes('<system-reminder>') || text.includes('<schedule-context>')) continue
          if (text.includes('<teammate-message')) continue
          if (text.includes('[Request interrupted by user]')) continue
          text = cleanConversationText(text)
          if (!text) continue
          // dedup consecutive identical starts
          const key = text.slice(0, 50)
          if (key === lastKey) continue
          lastKey = key
          const prefix = role === 'user' ? 'u' : 'a'
          results.push(`${prefix}: ${text}`)
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }
  return results.join('\n')
}

function groupTranscriptsByDate(workspacePath, sinceTimestamp) {
  const projectKey = workspacePath.replace(/[\\/]/g, '-')
  const projectDir = join(homedir(), '.claude', 'projects', projectKey)
  const dateMap = {}
  try {
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .map(f => ({ path: join(projectDir, f), mtime: statSync(join(projectDir, f)).mtimeMs }))
      .filter(f => f.mtime >= sinceTimestamp)
    for (const f of files) {
      const date = new Date(f.mtime).toISOString().slice(0, 10)
      if (!dateMap[date]) dateMap[date] = []
      dateMap[date].push(f.path)
    }
  } catch {}
  return dateMap
}



function buildContextFile() {
  const memoryStore = getLauncherMemoryStore()
  memoryStore.syncHistoryFromFiles()
  return memoryStore.writeContextFile()
}

async function sleepCycle(workspacePath) {
  const ws = workspacePath || getConfiguredWorkspace()
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  const [year, month] = today.split('-')
  const weekNum = getWeekNumber(new Date())
  const weekKey = `${year}-W${String(weekNum).padStart(2, '0')}`

  // Read lastSleepAt from config
  const config = readLauncherConfig() ?? {}

  // First run detection: no history files → scan all transcripts for initial memory
  const isFirstRun = !config.lastSleepAt && !existsSync(join(HISTORY_DIR, 'lifetime.md'))
  const lastSleepAt = isFirstRun ? 0 : (config.lastSleepAt ?? (now - 24 * 60 * 60 * 1000))

  process.stderr.write(`[sleep-cycle] Starting.${isFirstRun ? ' (FIRST RUN — scanning all history)' : ''} Last sleep: ${lastSleepAt ? new Date(lastSleepAt).toISOString() : 'never'}\n`)
  getLauncherMemoryStore().backfillProject(ws, { limit: 120 })

  mkdirSync(join(HISTORY_DIR, 'daily'), { recursive: true })
  mkdirSync(join(HISTORY_DIR, 'weekly'), { recursive: true })
  mkdirSync(join(HISTORY_DIR, 'monthly'), { recursive: true })
  mkdirSync(join(HISTORY_DIR, 'yearly'), { recursive: true })

  // 1. Mark sleeping phase (prevents tray auto-launch during sleep)
  resetLauncherState({ phase: 'sleeping', connected: false })

  // 2. Stop current session
  stopLauncher()

  // 2. Collect transcripts grouped by date, generate missing dailies
  const MAX_DAYS = 7
  const sinceTs = isFirstRun ? (now - MAX_DAYS * 24 * 60 * 60 * 1000) : lastSleepAt
  const dateGroups = groupTranscriptsByDate(ws, sinceTs)
  const dailyDir = join(HISTORY_DIR, 'daily')
  const dates = Object.keys(dateGroups).sort()

  let generated = 0
  for (const date of dates) {
    if (generated >= MAX_DAYS) break
    const dailyFile = join(dailyDir, `${date}.md`)
    if (existsSync(dailyFile)) continue  // already exists, skip

    getLauncherMemoryStore().ingestTranscriptFiles(dateGroups[date])
    const pingpong = extractPingPong(dateGroups[date])
    if (!pingpong) continue

    runSleepPrompt(pingpong, { date, ws })
    generated++
    process.stderr.write(`[sleep-cycle] Daily ${date} generated. (${generated}/${dates.length})\n`)
  }

  if (generated === 0 && dates.length === 0) {
    process.stderr.write('[sleep-cycle] No transcripts since last sleep.\n')
  }

  await consolidateRecentCandidates(dates, ws, {
    maxDays: MAX_MEMORY_CONSOLIDATE_DAYS,
    maxCandidatesPerBatch: MAX_MEMORY_CANDIDATES_PER_DAY,
    maxBatches: MAX_MEMORY_CONSOLIDATE_BATCHES_PER_DAY,
  })

  // 3. Rollups: weekly/monthly/yearly (파일 없으면 생성, 최대 제한)
  // Weekly: 최대 4개 (1달치)
  const weeklyDir = join(HISTORY_DIR, 'weekly')
  const existingWeeklies = existsSync(weeklyDir) ? readdirSync(weeklyDir).filter(f => f.endsWith('.md')).length : 0
  if (existingWeeklies < 4) {
    const weeklyFile = join(weeklyDir, `${weekKey}.md`)
    if (!existsSync(weeklyFile)) {
      const content = collectDailiesForWeek(weekNum, year)
      if (content) runRollup('weekly', weekKey, content)
    }
  }

  // Monthly: 최대 12개 (1년치)
  const monthKey = `${year}-${month}`
  const monthlyDir = join(HISTORY_DIR, 'monthly')
  const existingMonthlies = existsSync(monthlyDir) ? readdirSync(monthlyDir).filter(f => f.endsWith('.md')).length : 0
  if (existingMonthlies < 12) {
    const monthlyFile = join(monthlyDir, `${monthKey}.md`)
    if (!existsSync(monthlyFile)) {
      const content = collectFilesForMonth(HISTORY_DIR, 'weekly', year, month)
      if (content) runRollup('monthly', monthKey, content)
    }
  }

  // Yearly: 최대 3개 (3년치)
  const yearlyDir = join(HISTORY_DIR, 'yearly')
  const existingYearlies = existsSync(yearlyDir) ? readdirSync(yearlyDir).filter(f => f.endsWith('.md')).length : 0
  if (existingYearlies < 3) {
    const yearlyFile = join(yearlyDir, `${year}.md`)
    if (!existsSync(yearlyFile)) {
      const content = collectFilesForYear(HISTORY_DIR, 'monthly', year)
      if (content) runRollup('yearly', year, content)
    }
  }

  // 4. Lifetime merge
  generateLifetimeMerge()

  // 5. Sync file-based memory artifacts into SQLite and rebuild context.md
  getLauncherMemoryStore().syncHistoryFromFiles()
  void refreshSleepEmbeddings(ws)
  buildContextFile()

  // 6. Save lastSleepAt
  const updatedConfig = readLauncherConfig()
  updatedConfig.lastSleepAt = now
  writeLauncherConfig(updatedConfig)

  // 7. Update + launch
  try { updatePlugin() } catch { /* best effort */ }
  const displayMode = getConfiguredDisplayMode()
  launchClaude(ws, displayMode)
  process.stderr.write('[sleep-cycle] New session launched.\n')
}

function runSleepPrompt(pingpong, { date, ws }) {
  const promptPath = join(resourceDir(), 'defaults', 'sleep-prompt.md')
  const template = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : 'Summarize the conversation below.'
  const prompt = template
    .replace('{{DATE}}', date)
    .replace('{{HISTORY_DIR}}', HISTORY_DIR)
  const fullInput = prompt + '\n\n---\n\n' + pingpong
  try {
    const { status } = spawnClaudeMemoryPrompt(fullInput, { cwd: ws, timeout: 600000 })
    if (status !== 0) throw new Error(`exit code ${status}`)
    normalizeSleepArtifactsToEnglish(date, ws)
  } catch (e) {
    process.stderr.write(`[sleep-cycle] claude -p failed for ${date}: ${e.message}\n`)
  }
}

function runRollup(level, key, content) {
  const outFile = join(HISTORY_DIR, level, `${key}.md`)
  try {
    const summary = execClaudeMemoryPrompt(
      `Compress these summaries into a concise ${level} summary. Write in English except proper nouns. Avoid Hangul unless it is part of an exact proper noun or identifier. Output only the summary:\n\n${content}`,
      { timeout: 120000 },
    )
    const normalizedSummary = normalizeTextToEnglish(summary, process.cwd(), {
      label: `${level} summary`,
      timeout: 120000,
    })
    writeFileSync(outFile, `# ${key}\n\n${normalizedSummary}\n`)
    process.stderr.write(`[sleep-cycle] ${level} ${key} generated.\n`)
  } catch (e) {
    process.stderr.write(`[sleep-cycle] ${level} rollup failed: ${e.message}\n`)
  }
}

function extractJsonObject(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

function containsHangul(text) {
  return /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(String(text ?? ''))
}

function jsonPayloadContainsHangul(value) {
  if (typeof value === 'string') return containsHangul(value)
  if (Array.isArray(value)) return value.some(item => jsonPayloadContainsHangul(item))
  if (value && typeof value === 'object') {
    return Object.values(value).some(item => jsonPayloadContainsHangul(item))
  }
  return false
}

function normalizeTextToEnglish(text, ws, options = {}) {
  const raw = String(text ?? '').trim()
  if (!raw || !containsHangul(raw)) return raw
  const label = String(options.label ?? 'memory artifact').trim() || 'memory artifact'
  const format = options.format === 'json' ? 'JSON' : 'Markdown'
  const prompt = [
    `Rewrite this ${label} into concise English.`,
    'Rules:',
    `- Return ${format} only.`,
    '- Translate natural-language content to English.',
    '- Preserve proper nouns, product names, file paths, URLs, emails, IDs, numbers, code symbols, and identifiers as-is.',
    '- Do not add explanations, wrappers, or commentary.',
    '- Avoid Hangul unless it is part of an exact identifier or proper noun that must stay unchanged.',
    '',
    raw,
  ].join('\n')
  return execClaudeMemoryPrompt(prompt, {
    cwd: ws,
    timeout: Number(options.timeout ?? 120000),
  }).trim()
}

function normalizeJsonPayloadToEnglish(payload, ws, options = {}) {
  if (!payload || typeof payload !== 'object' || !jsonPayloadContainsHangul(payload)) return payload
  const label = String(options.label ?? 'memory payload').trim() || 'memory payload'
  const serialized = JSON.stringify(payload, null, 2)
  const prompt = [
    `Rewrite every natural-language string value in this ${label} JSON object into concise English.`,
    'Rules:',
    '- Return JSON only.',
    '- Preserve the exact JSON shape, keys, arrays, nulls, booleans, and numbers.',
    '- Preserve proper nouns, product names, file paths, URLs, emails, IDs, numbers, code symbols, and identifiers as-is.',
    '- If a string is already concise English, keep it unchanged.',
    '- Avoid Hangul unless it is part of an exact identifier or proper noun that must stay unchanged.',
    '',
    serialized,
  ].join('\n')

  try {
    const rewritten = extractJsonObject(execClaudeMemoryPrompt(prompt, {
      cwd: ws,
      timeout: Number(options.timeout ?? 120000),
    }))
    return rewritten && typeof rewritten === 'object' ? rewritten : payload
  } catch {
    return payload
  }
}

function normalizeSleepArtifactsToEnglish(date, ws) {
  const targets = [
    { path: join(HISTORY_DIR, 'daily', `${date}.md`), format: 'markdown', label: `daily summary for ${date}` },
    { path: join(HISTORY_DIR, 'lifetime.md'), format: 'markdown', label: 'lifetime summary' },
    { path: join(HISTORY_DIR, 'identity.md'), format: 'markdown', label: 'identity profile' },
    { path: join(HISTORY_DIR, 'ongoing.md'), format: 'markdown', label: 'ongoing tasks' },
    { path: join(HISTORY_DIR, 'interests.json'), format: 'json', label: 'interest keywords' },
  ]

  for (const target of targets) {
    if (!existsSync(target.path)) continue
    try {
      const content = readFileSync(target.path, 'utf8').trim()
      if (!content || !containsHangul(content)) continue
      const normalized =
        target.format === 'json'
          ? JSON.stringify(
              normalizeJsonPayloadToEnglish(JSON.parse(content), ws, {
                label: target.label,
                timeout: 180000,
              }),
              null,
              2,
            )
          : normalizeTextToEnglish(content, ws, {
              label: target.label,
              timeout: 180000,
            })
      if (normalized && normalized.trim()) {
        writeFileSync(target.path, normalized.trim() + '\n')
      }
    } catch (e) {
      process.stderr.write(`[sleep-cycle] english normalize failed for ${target.path}: ${e.message}\n`)
    }
  }
}

function normalizeCandidateFingerprint(text) {
  return cleanMemoryText(text).toLowerCase().replace(/\s+/g, ' ').trim()
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))))
  return sorted[index]
}

async function buildSemanticDayPlan(dayEpisodes, options = {}) {
  const maxEmbedChars = Math.max(120, Number(options.maxEmbedChars ?? 320))
  const minSimilarityFloor = Number(options.minSimilarityFloor ?? 0.42)
  const semanticPercentile = Number(options.semanticPercentile ?? 35)
  const rows = dayEpisodes
    .map((episode, index) => ({
      index,
      id: episode.id,
      role: episode.role,
      content: cleanMemoryText(episode.content ?? ''),
    }))
    .filter(row => row.content)

  if (rows.length <= 1) {
    return { rows, segments: rows.length ? [{ start: 0, end: rows.length - 1 }] : [], threshold: 1 }
  }

  const vectors = await Promise.all(
    rows.map(row => embedText(String(row.content).slice(0, maxEmbedChars))),
  )
  const similarities = []
  for (let i = 0; i < vectors.length - 1; i += 1) {
    similarities.push(cosineSimilarity(vectors[i], vectors[i + 1]))
  }
  const threshold = Math.max(minSimilarityFloor, percentile(similarities, semanticPercentile))

  const segments = []
  let start = 0
  for (let i = 0; i < similarities.length; i += 1) {
    if (similarities[i] < threshold) {
      segments.push({ start, end: i })
      start = i + 1
    }
  }
  segments.push({ start, end: rows.length - 1 })

  return { rows, segments, threshold }
}

function buildCandidateSpan(dayEpisodes, episodeId, semanticPlan, options = {}) {
  const overlapTurns = Math.max(0, Number(options.overlapTurns ?? 1))
  const maxTurns = Math.max(1, Number(options.maxTurns ?? 6))
  const targetIndex = dayEpisodes.findIndex(item => Number(item.id) === Number(episodeId))
  if (targetIndex < 0) return ''

  let start = Math.max(0, targetIndex - 1)
  let end = Math.min(dayEpisodes.length - 1, targetIndex + 2)

  if (semanticPlan?.rows?.length) {
    const semanticIndex = semanticPlan.rows.findIndex(item => Number(item.id) === Number(episodeId))
    if (semanticIndex >= 0) {
      const segment = semanticPlan.segments.find(item => semanticIndex >= item.start && semanticIndex <= item.end)
      if (segment) {
        const startRow = semanticPlan.rows[Math.max(0, segment.start - overlapTurns)]
        const endRow = semanticPlan.rows[Math.min(semanticPlan.rows.length - 1, segment.end + overlapTurns)]
        if (startRow && endRow) {
          const startIndex = dayEpisodes.findIndex(item => Number(item.id) === Number(startRow.id))
          const endIndex = dayEpisodes.findIndex(item => Number(item.id) === Number(endRow.id))
          if (startIndex >= 0) start = startIndex
          if (endIndex >= 0) end = endIndex
        }
      }
    }
  }

  const rows = []
  for (let i = start; i <= end; i += 1) {
    const row = dayEpisodes[i]
    const cleaned = cleanMemoryText(row?.content ?? '')
    if (!cleaned) continue
    rows.push({
      marker: i === targetIndex ? '*' : '-',
      role: row.role === 'user' ? 'user' : 'assistant',
      content: cleaned,
    })
  }

  if (rows.length === 0) return ''
  return rows
    .slice(0, maxTurns)
    .map(row => `${row.marker} ${row.role}: ${row.content}`)
    .join('\n')
}

async function prepareConsolidationCandidates(candidates, maxCandidatesPerBatch, dayEpisodes = []) {
  const seen = new Set()
  const prepared = []
  const semanticPlan = await buildSemanticDayPlan(dayEpisodes, {
    maxEmbedChars: 320,
    semanticPercentile: 35,
    minSimilarityFloor: 0.42,
  })
  for (const item of candidates) {
    const cleaned = cleanMemoryText(item?.content ?? '')
    if (!cleaned) continue
    const fingerprint = normalizeCandidateFingerprint(cleaned)
    if (!fingerprint || seen.has(fingerprint)) continue
    seen.add(fingerprint)
    const spanContent = buildCandidateSpan(dayEpisodes, item?.episode_id, semanticPlan, { overlapTurns: 1, maxTurns: 6 })
    prepared.push({
      ...item,
      content: cleaned,
      span_content: spanContent || cleaned,
    })
    if (prepared.length >= maxCandidatesPerBatch) break
  }
  return prepared
}

function contextualizeMemoryItems(ws, options = {}) {
  const store = getLauncherMemoryStore()
  const perTypeLimit = Math.max(8, Math.floor(Number(options.maxItems ?? MAX_MEMORY_CONTEXTUALIZE_ITEMS) / 2))
  const items = store.getEmbeddableItems({ perTypeLimit }).slice(0, Number(options.maxItems ?? MAX_MEMORY_CONTEXTUALIZE_ITEMS))
  if (items.length === 0) return new Map()

  const promptPath = join(resourceDir(), 'defaults', 'memory-contextualize-prompt.md')
  const template = existsSync(promptPath)
    ? readFileSync(promptPath, 'utf8')
    : 'Output JSON only with contextual retrieval notes.'

  const itemsText = items
    .map((item, index) => [
      `#${index + 1}`,
      `key=${item.key}`,
      `type=${item.entityType}`,
      item.subtype ? `subtype=${item.subtype}` : '',
      item.ref ? `ref=${item.ref}` : '',
      item.slot ? `slot=${item.slot}` : '',
      item.status ? `status=${item.status}` : '',
      item.priority ? `priority=${item.priority}` : '',
      `content=${item.content}`,
    ].filter(Boolean).join('\n'))
    .join('\n\n')

  const prompt = template.replace('{{ITEMS}}', itemsText)
  try {
    const raw = execClaudeMemoryPrompt(prompt, {
      cwd: ws,
      timeout: 180000,
    })
    const parsed = normalizeJsonPayloadToEnglish(extractJsonObject(raw), ws, {
      label: 'memory contextualization payload',
      timeout: 120000,
    })
    const contextMap = new Map()
    for (const row of parsed?.items ?? []) {
      const key = String(row?.key ?? '').trim()
      const context = String(row?.context ?? '').trim()
      if (!key || !context) continue
      contextMap.set(key, context)
    }
    process.stderr.write(`[memory] contextualized items=${contextMap.size}\n`)
    return contextMap
  } catch (e) {
    process.stderr.write(`[memory] contextualize failed: ${e.message}\n`)
    return new Map()
  }
}

async function refreshSleepEmbeddings(ws) {
  const store = getLauncherMemoryStore()
  const contextMap = contextualizeMemoryItems(ws, { maxItems: MAX_MEMORY_CONTEXTUALIZE_ITEMS })
  const updated = await store.ensureEmbeddings({
    perTypeLimit: Math.max(16, Math.floor(MAX_MEMORY_CONTEXTUALIZE_ITEMS / 2)),
    contextMap,
  })
  process.stderr.write(`[memory] embeddings refreshed: ${updated}\n`)
}

async function rebuildAllMemory(workspacePath) {
  const ws = workspacePath || getConfiguredWorkspace()
  if (!ws || !workspaceExists(ws)) {
    throw new Error(`Workspace does not exist: ${ws || '(not configured)'}`)
  }

  const store = getLauncherMemoryStore()
  store.backfillProject(ws, { limit: 400 })
  store.syncHistoryFromFiles()
  store.resetConsolidatedMemory()

  const dayKeys = store.getPendingCandidateDays(10000, 1)
    .map(item => item.day_key)
    .sort()

  if (dayKeys.length === 0) {
    await refreshSleepEmbeddings(ws)
    buildContextFile()
    process.stdout.write('[memory-rebuild] no candidate days found.\n')
    return
  }

  for (const dayKey of dayKeys) {
    await consolidateCandidateDay(dayKey, ws, {
      maxCandidatesPerBatch: MAX_MEMORY_CANDIDATES_PER_DAY,
      maxBatches: 999,
    })
  }

  store.syncHistoryFromFiles()
  await refreshSleepEmbeddings(ws)
  buildContextFile()
  process.stdout.write(`[memory-rebuild] rebuilt ${dayKeys.length} day(s).\n`)
}

async function rebuildRecentMemory(workspacePath, options = {}) {
  const ws = workspacePath || getConfiguredWorkspace()
  if (!ws || !workspaceExists(ws)) {
    throw new Error(`Workspace does not exist: ${ws || '(not configured)'}`)
  }

  const store = getLauncherMemoryStore()
  store.backfillProject(ws, { limit: 240 })
  store.syncHistoryFromFiles()

  const maxDays = Math.max(1, Number(options.maxDays ?? 2))
  const maxCandidatesPerBatch = Math.max(1, Number(options.maxCandidatesPerBatch ?? MAX_MEMORY_CANDIDATES_PER_DAY))
  const maxBatches = Math.max(1, Number(options.maxBatches ?? MAX_MEMORY_CONSOLIDATE_BATCHES_PER_DAY))

  const dayKeys = store.getRecentCandidateDays(maxDays)
    .map(item => item.day_key)
    .sort()

  if (dayKeys.length === 0) {
    process.stdout.write('[memory-rebuild-recent] no candidate days found.\n')
    return
  }

  store.resetConsolidatedMemoryForDays(dayKeys)

  for (const dayKey of dayKeys) {
    await consolidateCandidateDay(dayKey, ws, {
      maxCandidatesPerBatch,
      maxBatches,
    })
  }

  store.syncHistoryFromFiles()
  await refreshSleepEmbeddings(ws)
  buildContextFile()
  process.stdout.write(`[memory-rebuild-recent] rebuilt ${dayKeys.length} day(s): ${dayKeys.join(', ')}\n`)
}

async function pruneMemoryToRecent(workspacePath, options = {}) {
  const ws = workspacePath || getConfiguredWorkspace()
  if (!ws || !workspaceExists(ws)) {
    throw new Error(`Workspace does not exist: ${ws || '(not configured)'}`)
  }

  const store = getLauncherMemoryStore()
  store.backfillProject(ws, { limit: 240 })
  store.syncHistoryFromFiles()

  const maxDays = Math.max(1, Number(options.maxDays ?? 5))
  const dayKeys = store.getRecentCandidateDays(maxDays)
    .map(item => item.day_key)
    .sort()

  if (dayKeys.length === 0) {
    process.stdout.write('[memory-prune-recent] no candidate days found.\n')
    return
  }

  store.pruneConsolidatedMemoryOutsideDays(dayKeys)
  await refreshSleepEmbeddings(ws)
  buildContextFile()
  process.stdout.write(`[memory-prune-recent] kept only recent day(s): ${dayKeys.join(', ')}\n`)
}

async function consolidateCandidateDay(dayKey, ws, options = {}) {
  const store = getLauncherMemoryStore()
  const maxCandidatesPerBatch = Math.max(1, Number(options.maxCandidatesPerBatch ?? MAX_MEMORY_CANDIDATES_PER_DAY))
  const maxBatches = Math.max(1, Number(options.maxBatches ?? MAX_MEMORY_CONSOLIDATE_BATCHES_PER_DAY))
  let processed = 0
  let mergedFacts = 0
  let mergedTasks = 0
  let mergedSignals = 0

  const promptPath = join(resourceDir(), 'defaults', 'memory-consolidate-prompt.md')
  const template = existsSync(promptPath)
    ? readFileSync(promptPath, 'utf8')
    : 'Output JSON only with facts/tasks/signals.'
  const dayEpisodes = store.getEpisodesForDate(dayKey)

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const candidates = await prepareConsolidationCandidates(
      store.getCandidatesForDate(dayKey),
      maxCandidatesPerBatch,
      dayEpisodes,
    )
    if (candidates.length === 0) break

    const candidateText = candidates
      .map((item, index) => {
        const primary = String(item.content).slice(0, 300)
        const span = String(item.span_content || item.content).slice(0, 800)
        return `#${index + 1} [${item.role}] score=${item.score}\nCandidate:\n${primary}\nContext:\n${span}`
      })
      .join('\n\n')

    const prompt = template
      .replace('{{DATE}}', dayKey)
      .replace('{{CANDIDATES}}', candidateText)

    try {
      const raw = execClaudeMemoryPrompt(prompt, {
        cwd: ws,
        timeout: 180000,
      })
      const parsed = normalizeJsonPayloadToEnglish(extractJsonObject(raw), ws, {
        label: `memory consolidation payload for ${dayKey}`,
        timeout: 120000,
      })
      if (!parsed) {
        process.stderr.write(`[memory] consolidate ${dayKey}: invalid JSON\n`)
        break
      }

      const sourceEpisodeId = candidates[0]?.episode_id ?? null
      store.upsertProfiles(parsed.profiles ?? [], `${dayKey}T23:59:59.000Z`, sourceEpisodeId)
      await store.upsertFacts(parsed.facts ?? [], `${dayKey}T23:59:59.000Z`, sourceEpisodeId)
      store.upsertTasks(parsed.tasks ?? [], `${dayKey}T23:59:59.000Z`, sourceEpisodeId)
      store.upsertSignals(parsed.signals ?? [], sourceEpisodeId, `${dayKey}T23:59:59.000Z`)
      store.upsertEntities(parsed.entities ?? [], `${dayKey}T23:59:59.000Z`, sourceEpisodeId)
      store.upsertRelations(parsed.relations ?? [], `${dayKey}T23:59:59.000Z`, sourceEpisodeId)
      store.markCandidateIdsConsolidated(candidates.map(item => item.id))
      processed += candidates.length
      mergedFacts += (parsed.facts ?? []).length
      mergedTasks += (parsed.tasks ?? []).length
      mergedSignals += (parsed.signals ?? []).length
    } catch (e) {
      process.stderr.write(`[memory] consolidate ${dayKey} failed: ${e.message}\n`)
      break
    }
  }

  if (processed > 0) {
    process.stderr.write(`[memory] consolidated ${dayKey}: candidates=${processed}, facts=${mergedFacts}, tasks=${mergedTasks}, signals=${mergedSignals}\n`)
  }
}

async function consolidateRecentCandidates(dayKeys, ws, options = {}) {
  const targets = [...dayKeys]
    .sort()
    .reverse()
    .slice(0, Math.max(1, Number(options.maxDays ?? MAX_MEMORY_CONSOLIDATE_DAYS)))
    .sort()
  for (const dayKey of targets) {
    await consolidateCandidateDay(dayKey, ws, options)
  }
}

async function memoryFlush(workspacePath, options = {}) {
  const ws = workspacePath || getConfiguredWorkspace()
  if (!ws || !workspaceExists(ws)) {
    throw new Error(`Workspace does not exist: ${ws || '(not configured)'}`)
  }

  const store = getLauncherMemoryStore()
  const maxDays = Math.max(1, Number(options.maxDays ?? MEMORY_FLUSH_DEFAULT_MAX_DAYS))
  const maxCandidatesPerBatch = Math.max(1, Number(options.maxCandidatesPerBatch ?? MEMORY_FLUSH_DEFAULT_MAX_CANDIDATES))
  const maxBatches = Math.max(1, Number(options.maxBatches ?? MEMORY_FLUSH_DEFAULT_MAX_BATCHES))
  const minPending = Math.max(1, Number(options.minPending ?? MEMORY_FLUSH_DEFAULT_MIN_PENDING))
  const pendingDays = store.getPendingCandidateDays(Math.max(maxDays * 3, maxDays), minPending)

  if (pendingDays.length === 0) {
    process.stdout.write('[memory-flush] no flushable candidate batches.\n')
    return
  }

  const targets = pendingDays
    .map(item => item.day_key)
    .slice(0, maxDays)
    .reverse()

  await consolidateRecentCandidates(targets, ws, {
    maxDays,
    maxCandidatesPerBatch,
    maxBatches,
  })
  store.syncHistoryFromFiles()
  store.writeContextFile()
}

function collectDailiesForWeek(weekNum, year) {
  const dailyDir = join(HISTORY_DIR, 'daily')
  if (!existsSync(dailyDir)) return null
  const files = readdirSync(dailyDir).filter(f => {
    if (!f.endsWith('.md')) return false
    const d = new Date(f.replace('.md', ''))
    return d.getFullYear() === Number(year) && getWeekNumber(d) === weekNum
  }).sort()
  if (files.length === 0) return null
  return files.map(f => readFileSync(join(dailyDir, f), 'utf8').trim()).join('\n\n')
}

function collectFilesForMonth(histDir, subdir, year, month) {
  const dir = join(histDir, subdir)
  if (!existsSync(dir)) return null
  const prefix = `${year}-`
  const files = readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.md')).sort()
  // Filter by month context (weekly files that fall in the month)
  const relevant = subdir === 'weekly'
    ? files.filter(f => isWeekInMonth(f.replace('.md', ''), year, month))
    : files.filter(f => f.startsWith(`${year}-${month}`))
  if (relevant.length === 0) return null
  return relevant.map(f => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n')
}

function collectFilesForYear(histDir, subdir, year) {
  const dir = join(histDir, subdir)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter(f => f.startsWith(`${year}-`) && f.endsWith('.md')).sort()
  if (files.length === 0) return null
  return files.map(f => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n')
}

function isWeekInMonth(weekKey, year, month) {
  // Check if a week (e.g., "2026-W13") falls within the given month
  const match = weekKey.match(/^(\d{4})-W(\d{2})$/)
  if (!match) return false
  const d = new Date(Number(match[1]), 0, 1 + (Number(match[2]) - 1) * 7)
  return d.getFullYear() === Number(year) && String(d.getMonth() + 1).padStart(2, '0') === month
}

function generateLifetimeMerge() {
  // Yearly 주기로 lifetime 갱신: yearly들 + 기존 lifetime → 압축
  const yearlyDir = join(HISTORY_DIR, 'yearly')
  const lifetimePath = join(HISTORY_DIR, 'lifetime.md')
  const existingLifetime = existsSync(lifetimePath) ? readFileSync(lifetimePath, 'utf8') : ''

  if (!existsSync(yearlyDir)) return
  const yearlyFiles = readdirSync(yearlyDir).filter(f => f.endsWith('.md')).sort()
  if (yearlyFiles.length === 0 && !existingLifetime) return

  const yearlyContent = yearlyFiles.map(f => readFileSync(join(yearlyDir, f), 'utf8').trim()).join('\n\n')
  const mergeInput = [existingLifetime, yearlyContent].filter(Boolean).join('\n\n---\n\n')

  if (!mergeInput.trim()) return
  try {
    const merged = execClaudeMemoryPrompt(
      `Merge and compress this into a single lifetime summary. Remove duplicates, keep only the most important history and patterns. Write in English except proper nouns. Avoid Hangul unless it is part of an exact proper noun or identifier. Output only the summary:\n\n${mergeInput}`,
      { timeout: 120000 },
    )
    const normalizedMerged = normalizeTextToEnglish(merged, process.cwd(), {
      label: 'lifetime summary',
      timeout: 120000,
    })
    writeFileSync(lifetimePath, normalizedMerged + '\n')
    process.stderr.write('[sleep-cycle] lifetime.md updated.\n')
  } catch (e) {
    process.stderr.write(`[sleep-cycle] lifetime merge failed: ${e.message}\n`)
  }
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
}

async function summarizeOnly(workspacePath) {
  const ws = workspacePath || getConfiguredWorkspace()
  const now = Date.now()
  const config = readLauncherConfig() ?? {}
  const lastSleepAt = config.lastSleepAt ?? (now - 24 * 60 * 60 * 1000)

  process.stderr.write(`[summarize] Starting for workspace: ${ws}\n`)
  getLauncherMemoryStore().backfillProject(ws, { limit: 120 })

  mkdirSync(join(HISTORY_DIR, 'daily'), { recursive: true })

  const MAX_DAYS = 7
  const sinceTs = now - MAX_DAYS * 24 * 60 * 60 * 1000
  const dateGroups = groupTranscriptsByDate(ws, Math.max(sinceTs, lastSleepAt))
  const dailyDir = join(HISTORY_DIR, 'daily')
  const dates = Object.keys(dateGroups).sort()

  let generated = 0
  for (const date of dates) {
    const dailyFile = join(dailyDir, `${date}.md`)
    if (existsSync(dailyFile)) continue
    getLauncherMemoryStore().ingestTranscriptFiles(dateGroups[date])
    const pingpong = extractPingPong(dateGroups[date])
    if (!pingpong) continue
    runSleepPrompt(pingpong, { date, ws })
    generated++
    process.stderr.write(`[summarize] Daily ${date} generated.\n`)
  }

  if (generated === 0) {
    process.stderr.write('[summarize] No new dailies to generate.\n')
  }

  await consolidateRecentCandidates(dates, ws, {
    maxDays: MAX_MEMORY_CONSOLIDATE_DAYS,
    maxCandidatesPerBatch: MAX_MEMORY_CANDIDATES_PER_DAY,
    maxBatches: MAX_MEMORY_CONSOLIDATE_BATCHES_PER_DAY,
  })
  getLauncherMemoryStore().syncHistoryFromFiles()
  void refreshSleepEmbeddings(ws)
  buildContextFile()
  process.stderr.write('[summarize] context.md updated.\n')
}

function stopLauncher() {
  const state = readLauncherState()

  // 0. Kill ALL orphan claude --channels processes (ensure single instance)
  try {
    execFileSync('pkill', ['-f', `claude.*${PLUGIN_SPEC}`], { stdio: 'ignore' })
  } catch { /* none running */ }

  // 1. Kill watcher process
  if (state?.watcherPid) {
    try { process.kill(state.watcherPid) } catch { /* already gone */ }
  }

  // 2. Kill Claude pane in mux
  if (state?.weztermPaneId != null) {
    try { weztermCli(['kill-pane', '--pane-id', String(state.weztermPaneId)]) } catch { /* already gone */ }
  }

  // 3. Kill WezTerm GUI
  hideWezTermApp()

  // 4. Kill mux server
  const pidFile = join(WEZTERM_DATA_HOME, 'pid')
  try {
    const muxPid = Number(readFileSync(pidFile, 'utf8').trim())
    if (muxPid) process.kill(muxPid)
  } catch { /* no mux running */ }

  // 5. Reset state (preserve "sleeping" phase if set)
  const currentPhase = readLauncherState()?.phase
  resetLauncherState({ phase: currentPhase === 'sleeping' ? 'sleeping' : 'stopped', connected: false })
  process.stdout.write('Launcher stopped.\n')
}

function doctor(scope, workspacePath) {
  const displayMode = getConfiguredDisplayMode()
  const lines = []
  lines.push(`Platform: ${process.platform}`)
  lines.push(`Claude CLI: ${hasCommand('claude') ? 'yes' : 'no'}`)
  lines.push(`WezTerm: ${resolveWezTermCommand() ? 'yes' : 'no'}`)
  lines.push(`Node.js: ${process.version}`)
  lines.push(`Install scope: ${scope}`)
  lines.push(`Workspace: ${workspacePath || '(not configured)'}`)
  lines.push(`Workspace exists: ${workspaceExists(workspacePath) ? 'yes' : 'no'}`)
  lines.push(`Display mode: ${displayMode}`)
  const state = syncWezTermState()
  const weztermConnected = Boolean(
    state?.terminalApp === 'WezTerm' &&
    state?.weztermPaneId != null &&
    listWezTermPanes().some(item => item.paneId === state.weztermPaneId),
  )
  lines.push(`Launcher state file: ${existsSync(STATE_PATH) ? 'yes' : 'no'}`)
  if (state?.terminalApp) lines.push(`Launcher terminal: ${state.terminalApp}`)
  if (state?.terminalWindowId != null) lines.push(`Launcher window: ${state.terminalWindowId}`)
  if (state?.weztermPaneId != null) lines.push(`Launcher pane: ${state.weztermPaneId}`)
  if (state?.launcherExecPath) lines.push(`Launcher exec: ${state.launcherExecPath}`)
  if (state?.launcherEntryPath) lines.push(`Launcher entry: ${state.launcherEntryPath}`)
  if (state?.phase) lines.push(`Launcher phase: ${state.phase}`)
  lines.push(`Launcher connected: ${(weztermConnected || state?.connected) ? 'yes' : 'no'}`)
  if (hasCommand('claude')) {
    try {
      const marketplaces = marketplaceList()
      lines.push(`Marketplace installed: ${marketplaces.includes(`❯ ${MARKETPLACE_NAME}`) ? 'yes' : 'no'}`)
    } catch {
      lines.push('Marketplace installed: unknown')
    }
    try {
      const plugins = pluginList()
      const block = getPluginBlock(plugins)
      lines.push(`Plugin installed: ${block ? 'yes' : 'no'}`)
      lines.push(`Plugin enabled: ${block ? (block.includes('Status: ✘ disabled') ? 'no' : 'yes') : 'unknown'}`)
    } catch {
      lines.push('Plugin installed: unknown')
    }
  }
  process.stdout.write(lines.join('\n') + '\n')
}

function showWorkspace(workspacePath) {
  process.stdout.write(`${workspacePath || '(not configured)'}\n`)
}

function showDisplayMode(displayMode) {
  process.stdout.write(`${normalizeDisplayMode(displayMode)}\n`)
}

function showLauncherWindow() {
  const state = syncWezTermState()
  if (!state?.connected || state.terminalApp !== 'WezTerm' || state.weztermPaneId == null) {
    throw new Error('No launcher-managed WezTerm session is currently connected.')
  }

  if (process.platform === 'darwin' || process.platform === 'win32') {
    showWezTermWindow(state.weztermPaneId)
    return
  }

  throw new Error('Show is only implemented for the WezTerm backend.')
}

function hideLauncherWindow() {
  const state = syncWezTermState()
  if (!state?.connected || state.terminalApp !== 'WezTerm') {
    throw new Error('No launcher-managed session is currently connected.')
  }

  if (process.platform === 'darwin') {
    hideWezTermApp()
    return
  }

  if (process.platform === 'win32' && state.windowTitle) {
    hidePowerShellWindow(state.windowTitle)
    return
  }

  throw new Error('Hide is only implemented for the WezTerm backend.')
}

async function restartLauncherWindow(scope, cliWorkspace) {
  const state = syncWezTermState()
  const workspacePath = cliWorkspace ? resolve(cliWorkspace) : (state.workspacePath || getConfiguredWorkspace())
  const displayMode = getConfiguredDisplayMode()

  if (!workspacePath || !workspaceExists(workspacePath)) {
    throw new Error(`Workspace does not exist: ${workspacePath || '(not configured)'}`)
  }

  if (state?.terminalApp === 'WezTerm' && state?.weztermPaneId != null) {
    try {
      weztermCli(['kill-pane', '--pane-id', String(state.weztermPaneId)])
    } catch {
      // expected: pane may have already been closed
    }
    await sleep(300)
  }

  installPlugin(scope)
  resetLauncherState({
    runtimeMode: 'launcher',
    phase: 'launching',
    workspacePath,
    terminalApp: 'WezTerm',
    displayMode,
    connected: false,
    launcherExecPath: LAUNCHER_EXEC_PATH,
    launcherEntryPath: LAUNCHER_ENTRY_PATH || undefined,
  })
  launchClaude(workspacePath, displayMode)
}

async function main() {
  const firstArg = USER_ARGS[0]
  const command = firstArg && !firstArg.startsWith('-') ? firstArg : 'launch'
  const scope = getOption('--scope', DEFAULT_SCOPE)
  const cliWorkspace = getOption('--workspace', '')
  const cliDisplayMode = getOption('--display', '')
  const cliMaxDays = getIntegerOption('--max-days', MEMORY_FLUSH_DEFAULT_MAX_DAYS)
  const cliMaxCandidates = getIntegerOption('--max-candidates', MEMORY_FLUSH_DEFAULT_MAX_CANDIDATES)
  const cliMaxBatches = getIntegerOption('--max-batches', MEMORY_FLUSH_DEFAULT_MAX_BATCHES)
  const cliMinPending = getIntegerOption('--min-pending', MEMORY_FLUSH_DEFAULT_MIN_PENDING)

  if (command === '--help' || command === '-h' || USER_ARGS.includes('--help') || USER_ARGS.includes('-h')) {
    printHelp()
    return
  }

  if (INTERNAL_COMMANDS.has(command)) {
    switch (command) {
      case '__confirm-wezterm': {
        const paneId = Number(USER_ARGS[1])
        const windowId = Number(USER_ARGS[2])
        const workspacePath = USER_ARGS[3] ? resolve(USER_ARGS[3]) : ''
        let handled = 0
        let sawChannelReady = false

        for (let attempt = 0; attempt < 120; attempt += 1) {
          try { hideWezTermApp() } catch { /* best-effort: watcher loop hide */ }
          const content = getWezTermPaneText(paneId)
          if (!content) {
            await sleep(500)
            continue
          }

          const signals = getLaunchSignals(content)

          if (signals.needsConfirmation && handled < STARTUP_CONFIRM_SEQUENCE.length) {
            writeLauncherState({ phase: 'warning_confirm' })
            await sendWezTermChoice(paneId, STARTUP_CONFIRM_SEQUENCE[handled] ?? '1')
            try { hideWezTermApp() } catch { /* best-effort: watcher loop hide */ }
            handled += 1
            await sleep(1200)
            continue
          }

          if (signals.channelReady) {
            sawChannelReady = true
          }

          if (sawChannelReady) {
            markWezTermReady(paneId, windowId, workspacePath)
            return
          }

          if (signals.channelReady || signals.connecting) {
            writeLauncherState({ phase: 'connecting' })
          }
          await sleep(500)
        }

        writeLauncherState({ phase: 'error', connected: false })
        return
      }
      default:
        return
    }
  }

  if (!hasCommand('claude')) {
    throw new Error('Claude CLI not found in PATH. Install Claude Code first.')
  }

  switch (command) {
    case 'install':
      ensureWezTermInstalled()
      installPlugin(scope)
      break
    case 'update':
      updatePlugin()
      break
    case 'launch': {
      await restartLauncherWindow(scope, cliWorkspace)
      break
    }
    case 'show':
      showLauncherWindow()
      break
    case 'hide':
      hideLauncherWindow()
      break
    case 'restart':
      await restartLauncherWindow(scope, cliWorkspace)
      break
    case 'stop':
      stopLauncher()
      break
    case 'sleep-cycle':
      await sleepCycle(cliWorkspace)
      break
    case 'summarize':
      await summarizeOnly(cliWorkspace)
      break
    case 'memory-flush':
      await memoryFlush(cliWorkspace, {
        maxDays: cliMaxDays,
        maxCandidatesPerBatch: cliMaxCandidates,
        maxBatches: cliMaxBatches,
        minPending: cliMinPending,
      })
      break
    case 'memory-rebuild':
      await rebuildAllMemory(cliWorkspace)
      break
    case 'memory-rebuild-recent':
      await rebuildRecentMemory(cliWorkspace, {
        maxDays: cliMaxDays,
        maxCandidatesPerBatch: cliMaxCandidates,
        maxBatches: cliMaxBatches,
      })
      break
    case 'memory-prune-recent':
      await pruneMemoryToRecent(cliWorkspace, {
        maxDays: cliMaxDays,
      })
      break
    case 'doctor': {
      const workspacePath = cliWorkspace ? resolve(cliWorkspace) : getConfiguredWorkspace()
      doctor(scope, workspacePath)
      break
    }
    case 'workspace': {
      const rawPath = USER_ARGS[1] && !USER_ARGS[1].startsWith('-') ? USER_ARGS[1] : cliWorkspace
      if (!rawPath) {
        showWorkspace(getConfiguredWorkspace())
        break
      }
      const workspacePath = setWorkspaceConfig(rawPath)
      process.stdout.write(`Workspace saved: ${workspacePath}\n`)
      break
    }
    case 'display': {
      const rawMode = USER_ARGS[1] && !USER_ARGS[1].startsWith('-') ? USER_ARGS[1] : cliDisplayMode
      if (!rawMode) {
        showDisplayMode(getConfiguredDisplayMode())
        break
      }
      const nextMode = setDisplayModeConfig(rawMode)
      writeLauncherState({ displayMode: nextMode })
      // Immediately apply show/hide if a session is connected
      const displayState = readLauncherState()
      if (displayState?.connected && displayState.weztermPaneId != null) {
        try {
          if (nextMode === 'view') {
            showWezTermWindow(displayState.weztermPaneId)
          } else {
            hideWezTermApp()
          }
          process.stdout.write(`Display mode: ${nextMode} (applied immediately)\n`)
        } catch {
          process.stdout.write(`Display mode saved: ${nextMode} (will apply on next launch)\n`)
        }
      } else {
        process.stdout.write(`Display mode saved: ${nextMode}\n`)
      }
      break
    }
    case 'install-ngrok':
      ensureNgrokInstalled()
      break
    case 'install-voice':
      installVoiceDependencies()
      break
    default:
      printHelp()
      process.exitCode = 1
  }
}

main().catch(err => {
  process.stderr.write(`claude2bot-launcher: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
