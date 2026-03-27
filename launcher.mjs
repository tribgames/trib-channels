#!/usr/bin/env node

import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import readline from 'readline'

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
    '  sleep-cycle            Run sleeping mode: summarize, restart session',
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

function commandSearchPaths() {
  const paths = new Set((process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean))
  for (const extra of [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local', 'bin'),
    '/Applications/WezTerm.app/Contents/MacOS',
    '/usr/bin',
    '/bin',
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
  // Force kill WezTerm GUI — mux keeps Claude session alive
  // SIGKILL avoids WezTerm's "Detach and Close?" confirmation dialog
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
      spawnWezTermWarningWatcher(pane.paneId, pane.windowId ?? 0, launchCwd)
    }
    ensureTrayAppRunningMac()
    return
  }
  throw new Error('WezTerm backend is required and no supported WezTerm installation was found.')
}

// ── Sleep Cycle ─────────────────────────────────────────────────────

function extractPingPong(transcriptPaths) {
  const paths = Array.isArray(transcriptPaths) ? transcriptPaths : [transcriptPaths]
  const results = []
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
          results.push(`${role}: ${text.trim()}`)
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }
  return results.join('\n\n')
}

function findTranscriptsSince(workspacePath, sinceTimestamp) {
  const projectKey = workspacePath.replace(/\//g, '-')
  const projectDir = join(homedir(), '.claude', 'projects', projectKey)
  try {
    return readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .map(f => ({ path: join(projectDir, f), mtime: statSync(join(projectDir, f)).mtimeMs }))
      .filter(f => f.mtime >= sinceTimestamp)
      .sort((a, b) => a.mtime - b.mtime)
      .map(f => f.path)
  } catch {
    return []
  }
}



function buildContextFile() {
  const dirs = { daily: join(HISTORY_DIR, 'daily') }
  const lifetime = join(HISTORY_DIR, 'lifetime.md')
  const identity = join(HISTORY_DIR, 'identity.md')
  const interests = join(HISTORY_DIR, 'interests.json')
  const ongoing = join(HISTORY_DIR, 'ongoing.md')
  const contextPath = join(HISTORY_DIR, 'context.md')

  const parts = []

  // Identity (fallback: lifetime)
  const identityContent = existsSync(identity) ? readFileSync(identity, 'utf8').trim() : ''
  if (identityContent) parts.push(`## Identity\n${identityContent}`)

  // Lifetime (fallback chain: lifetime → yearly → monthly → weekly → daily)
  let historyContent = ''
  if (existsSync(lifetime)) {
    historyContent = readFileSync(lifetime, 'utf8').trim()
  } else {
    for (const level of ['yearly', 'monthly', 'weekly', 'daily']) {
      const dir = join(HISTORY_DIR, level)
      if (!existsSync(dir)) continue
      const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse()
      if (files.length > 0) {
        historyContent = files.slice(0, 3).map(f => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n')
        break
      }
    }
  }
  if (historyContent) parts.push(`## History\n${historyContent}`)

  // Interests (top 10)
  if (existsSync(interests)) {
    try {
      const data = JSON.parse(readFileSync(interests, 'utf8'))
      const sorted = Object.entries(data).sort((a, b) => b[1].count - a[1].count).slice(0, 10)
      if (sorted.length > 0) {
        parts.push(`## Interests\n${sorted.map(([k, v]) => `${k}(${v.count})`).join(', ')}`)
      }
    } catch { /* skip */ }
  }

  // Ongoing
  const ongoingContent = existsSync(ongoing) ? readFileSync(ongoing, 'utf8').trim() : ''
  if (ongoingContent) parts.push(`## Ongoing\n${ongoingContent}`)

  // Recent 7 days daily
  if (existsSync(dirs.daily)) {
    const dailyFiles = readdirSync(dirs.daily).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 7)
    if (dailyFiles.length > 0) {
      const dailyContent = dailyFiles.map(f => readFileSync(join(dirs.daily, f), 'utf8').trim()).join('\n\n')
      parts.push(`## Recent Activity\n${dailyContent}`)
    }
  }

  mkdirSync(HISTORY_DIR, { recursive: true })
  writeFileSync(contextPath, `<!-- Auto-generated by sleep-cycle -->\n\n${parts.join('\n\n')}\n`)
  return contextPath
}

function sleepCycle(workspacePath) {
  const ws = workspacePath || getConfiguredWorkspace()
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  const [year, month] = today.split('-')
  const weekNum = getWeekNumber(new Date())
  const weekKey = `${year}-W${String(weekNum).padStart(2, '0')}`

  // Read lastSleepAt from config
  const config = readLauncherConfig() ?? {}
  const lastSleepAt = config.lastSleepAt ?? (now - 24 * 60 * 60 * 1000) // default: 24h ago

  process.stderr.write(`[sleep-cycle] Starting. Last sleep: ${new Date(lastSleepAt).toISOString()}\n`)

  mkdirSync(join(HISTORY_DIR, 'daily'), { recursive: true })
  mkdirSync(join(HISTORY_DIR, 'weekly'), { recursive: true })
  mkdirSync(join(HISTORY_DIR, 'monthly'), { recursive: true })
  mkdirSync(join(HISTORY_DIR, 'yearly'), { recursive: true })

  // 1. Mark sleeping phase (prevents tray auto-launch during sleep)
  resetLauncherState({ phase: 'sleeping', connected: false })

  // 2. Stop current session
  stopLauncher()

  // 2. Collect transcripts since last sleep
  const transcripts = findTranscriptsSince(ws, lastSleepAt)
  const promptPath = join(resourceDir(), 'sleep-prompt.md')
  const sleepPrompt = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : 'Summarize the conversation.'

  // Daily: 최대 7개 (1주치)
  const dailyDir = join(HISTORY_DIR, 'daily')
  const existingDailies = existsSync(dailyDir) ? readdirSync(dailyDir).filter(f => f.endsWith('.md')).length : 0

  if (existingDailies >= 7) {
    process.stderr.write(`[sleep-cycle] Daily limit reached (${existingDailies}/7). Skipping daily generation.\n`)
  } else if (transcripts.length > 0) {
    const pingpong = extractPingPong(transcripts)
    if (pingpong) {
      runSleepPrompt(sleepPrompt, { date: today, pingpong, ws })
      process.stderr.write(`[sleep-cycle] Daily ${today} generated. (${existingDailies + 1}/7)\n`)
    }
  } else {
    process.stderr.write('[sleep-cycle] No transcripts since last sleep.\n')
  }

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

  // 5. Build context.md
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

function runSleepPrompt(template, { date, pingpong, ws }) {
  const existing = {
    lifetime: existsSync(join(HISTORY_DIR, 'lifetime.md')) ? readFileSync(join(HISTORY_DIR, 'lifetime.md'), 'utf8') : '',
    identity: existsSync(join(HISTORY_DIR, 'identity.md')) ? readFileSync(join(HISTORY_DIR, 'identity.md'), 'utf8') : '',
    ongoing: existsSync(join(HISTORY_DIR, 'ongoing.md')) ? readFileSync(join(HISTORY_DIR, 'ongoing.md'), 'utf8') : '',
    interests: existsSync(join(HISTORY_DIR, 'interests.json')) ? readFileSync(join(HISTORY_DIR, 'interests.json'), 'utf8') : '{}',
  }
  const prompt = template
    .replace('{{DATE}}', date)
    .replace('{{PINGPONG}}', pingpong.slice(-50000))
    .replace('{{LIFETIME}}', existing.lifetime)
    .replace('{{IDENTITY}}', existing.identity)
    .replace('{{ONGOING}}', existing.ongoing)
    .replace('{{INTERESTS}}', existing.interests)
    .replace('{{HISTORY_DIR}}', HISTORY_DIR)
  try {
    execFileSync('claude', ['-p', prompt], {
      cwd: ws,
      stdio: 'inherit', timeout: 180000,
      env: process.env,
    })
  } catch (e) {
    process.stderr.write(`[sleep-cycle] claude -p failed: ${e.message}\n`)
  }
}

function runRollup(level, key, content) {
  const outFile = join(HISTORY_DIR, level, `${key}.md`)
  try {
    const summary = execFileSync('claude', ['-p',
      `Compress these summaries into a concise ${level} summary. Write in English except proper nouns. Output only the summary:\n\n${content}`
    ], { encoding: 'utf8', timeout: 120000 }).trim()
    writeFileSync(outFile, `# ${key}\n\n${summary}\n`)
    process.stderr.write(`[sleep-cycle] ${level} ${key} generated.\n`)
  } catch (e) {
    process.stderr.write(`[sleep-cycle] ${level} rollup failed: ${e.message}\n`)
  }
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
    const merged = execFileSync('claude', ['-p',
      `Merge and compress this into a single lifetime summary. Remove duplicates, keep only the most important history and patterns. Write in English except proper nouns. Output only the summary:\n\n${mergeInput}`
    ], { encoding: 'utf8', timeout: 120000 }).trim()
    writeFileSync(lifetimePath, merged + '\n')
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

function handleConfig(key, value) {
  const BOT_FILE = join(PLUGIN_DATA_DIR, 'bot.json')

  function readBot() {
    try { return JSON.parse(readFileSync(BOT_FILE, 'utf8')) } catch { return {} }
  }
  function writeBot(bot) {
    writeFileSync(BOT_FILE, JSON.stringify(bot, null, 2) + '\n')
  }

  if (!key) {
    // Show all config
    const config = readLauncherConfig()
    const bot = readBot()
    const lines = [
      `workspace: ${config.workspacePath ?? '(not set)'}`,
      `display: ${config.displayMode ?? 'view'}`,
      `autotalk: ${bot.autotalk?.enabled ? `on (freq ${bot.autotalk.freq ?? 3})` : 'off'}`,
      `quiet: ${bot.quiet?.schedule || 'off'}`,
      `sleeping: ${config.sleepEnabled !== false ? 'on' : 'off'}`,
      `sleeping-time: ${config.sleepTime ?? '03:00'}`,
    ]
    process.stdout.write(lines.join('\n') + '\n')
    return
  }

  switch (key) {
    case 'autotalk': {
      const bot = readBot()
      if (!value) {
        process.stdout.write(`${bot.autotalk?.enabled ? `on (freq ${bot.autotalk.freq ?? 3})` : 'off'}\n`)
        return
      }
      if (!bot.autotalk) bot.autotalk = {}
      if (value === 'off' || value === '0') {
        bot.autotalk.enabled = false
      } else {
        bot.autotalk.enabled = true
        const freqMap = { 'very-low': 1, low: 2, medium: 3, high: 4, 'very-high': 5 }
        const freq = freqMap[value.toLowerCase()] ?? parseInt(value, 10)
        if (freq >= 1 && freq <= 5) bot.autotalk.freq = freq
      }
      writeBot(bot)
      process.stdout.write(`autotalk: ${bot.autotalk.enabled ? `on (freq ${bot.autotalk.freq})` : 'off'}\n`)
      return
    }
    case 'quiet': {
      const bot = readBot()
      if (!value) {
        process.stdout.write(`${bot.quiet?.schedule || 'off'}\n`)
        return
      }
      if (!bot.quiet) bot.quiet = {}
      bot.quiet.schedule = value === 'off' ? '' : value
      writeBot(bot)
      process.stdout.write(`quiet: ${bot.quiet.schedule || 'off'}\n`)
      return
    }
    case 'sleeping': {
      const config = readLauncherConfig()
      if (!value) {
        process.stdout.write(`${config.sleepEnabled !== false ? 'on' : 'off'}\n`)
        return
      }
      config.sleepEnabled = value !== 'off' && value !== '0'
      writeLauncherConfig(config)
      process.stdout.write(`sleeping: ${config.sleepEnabled ? 'on' : 'off'}\n`)
      return
    }
    case 'sleeping-time': {
      const config = readLauncherConfig()
      if (!value) {
        process.stdout.write(`${config.sleepTime ?? '03:00'}\n`)
        return
      }
      config.sleepTime = value
      writeLauncherConfig(config)
      process.stdout.write(`sleeping-time: ${value}\n`)
      return
    }
    default:
      process.stderr.write(`Unknown config key: ${key}\nAvailable: autotalk, quiet, sleeping, sleeping-time\n`)
      process.exitCode = 1
  }
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
  const displayMode = normalizeDisplayMode(cliDisplayMode || getConfiguredDisplayMode())

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

          const latestSession = workspacePath ? latestSessionForWorkspace(workspacePath) : null
          if (sawChannelReady) {
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
      const workspacePath = await resolveWorkspace(cliWorkspace)
      installPlugin(scope)
      ensureWezTermInstalled()
      if (!workspaceExists(workspacePath)) {
        throw new Error(`Workspace does not exist: ${workspacePath}`)
      }
      launchClaude(workspacePath, displayMode)
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
      sleepCycle(cliWorkspace)
      break
    case 'config':
      handleConfig(USER_ARGS[1], USER_ARGS[2])
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
    default:
      printHelp()
      process.exitCode = 1
  }
}

main().catch(err => {
  process.stderr.write(`claude2bot-launcher: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
