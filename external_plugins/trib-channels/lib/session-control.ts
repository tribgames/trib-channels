import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { setTimeout as delay } from 'timers/promises'
import { getControlPath, getControlResponsePath } from './runtime-paths.js'

export type SessionControlCommand =
  | { type: 'interrupt' }
  | { type: 'send'; text: string }

export type SessionControlResult = {
  ok: boolean
  mode: 'tmux' | 'powershell' | 'unsupported'
  message: string
}

export async function controlClaudeSession(
  instanceId: string,
  command: SessionControlCommand,
  timeoutMs = 3000,
): Promise<SessionControlResult> {
  const controlPath = getControlPath(instanceId)
  const responsePath = getControlResponsePath(instanceId)
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`

  try { unlinkSync(responsePath) } catch {}
  writeFileSync(controlPath, JSON.stringify({ id, command, requestedAt: Date.now() }))

  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (existsSync(responsePath)) {
      try {
        const payload = JSON.parse(readFileSync(responsePath, 'utf8')) as { id?: string } & SessionControlResult
        if (payload.id === id) return payload
      } catch { /* wait again */ }
    }
    await delay(100)
  }

  return {
    ok: false,
    mode: 'unsupported',
    message: 'session control timeout',
  }
}
