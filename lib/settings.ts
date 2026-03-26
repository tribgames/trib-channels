/**
 * Settings loader — merges default + local + contextFiles into
 * a single string appended to MCP instructions.
 *
 * Priority (later wins for conflicting rules):
 *   1. settings.default.md  (bundled with plugin)
 *   2. contextFiles[]       (user-specified MD files in config.json)
 *   3. settings.local.md    (per-install overrides, gitignored)
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { PLUGIN_ROOT, DATA_DIR } from './config.js'

const DEFAULT_FILE = join(PLUGIN_ROOT, 'settings.default.md')
const LOCAL_FILE = join(DATA_DIR, 'settings.local.md')

export function tryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * Load all settings files and return concatenated content.
 * Returns empty string if no settings files exist.
 */
export function loadSettings(contextFiles?: string[]): string {
  const parts: string[] = []

  // 1. Default settings (bundled)
  const defaults = tryRead(DEFAULT_FILE)
  if (defaults) parts.push(defaults)

  // 2. Context files (user-specified in config.json)
  for (const f of contextFiles ?? []) {
    const content = tryRead(f)
    if (content) parts.push(content)
  }

  // 3. Local overrides (gitignored, per-install)
  const local = tryRead(LOCAL_FILE)
  if (local) parts.push(local)

  return parts.join('\n\n')
}
