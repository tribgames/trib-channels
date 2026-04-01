/**
 * Shared i18n module for custom-commands.
 *
 * Supports 4 languages: en, ko, ja, zh.
 * Fallback chain: requested lang → en → key itself.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from './config.js'

export type Lang = 'en' | 'ko' | 'ja' | 'zh'

type I18nEntry = Partial<Record<Lang, string>>

// ── Config language override ────────────────────────────────────────

let configLangCache: Lang | null | undefined = undefined

function getConfigLang(): Lang | null {
  if (configLangCache !== undefined) return configLangCache
  try {
    const configPath = join(DATA_DIR, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const lang = config.language as string | undefined
    if (lang === 'en' || lang === 'ko' || lang === 'ja' || lang === 'zh') {
      configLangCache = lang
      return lang
    }
  } catch { /* ignore */ }
  configLangCache = null
  return null
}

/** Resolve a Discord locale string to a supported Lang */
export function getLang(locale: string): Lang {
  const override = getConfigLang()
  if (override) return override
  if (locale === 'ko') return 'ko'
  if (locale === 'ja') return 'ja'
  if (locale.startsWith('zh')) return 'zh'
  return 'en'
}

// ── Dictionary ──────────────────────────────────────────────────────

const dict: Record<string, I18nEntry> = {
  'schedule.empty': {
    ko: 'No schedules registered.',
    en: 'No schedules configured.',
  },
  'schedule.added': {
    ko: 'Schedule "{name}" added ({mode}, {time})',
    en: 'Schedule "{name}" added ({mode}, {time})',
  },
  'schedule.exists': {
    ko: 'Schedule "{name}" already exists.',
    en: 'Schedule "{name}" already exists.',
  },
  'schedule.not_found': {
    ko: 'Schedule "{name}" not found.',
    en: 'Schedule "{name}" not found.',
  },
  'schedule.removed': {
    ko: 'Schedule "{name}" deleted.',
    en: 'Schedule "{name}" removed.',
  },
  'schedule.edited': {
    ko: 'Schedule "{name}" updated.',
    en: 'Schedule "{name}" updated.',
  },
  'schedule.triggered': {
    ko: 'Running schedule "{name}"...',
    en: 'Triggering schedule "{name}"...',
  },
  'schedule.missing_name': {
    ko: 'Schedule name required.',
    en: 'Schedule name is required.',
  },
  'schedule.missing_fields': {
    ko: 'time and channel fields are required.',
    en: 'time and channel fields are required.',
  },
  'profile.empty': {
    ko: 'No profile configured.',
    en: 'No profile configured.',
  },
  'profile.updated': {
    ko: 'Profile updated.',
    en: 'Profile updated.',
  },
  'unknown_action': {
    ko: 'Unknown command: {action}',
    en: 'Unknown action: {action}',
  },
  'unknown_sub': {
    ko: 'Unknown subcommand: {sub}',
    en: 'Unknown subcommand: {sub}',
  },
  'autotalk.status': {
    ko: 'Autotalk Status',
    en: 'Autotalk Status',
  },
  'autotalk.freq_updated': {
    ko: 'Autotalk frequency changed to {freq}.',
    en: 'Autotalk frequency updated to {freq}.',
  },
  'autotalk.enabled': {
    ko: 'Autotalk enabled.',
    en: 'Autotalk enabled.',
  },
  'autotalk.disabled': {
    ko: 'Autotalk disabled.',
    en: 'Autotalk disabled.',
  },
  'quiet.status': {
    ko: 'Quiet Hours',
    en: 'Quiet Settings',
  },
  'quiet.updated': {
    ko: 'Quiet hours updated.',
    en: 'Quiet settings updated.',
  },
  'activity.empty': {
    ko: 'No activity channels registered.',
    en: 'No activity channels configured.',
  },
  'activity.added': {
    ko: 'Channel "{name}" added.',
    en: 'Channel "{name}" added.',
  },
  'activity.exists': {
    ko: 'Channel "{name}" already exists.',
    en: 'Channel "{name}" already exists.',
  },
  'activity.not_found': {
    ko: 'Channel "{name}" not found.',
    en: 'Channel "{name}" not found.',
  },
  'activity.removed': {
    ko: 'Channel "{name}" deleted.',
    en: 'Channel "{name}" removed.',
  },
  'activity.missing_name': {
    ko: 'Channel name required.',
    en: 'Channel name is required.',
  },
  'activity.missing_id': {
    ko: 'Channel ID required.',
    en: 'Channel ID is required.',
  },
}

/**
 * Translate a key with variable substitution.
 * Variables use `{key}` format.
 */
export function t(key: string, lang: Lang | string, vars?: Record<string, string | number>): string {
  const resolved: Lang = (typeof lang === 'string' && (lang === 'en' || lang === 'ko' || lang === 'ja' || lang === 'zh'))
    ? lang
    : getLang(lang)
  let text = dict[key]?.[resolved] ?? dict[key]?.en ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}
