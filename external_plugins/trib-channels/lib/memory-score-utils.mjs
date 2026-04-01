import { DEFAULT_MEMORY_TUNING } from './memory-tuning.mjs'
import { isProfileIntent, isPolicyIntent } from './memory-ranking-utils.mjs'
import { profileKeyForFact } from './memory-profile-utils.mjs'

export function getConfiguredTypeBoost(item, tuning = DEFAULT_MEMORY_TUNING) {
  const cfg = tuning?.weights?.typeBoost ?? DEFAULT_MEMORY_TUNING.weights.typeBoost
  if (item.type === 'fact') {
    const factCfg = cfg.fact ?? DEFAULT_MEMORY_TUNING.weights.typeBoost.fact
    return Number(factCfg[item.subtype] ?? factCfg.default ?? -0.09)
  }
  if (item.type === 'task') return Number(cfg.task ?? -0.1)
  if (item.type === 'proposition') return Number(cfg.proposition ?? -0.12)
  if (item.type === 'entity') return Number(cfg.entity ?? -0.08)
  if (item.type === 'relation') return Number(cfg.relation ?? -0.1)
  if (item.type === 'profile') return Number(cfg.profile ?? -0.08)
  if (item.type === 'signal') {
    const signalCfg = cfg.signal ?? DEFAULT_MEMORY_TUNING.weights.typeBoost.signal
    return Number(signalCfg[item.subtype] ?? signalCfg.default ?? -0.04)
  }
  if (item.type === 'episode') return Number(cfg.episode ?? -0.04)
  return 0
}

export function getConfiguredIntentBoost(intent, item, tuning = DEFAULT_MEMORY_TUNING) {
  const cfg = tuning?.weights?.intentBoost ?? DEFAULT_MEMORY_TUNING.weights.intentBoost
  const branch =
    isProfileIntent(intent) ? cfg.profile :
    intent === 'task' ? cfg.task :
    isPolicyIntent(intent) ? cfg.policy :
    intent === 'event' ? cfg.event :
    intent === 'history' ? cfg.history :
    cfg.decision

  if (isProfileIntent(intent)) {
    if (item.type === 'fact' && (item.subtype === 'preference' || item.subtype === 'constraint')) {
      return Number(branch?.fact?.[item.subtype] ?? 0)
    }
    if (item.type === 'proposition') return Number(branch?.proposition ?? 0)
    if (item.type === 'signal' && (item.subtype === 'tone' || item.subtype === 'language')) {
      return Number(branch?.signal?.[item.subtype] ?? 0)
    }
    if (item.type === 'profile') return Number(branch?.profile ?? 0)
    if (item.type === 'task') return Number(branch?.task ?? 0)
    if (item.type === 'episode') return Number(branch?.episode ?? 0)
    return 0
  }
  if (intent === 'task') {
    if (item.type === 'task') return Number(branch?.task ?? 0)
    if (item.type === 'proposition') return Number(branch?.proposition ?? 0)
    if (item.type === 'fact') return Number(branch?.fact?.[item.subtype] ?? branch?.fact?.default ?? 0)
    if (item.type === 'signal') return Number(branch?.signal ?? 0)
    if (item.type === 'episode') return Number(branch?.episode ?? 0)
    return 0
  }
  if (isPolicyIntent(intent)) {
    if (item.type === 'fact' && (item.subtype === 'constraint' || item.subtype === 'decision')) return Number(branch?.fact?.[item.subtype] ?? 0)
    if (item.type === 'proposition') return Number(branch?.proposition ?? 0)
    if (item.type === 'relation') return Number(branch?.relation ?? 0)
    if (item.type === 'entity') return Number(branch?.entity ?? 0)
    if (item.type === 'signal') return Number(branch?.signal ?? 0)
    if (item.type === 'task') return Number(branch?.task ?? 0)
    if (item.type === 'episode') return Number(branch?.episode ?? 0)
    return 0
  }
  if (intent === 'event') {
    if (item.type === 'episode') return Number(branch?.episode ?? 0)
    if (item.type === 'proposition') return Number(branch?.proposition ?? 0)
    if (item.type === 'task' && item.source_episode_id != null) return Number(branch?.taskWithSource ?? 0)
    if (item.type === 'fact' && item.source_episode_id != null) return Number(branch?.factWithSource ?? 0)
    if (item.type === 'signal') return Number(branch?.signal ?? 0)
    return 0
  }
  if (intent === 'history') {
    if (item.type === 'episode') return Number(branch?.episode ?? 0)
    if (item.type === 'proposition') return Number(branch?.proposition ?? 0)
    if (item.type === 'entity') return Number(branch?.entity ?? 0)
    if (item.type === 'relation') return Number(branch?.relation ?? 0)
    if (item.type === 'task') return Number(branch?.task ?? 0)
    if (item.type === 'signal') return Number(branch?.signal ?? 0)
    return 0
  }

  if (item.type === 'fact' && (item.subtype === 'decision' || item.subtype === 'constraint')) return Number(branch?.fact?.[item.subtype] ?? 0)
  if (item.type === 'proposition') return Number(branch?.proposition ?? 0)
  if (item.type === 'entity') return Number(branch?.entity ?? 0)
  if (item.type === 'relation') return Number(branch?.relation ?? 0)
  if (item.type === 'profile') return Number(branch?.profile ?? 0)
  if (item.type === 'task') return Number(branch?.task ?? 0)
  return 0
}

export function getProfileSlotRankAdjustment(profileSlot, item) {
  const slot = String(profileSlot ?? '').trim()
  if (!slot) return 0
  const itemType = String(item?.type ?? '')
  const itemSubtype = String(item?.subtype ?? '').trim()

  if (itemType === 'profile') {
    if (itemSubtype === slot) return -0.46
    if (slot === 'language' && itemSubtype === 'tone') return 0.22
    if (slot === 'tone' && itemSubtype === 'language') return 0.18
    return 0.12
  }

  if (itemType === 'signal') {
    if (itemSubtype === slot) return -0.4
    if (slot === 'response_style' && itemSubtype === 'tone') return -0.14
    if (slot === 'language' && itemSubtype === 'tone') return 0.24
    if (slot === 'tone' && itemSubtype === 'language') return 0.2
    return 0.1
  }

  if (itemType === 'fact') {
    const factSlot = profileKeyForFact(String(item?.subtype ?? ''), String(item?.content ?? ''))
    if (factSlot && factSlot === slot) return -0.22
    if (slot === 'language' && /한국어|영어|일본어|중국어|language|korean|english|japanese|chinese/i.test(String(item?.content ?? ''))) return -0.16
    if (slot === 'tone' && /존댓말|반말|말투|어투|tone|style|formal|respectful|casual/i.test(String(item?.content ?? ''))) return -0.16
    if (slot === 'timezone' && /시간대|타임존|timezone|local device/i.test(String(item?.content ?? ''))) return -0.16
    return 0
  }

  if (itemType === 'proposition') {
    if (slot === 'language' && /한국어|영어|language|korean|english/i.test(String(item?.content ?? ''))) return -0.14
    if (slot === 'tone' && /존댓말|반말|말투|어투|tone|style|formal|respectful|casual/i.test(String(item?.content ?? ''))) return -0.14
    return 0
  }

  return 0
}
