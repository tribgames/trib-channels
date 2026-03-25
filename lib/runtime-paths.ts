import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export type ActiveInstanceState = {
  instanceId: string
  pid: number
  startedAt: number
  updatedAt: number
  turnEndFile: string
  statusFile: string
  channelId?: string
  transcriptPath?: string
}

export const RUNTIME_ROOT = join(tmpdir(), 'claude2bot')
export const OWNER_DIR = join(RUNTIME_ROOT, 'owners')
export const ACTIVE_INSTANCE_FILE = join(RUNTIME_ROOT, 'active-instance.json')
export const RUNTIME_STALE_TTL = 24 * 60 * 60 * 1000

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function ensureRuntimeDirs(): void {
  mkdirSync(RUNTIME_ROOT, { recursive: true })
  mkdirSync(OWNER_DIR, { recursive: true })
}

export function makeInstanceId(pid = process.pid): string {
  return String(pid)
}

export function getTurnEndPath(instanceId: string): string {
  return join(RUNTIME_ROOT, `turn-end-${sanitize(instanceId)}`)
}

export function getStatusPath(instanceId: string): string {
  return join(RUNTIME_ROOT, `status-${sanitize(instanceId)}.json`)
}

export function getControlPath(instanceId: string): string {
  return join(RUNTIME_ROOT, `control-${sanitize(instanceId)}.json`)
}

export function getControlResponsePath(instanceId: string): string {
  return join(RUNTIME_ROOT, `control-${sanitize(instanceId)}.response.json`)
}

export function getPermissionPendingPath(instanceId: string, uuid: string): string {
  return join(RUNTIME_ROOT, `perm-${sanitize(instanceId)}-${sanitize(uuid)}.pending`)
}

export function getPermissionResultPath(instanceId: string, uuid: string): string {
  return join(RUNTIME_ROOT, `perm-${sanitize(instanceId)}-${sanitize(uuid)}.result`)
}

export function getStopFlagPath(instanceId: string): string {
  return join(RUNTIME_ROOT, `stop-${sanitize(instanceId)}.flag`)
}

export function getChannelOwnerPath(channelId: string): string {
  return join(OWNER_DIR, `${sanitize(channelId)}.json`)
}

export function readActiveInstance(): ActiveInstanceState | null {
  try {
    return JSON.parse(readFileSync(ACTIVE_INSTANCE_FILE, 'utf8')) as ActiveInstanceState
  } catch {
    return null
  }
}

export function writeActiveInstance(state: ActiveInstanceState): void {
  ensureRuntimeDirs()
  writeFileSync(ACTIVE_INSTANCE_FILE, JSON.stringify(state))
}

export function buildActiveInstanceState(
  instanceId: string,
  meta?: Partial<Pick<ActiveInstanceState, 'channelId' | 'transcriptPath'>>,
): ActiveInstanceState {
  return {
    instanceId,
    pid: process.pid,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    turnEndFile: getTurnEndPath(instanceId),
    statusFile: getStatusPath(instanceId),
    ...(meta?.channelId ? { channelId: meta.channelId } : {}),
    ...(meta?.transcriptPath ? { transcriptPath: meta.transcriptPath } : {}),
  }
}

export function refreshActiveInstance(
  instanceId: string,
  meta?: Partial<Pick<ActiveInstanceState, 'channelId' | 'transcriptPath'>>,
): ActiveInstanceState {
  const prev = readActiveInstance()
  const next: ActiveInstanceState = {
    ...(prev?.instanceId === instanceId ? prev : buildActiveInstanceState(instanceId)),
    updatedAt: Date.now(),
    ...(meta?.channelId ? { channelId: meta.channelId } : {}),
    ...(meta?.transcriptPath ? { transcriptPath: meta.transcriptPath } : {}),
  }
  writeActiveInstance(next)
  return next
}

export function cleanupStaleRuntimeFiles(now = Date.now()): void {
  ensureRuntimeDirs()
  try {
    for (const file of readdirSync(RUNTIME_ROOT)) {
      const fullPath = join(RUNTIME_ROOT, file)
      if (file === 'owners' || file === 'active-instance.json') continue
      try {
        if (now - statSync(fullPath).mtimeMs > RUNTIME_STALE_TTL) unlinkSync(fullPath)
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  try {
    for (const file of readdirSync(OWNER_DIR)) {
      const fullPath = join(OWNER_DIR, file)
      try {
        if (now - statSync(fullPath).mtimeMs > RUNTIME_STALE_TTL) unlinkSync(fullPath)
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export function cleanupInstanceRuntimeFiles(instanceId: string): void {
  const targets = [
    getTurnEndPath(instanceId),
    getStatusPath(instanceId),
    getControlPath(instanceId),
    getControlResponsePath(instanceId),
    getStopFlagPath(instanceId),
  ]
  for (const target of targets) {
    try { unlinkSync(target) } catch { /* ignore */ }
  }

  try {
    for (const file of readdirSync(RUNTIME_ROOT)) {
      if (file.startsWith(`perm-${sanitize(instanceId)}-`)) {
        try { unlinkSync(join(RUNTIME_ROOT, file)) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

export function releaseOwnedChannelLocks(instanceId: string): void {
  try {
    for (const file of readdirSync(OWNER_DIR)) {
      const fullPath = join(OWNER_DIR, file)
      try {
        const owner = JSON.parse(readFileSync(fullPath, 'utf8')) as { instanceId?: string }
        if (owner.instanceId === instanceId) unlinkSync(fullPath)
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export function clearActiveInstance(instanceId: string): void {
  const active = readActiveInstance()
  if (active?.instanceId !== instanceId) return
  try { unlinkSync(ACTIVE_INSTANCE_FILE) } catch { /* ignore */ }
}
