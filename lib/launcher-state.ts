import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'

export type LauncherState = {
  runtimeMode?: string
  phase?: 'idle' | 'launching' | 'warning_confirm' | 'connecting' | 'ready' | 'error'
  displayMode?: 'hide' | 'view'
  workspacePath?: string
  terminalWindowId?: number | null
  terminalApp?: string
  weztermPaneId?: number | null
  weztermTabId?: number | null
  weztermWindowId?: number | null
  weztermWorkspace?: string
  windowTitle?: string
  launcherExecPath?: string
  launcherEntryPath?: string
  sessionId?: string
  claudePid?: number
  watcherPid?: number
  updatedAt?: number
  connected?: boolean
}

const LAUNCHER_STATE_PATH = join(homedir(), '.claude2bot-launcher-state.json')
const LAUNCHER_CONFIG_PATH = join(homedir(), '.claude2bot-launcher.json')
const WEZTERM_DATA_HOME = join(homedir(), '.claude2bot-launcher', 'wezterm-data')
const WEZTERM_RUNTIME_DIR = join(homedir(), '.claude2bot-launcher', 'wezterm-runtime')
const WEZTERM_SOCKET_PATH = join(WEZTERM_RUNTIME_DIR, 'claude2bot.sock')

// Keep in sync with launcher.mjs weztermEnv()
function weztermEnv() {
  return {
    ...process.env,
    XDG_DATA_HOME: WEZTERM_DATA_HOME,
    XDG_RUNTIME_DIR: WEZTERM_RUNTIME_DIR,
    WEZTERM_UNIX_SOCKET: WEZTERM_SOCKET_PATH,
    CLAUDE2BOT_WEZTERM_SOCKET: WEZTERM_SOCKET_PATH,
  }
}

export function readLauncherState(): LauncherState | null {
  try {
    return JSON.parse(readFileSync(LAUNCHER_STATE_PATH, 'utf8')) as LauncherState
  } catch {
    return null
  }
}

export type LauncherConfig = {
  workspacePath?: string
  displayMode?: 'hide' | 'view'
}

export function readLauncherConfig(): LauncherConfig | null {
  try {
    return JSON.parse(readFileSync(LAUNCHER_CONFIG_PATH, 'utf8')) as LauncherConfig
  } catch {
    return null
  }
}

export function launcherStateConnected(state: LauncherState | null): boolean {
  if (!state) return false

  if (state.claudePid) {
    try {
      process.kill(state.claudePid, 0)
      return true
    } catch {
      // expected: process may not exist
    }
  }

  if (state.terminalApp === 'WezTerm' && state.weztermPaneId != null) {
    try {
      const out = execFileSync('wezterm', [
        'cli',
        'list',
        '--format',
        'json',
      ], { encoding: 'utf8', env: weztermEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
      const items = JSON.parse(out)
      return Array.isArray(items) && items.some(item => Number(item?.pane_id ?? item?.paneId ?? 0) === state.weztermPaneId)
    } catch {
      // expected: wezterm CLI may not be available or pane may not exist
      return false
    }
  }

  return Boolean(state.connected)
}
