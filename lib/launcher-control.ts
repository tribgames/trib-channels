import { execFileSync } from 'child_process'
import { readLauncherState } from './launcher-state.js'
import { PLUGIN_ROOT } from './config.js'

export type LauncherControlAction = 'restart' | 'launch' | 'display-view' | 'display-hide'

export type LauncherControlResult = {
  ok: boolean
  message: string
}

export function controlLauncher(action: LauncherControlAction): LauncherControlResult {
  const state = readLauncherState()
  const launcherExecPath = state?.launcherExecPath ?? process.execPath
  const launcherEntryPath = state?.launcherEntryPath ?? `${PLUGIN_ROOT}/launcher.mjs`

  if (action === 'launch') {
    try {
      execFileSync(launcherExecPath, launcherEntryPath ? [launcherEntryPath, 'launch'] : ['launch'], { stdio: 'ignore' })
      return { ok: true, message: 'Launcher started.' }
    } catch (err) {
      return { ok: false, message: `Launcher control failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  if (action === 'display-view' || action === 'display-hide') {
    const mode = action === 'display-view' ? 'view' : 'hide'
    try {
      execFileSync(launcherExecPath, launcherEntryPath ? [launcherEntryPath, 'display', mode] : ['display', mode], { stdio: 'ignore' })
      return { ok: true, message: `Display mode saved: ${mode}. Restart the launcher session to apply it.` }
    } catch (err) {
      return { ok: false, message: `Launcher control failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  if (!state?.connected) {
    return { ok: false, message: 'Launcher is not connected.' }
  }

  try {
    execFileSync(launcherExecPath, launcherEntryPath ? [launcherEntryPath, action] : [action], { stdio: 'ignore' })
    return { ok: true, message: 'Launcher terminal restarted.' }
  } catch (err) {
    return { ok: false, message: `Launcher control failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
