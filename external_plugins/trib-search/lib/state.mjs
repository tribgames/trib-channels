import { USAGE_PATH, readJson, writeJson } from './config.mjs'

function now() {
  return new Date().toISOString()
}

function defaultState() {
  return {
    providers: {},
    routingCache: {
      rawBySite: {},
      scrapeByHost: {},
    },
  }
}

export function loadUsageState() {
  return readJson(USAGE_PATH, defaultState())
}

export function saveUsageState(state) {
  writeJson(USAGE_PATH, state)
}

export function updateProviderState(state, provider, patch) {
  state.providers[provider] = {
    ...(state.providers[provider] || {}),
    ...patch,
    updatedAt: patch.updatedAt || now(),
  }
  saveUsageState(state)
}

export function noteProviderSuccess(state, provider, extra = {}) {
  updateProviderState(state, provider, {
    ...extra,
    lastUsedAt: now(),
    lastSuccessAt: now(),
    cooldownUntil: null,
  })
}

export function noteProviderFailure(state, provider, errorMessage, cooldownMs = 0) {
  const payload = {
    error: errorMessage,
    lastUsedAt: now(),
    lastFailureAt: now(),
  }
  if (cooldownMs > 0) {
    payload.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString()
  }
  updateProviderState(state, provider, payload)
}

export function rankProviders(baseProviders, state, site) {
  if (!site) return [...baseProviders]
  const preferred = state.routingCache?.rawBySite?.[site]
  if (!preferred || !Array.isArray(preferred) || preferred.length === 0) {
    return [...baseProviders]
  }
  const order = new Map(preferred.map((provider, index) => [provider, index]))
  return [...baseProviders].sort((left, right) => {
    const leftIndex = order.has(left) ? order.get(left) : Number.MAX_SAFE_INTEGER
    const rightIndex = order.has(right) ? order.get(right) : Number.MAX_SAFE_INTEGER
    return leftIndex - rightIndex
  })
}

export function rememberPreferredRawProviders(state, site, providers) {
  if (!site || !providers?.length) return
  state.routingCache.rawBySite[site] = [...providers]
  saveUsageState(state)
}

export function rememberPreferredScrapeExtractor(state, host, extractor) {
  if (!host || !extractor) return
  state.routingCache.scrapeByHost[host] = [extractor]
  saveUsageState(state)
}

export function rankScrapeExtractors(host, state, defaults) {
  const preferred = state.routingCache?.scrapeByHost?.[host]
  if (!preferred || !Array.isArray(preferred) || preferred.length === 0) {
    return [...defaults]
  }

  const ranked = [...preferred]
  for (const candidate of defaults) {
    if (!ranked.includes(candidate)) {
      ranked.push(candidate)
    }
  }
  return ranked
}
