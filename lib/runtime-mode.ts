export type RuntimeMode = 'launcher' | 'wezterm' | 'tmux' | 'powershell' | 'unmanaged'

export function detectRuntimeMode(): RuntimeMode {
  if (process.env.WEZTERM_PANE) return 'wezterm'
  if (process.env.CLAUDE2BOT_LAUNCHER === '1') return 'launcher'
  if (process.env.TMUX) return 'tmux'
  if (process.platform === 'win32') return 'powershell'
  return 'unmanaged'
}

export function supportsSessionControl(mode: RuntimeMode): boolean {
  return mode !== 'unmanaged'
}

export function supportsInteractiveSessionCommands(mode: RuntimeMode): boolean {
  return mode === 'launcher' || mode === 'wezterm' || mode === 'tmux'
}

export function runtimeModeLabel(mode: RuntimeMode): string {
  switch (mode) {
    case 'launcher': return 'launcher'
    case 'wezterm': return 'wezterm'
    case 'tmux': return 'tmux'
    case 'powershell': return 'powershell'
    default: return 'unmanaged'
  }
}

export function runtimeModeHint(mode: RuntimeMode): string {
  switch (mode) {
    case 'launcher':
      return 'Full session control is available.'
    case 'wezterm':
      return 'Full session control is available through WezTerm.'
    case 'tmux':
      return 'Session control is available through tmux.'
    case 'powershell':
      return 'Basic session control uses the Windows fallback path.'
    default:
      return 'Session control is unavailable in this terminal. Use the WezTerm launcher mode.'
  }
}
