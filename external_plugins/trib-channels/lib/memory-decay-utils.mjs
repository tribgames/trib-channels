export function decayConfidence(confidence, lastSeen) {
  const base = Number(confidence ?? 0.5)
  if (!lastSeen) return base
  const ageDays = Math.max(0, (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24))
  const penalty = Math.min(0.25, ageDays / 180 * 0.25)
  return Math.max(0.15, Number((base - penalty).toFixed(3)))
}

export function decaySignalScore(score, lastSeen, kind = '') {
  const base = Number(score ?? 0.5)
  if (!lastSeen) return base
  const ageDays = Math.max(0, (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24))
  const cutoff =
    kind === 'language' || kind === 'tone' ? 180 :
    kind === 'cadence' ? 120 :
    90
  const penalty = Math.min(0.45, ageDays / cutoff * 0.25)
  return Math.max(0.15, Number((base - penalty).toFixed(3)))
}
