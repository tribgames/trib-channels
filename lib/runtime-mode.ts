export type RuntimeMode = 'launcher' | 'tmux' | 'powershell' | 'unmanaged'

export function detectRuntimeMode(): RuntimeMode {
  if (process.env.CLAUDE2BOT_LAUNCHER === '1') return 'launcher'
  if (process.env.TMUX) return 'tmux'
  if (process.platform === 'win32') return 'powershell'
  return 'unmanaged'
}

export function supportsSessionControl(mode: RuntimeMode): boolean {
  return mode !== 'unmanaged'
}

export function runtimeModeLabel(mode: RuntimeMode): string {
  switch (mode) {
    case 'launcher': return 'launcher'
    case 'tmux': return 'tmux'
    case 'powershell': return 'powershell'
    default: return 'unmanaged'
  }
}

export function runtimeModeHint(mode: RuntimeMode): string {
  switch (mode) {
    case 'launcher':
      return 'Full session control is available.'
    case 'tmux':
      return 'Session control is available through tmux.'
    case 'powershell':
      return 'Session control uses the Windows fallback path.'
    default:
      return 'Session control is unavailable in this terminal. Use tmux or launcher mode.'
  }
}
