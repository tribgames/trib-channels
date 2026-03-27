/**
 * Shared i18n module for slash-commands and custom-commands.
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
  // -- slash-commands (4-lang) --
  'session.command_forwarded': {
    en: 'Forwarded `{command}` to the Claude session. The result will appear in the channel.',
    ko: 'Claude 세션에 `{command}` 요청을 전달했습니다. 결과는 채널에 표시됩니다.',
    ja: 'Claude セッションに`{command}`を転送しました。結果はチャンネルに表示されます。',
    zh: '已将`{command}`转发到 Claude 会话。结果会显示在频道中。',
  },
  'model.switched': {
    en: 'Model switch request: **{model}** (forwarded to session)',
    ko: 'Model switch requested: **{model}** (forwarded to session)',
    ja: 'モデル切替リクエスト: **{model}** (セッションに転送済み)',
    zh: '模型切换请求: **{model}** (已转发到会话)',
  },
  'compact.forwarded': {
    en: 'Compact request forwarded to session.',
    ko: 'Context compact request forwarded to session.',
    ja: '圧縮リクエストをセッションに転送しました。',
    zh: '压缩请求已转发到会话。',
  },
  'clear.forwarded': {
    en: 'Clear request forwarded to session.',
    ko: 'Clear request forwarded to session.',
    ja: 'クリアリクエストをセッションに転送しました。',
    zh: '清除请求已转发到会话。',
  },
  'new.forwarded': {
    en: 'New session request forwarded to session.',
    ko: 'New session request forwarded to session.',
    ja: '新しいセッションリクエストをセッションに転送しました。',
    zh: '新建会话请求已转发到会话。',
  },
  'unknown_command': {
    en: 'Unknown command: {cmd}',
    ko: 'Unknown command: {cmd}',
    ja: '不明なコマンド: {cmd}',
    zh: '未知命令: {cmd}',
  },

  // -- custom-commands (2-lang, en fallback for ja/zh) --
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
