import fs from 'fs'
import path from 'path'
import { DATA_DIR, PLUGIN_ROOT } from './config.mjs'

const DEFAULT_FILE = path.join(PLUGIN_ROOT, 'settings.default.md')
const LOCAL_FILE = path.join(DATA_DIR, 'settings.local.md')

function tryRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim()
  } catch {
    return ''
  }
}

export function loadSettings() {
  return [tryRead(DEFAULT_FILE), tryRead(LOCAL_FILE)]
    .filter(Boolean)
    .join('\n\n')
}
