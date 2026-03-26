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
    '  doctor                 Show environment and installation status',
    '  workspace [path]       Show or set the default workspace path',
    '  display [hide|view]    Show or set the launcher display mode',
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

  if (hasCommand('npm')) {
    run('npm', ['install', '-g', '@anthropic-ai/claude-code'], true)
    return
  }

  if (process.platform === 'win32') {
    runShell('irm https://claude.ai/install.ps1 | iex', true)
    return
  }

  runShell('curl -fsSL https://claude.ai/install.sh | bash', true)
}

function ensureNodeTooling() {
  if (hasCommand('npm') && hasCommand('npx')) return

  if (process.platform === 'darwin' && hasCommand('brew')) {
    run('brew', ['install', 'node'], true)
    return
  }

  if (process.platform === 'win32' && hasCommand('winget')) {
    run('winget', ['install', '--id', 'OpenJS.NodeJS.LTS', '-e'], true)
    return
  }

  throw new Error('Node.js tooling (npm/npx) is required but could not be installed automatically.')
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
    run('winget', ['install', 'wez.wezterm', '-e'], true)
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

function ensureWezTermGuiRunning() {
  // Check if WezTerm GUI is already running
  if (process.platform === 'darwin') {
    try {
      const result = execFileSync(resolveCommand('swift') || 'swift', ['-e', `
import AppKit
let found = NSWorkspace.shared.runningApplications.contains(where: {
  let name = ($0.localizedName ?? "").lowercased()
  let path = ($0.executableURL?.path ?? "").lowercased()
  return name.contains("wezterm") || path.hasSuffix("/${WEZTERM_PROCESS_NAME}")
})
print(found ? "1" : "0")
`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (result === '1') return // GUI already running
    } catch { /* fall through */ }
  }

  // Start GUI by connecting to mux
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
    execFileSync(resolveCommand('swift') || 'swift', ['-e', `
import AppKit
if let app = NSWorkspace.shared.runningApplications.first(where: {
  let name = ($0.localizedName ?? "").lowercased()
  let path = ($0.executableURL?.path ?? "").lowercased()
  return name.contains("wezterm") || path.hasSuffix("/${WEZTERM_PROCESS_NAME}")
}) {
  _ = app.hide()
}
`], { stdio: 'ignore' })
    return
  }
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

    // Ensure WezTerm mux server is running (required for mux spawn)
    ensureWezTermMuxRunning(wezterm)

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
