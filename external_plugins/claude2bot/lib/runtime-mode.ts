export type RuntimeMode = 'tmux' | 'powershell' | 'unmanaged'

export function detectRuntimeMode(): RuntimeMode {
  if (process.env.TMUX) return 'tmux'
  if (process.platform === 'win32') return 'powershell'
  return 'unmanaged'
}

export function supportsSessionControl(mode: RuntimeMode): boolean {
  return mode !== 'unmanaged'
}

export function supportsInteractiveSessionCommands(mode: RuntimeMode): boolean {
  return mode === 'tmux'
}

export function runtimeModeLabel(mode: RuntimeMode): string {
  switch (mode) {
    case 'tmux': return 'tmux'
    case 'powershell': return 'powershell'
    default: return 'unmanaged'
  }
}

export function runtimeModeHint(mode: RuntimeMode): string {
  switch (mode) {
    case 'tmux':
      return 'Session control is available through tmux.'
    case 'powershell':
      return 'Basic session control uses the Windows fallback path.'
    default:
      return 'Session control is unavailable in this terminal. Use tmux for full control.'
  }
}
