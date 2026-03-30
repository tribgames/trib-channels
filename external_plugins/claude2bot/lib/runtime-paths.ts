import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureDir, readJsonFile, removeFileIfExists, writeJsonFile } from './state-file.js'

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

function forEachFile(dirPath: string, visit: (fullPath: string, fileName: string) => void): void {
  try {
    for (const fileName of readdirSync(dirPath)) {
      visit(join(dirPath, fileName), fileName)
    }
  } catch { /* ignore */ }
}

export function ensureRuntimeDirs(): void {
  ensureDir(RUNTIME_ROOT)
  ensureDir(OWNER_DIR)
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
  return readJsonFile<ActiveInstanceState | null>(ACTIVE_INSTANCE_FILE, null)
}

export function writeActiveInstance(state: ActiveInstanceState): void {
  ensureRuntimeDirs()
  writeJsonFile(ACTIVE_INSTANCE_FILE, state)
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

const SERVER_PID_FILE = join(
  RUNTIME_ROOT,
  `server-${sanitize(process.env.CLAUDE_PLUGIN_DATA ?? 'default')}.pid`,
)

function looksLikeClaude2BotServer(pid: number): boolean {
  const pidStr = String(pid)
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pidStr}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).trim()
      if (!out || out.includes('No tasks')) return false
      const lower = out.toLowerCase()
      return lower.includes('node') || lower.includes('tsx') || lower.includes('claude2bot')
    } catch {
      return true // tasklist failed — assume it's ours to be safe
    }
  }
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', pidStr], { encoding: 'utf8' }).trim()
    if (!cmd) return false
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? ''
    return (
      cmd.includes('claude2bot') ||
      (pluginRoot && cmd.includes(pluginRoot)) ||
      cmd.includes('tsx server.ts') ||
      cmd.includes('server.ts') ||
      (cmd.includes('node') && cmd.includes('server'))
    )
  } catch {
    return false
  }
}

function waitForExit(pid: number, timeoutMs: number): boolean {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0)
    } catch {
      return true // process gone
    }
    const wait = 100
    const end = Date.now() + wait
    while (Date.now() < end) { /* busy-wait ~100ms */ }
  }
  return false
}

export function killPreviousServer(): void {
  try {
    const oldPid = parseInt(readFileSync(SERVER_PID_FILE, 'utf8').trim(), 10)
    if (!oldPid || oldPid === process.pid) return

    // Check if process is alive
    try { process.kill(oldPid, 0) } catch { return }

    if (!looksLikeClaude2BotServer(oldPid)) return

    if (process.platform === 'win32') {
      // Windows: taskkill /F /T kills process tree
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(oldPid)], { encoding: 'utf8', timeout: 5000 })
      } catch (err) {
        console.warn(`[singleton] taskkill failed for PID ${oldPid}:`, (err as Error).message)
      }
    } else {
      // Unix: try process group kill first (negative PID)
      let groupKilled = false
      try {
        process.kill(-oldPid, 'SIGTERM')
        groupKilled = true
      } catch {
        // process group kill failed — fall back to single PID
        try { process.kill(oldPid, 'SIGTERM') } catch { /* ignore */ }
      }

      // Wait up to 2s for graceful exit
      if (!waitForExit(oldPid, 2000)) {
        // Still alive — escalate to SIGKILL
        try {
          if (groupKilled) {
            process.kill(-oldPid, 'SIGKILL')
          } else {
            process.kill(oldPid, 'SIGKILL')
          }
        } catch { /* ignore */ }

        if (!waitForExit(oldPid, 1000)) {
          console.warn(`[singleton] failed to kill previous server PID ${oldPid}`)
        }
      }
    }
  } catch { /* no pid file = first run */ }
}

export function writeServerPid(): void {
  ensureRuntimeDirs()
  writeFileSync(SERVER_PID_FILE, String(process.pid))
}

export function clearServerPid(): void {
  try {
    const current = readFileSync(SERVER_PID_FILE, 'utf8').trim()
    if (current === String(process.pid)) removeFileIfExists(SERVER_PID_FILE)
  } catch { /* ignore */ }
}

export function cleanupStaleRuntimeFiles(now = Date.now()): void {
  ensureRuntimeDirs()
  forEachFile(RUNTIME_ROOT, (fullPath, file) => {
    if (file === 'owners' || file === 'active-instance.json') return
    try {
      if (now - statSync(fullPath).mtimeMs > RUNTIME_STALE_TTL) removeFileIfExists(fullPath)
    } catch { /* ignore */ }
  })
  forEachFile(OWNER_DIR, fullPath => {
    try {
      if (now - statSync(fullPath).mtimeMs > RUNTIME_STALE_TTL) removeFileIfExists(fullPath)
    } catch { /* ignore */ }
  })
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
    removeFileIfExists(target)
  }

  forEachFile(RUNTIME_ROOT, (fullPath, file) => {
    if (file.startsWith(`perm-${sanitize(instanceId)}-`)) {
      removeFileIfExists(fullPath)
    }
  })
}

export function releaseOwnedChannelLocks(instanceId: string): void {
  forEachFile(OWNER_DIR, fullPath => {
    const owner = readJsonFile<{ instanceId?: string } | null>(fullPath, null)
    if (owner?.instanceId === instanceId) removeFileIfExists(fullPath)
  })
}

export function clearActiveInstance(instanceId: string): void {
  const active = readActiveInstance()
  if (active?.instanceId !== instanceId) return
  removeFileIfExists(ACTIVE_INSTANCE_FILE)
}
