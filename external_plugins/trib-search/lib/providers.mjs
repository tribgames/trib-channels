const SERPER_ENDPOINTS = {
  web: 'https://google.serper.dev/search',
  news: 'https://google.serper.dev/news',
  images: 'https://google.serper.dev/images',
}

export const RAW_PROVIDER_IDS = ['serper', 'brave', 'perplexity', 'firecrawl', 'tavily', 'x_search']

function normalizeKeywords(keywords) {
  if (Array.isArray(keywords)) {
    return keywords.filter(Boolean).join(' ').trim()
  }
  return String(keywords || '').trim()
}

function buildQuery(keywords, site) {
  const query = normalizeKeywords(keywords)
  if (!site) return query
  return `${query} site:${site}`.trim()
}

export function getAvailableRawProviders(env = process.env) {
  const providers = []
  if (env.SERPER_API_KEY) providers.push('serper')
  if (env.BRAVE_API_KEY) providers.push('brave')
  if (env.PERPLEXITY_API_KEY) providers.push('perplexity')
  if (env.FIRECRAWL_API_KEY) providers.push('firecrawl')
  if (env.TAVILY_API_KEY) providers.push('tavily')
  if (env.XAI_API_KEY || env.GROK_API_KEY) providers.push('x_search')
  return providers
}

function inferLocale(query) {
  const hasKorean = /[가-힣]/.test(query)
  return hasKorean
    ? { country: 'KR', language: 'ko' }
    : { country: 'US', language: 'en' }
}

async function runSerperSearch({ query, type, maxResults }) {
  const endpoint = SERPER_ENDPOINTS[type] || SERPER_ENDPOINTS.web
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.SERPER_API_KEY,
    },
    body: JSON.stringify({
      q: query,
      num: maxResults,
      gl: 'kr',
      hl: 'ko',
    }),
  })

  if (!response.ok) {
    throw new Error(`Serper request failed: ${response.status}`)
  }

  const payload = await response.json()
  const rows = payload?.organic || payload?.news || payload?.images || []
  return rows.slice(0, maxResults).map(item => ({
    title: item.title || item.source || '',
    url: item.link || item.imageUrl || item.url || '',
    snippet: item.snippet || item.description || '',
    source: item.source || 'serper',
    publishedDate: item.date || null,
    provider: 'serper',
  }))
}

async function runBraveSearch({ query, maxResults }) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(maxResults))

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': process.env.BRAVE_API_KEY,
    },
  })

  if (!response.ok) {
    throw new Error(`Brave request failed: ${response.status}`)
  }

  const payload = await response.json()
  const rows = payload?.web?.results || []
  return rows.slice(0, maxResults).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.description || '',
    source: item.profile?.name || 'brave',
    publishedDate: item.age || null,
    provider: 'brave',
  }))
}

async function runPerplexitySearch({ query, maxResults }) {
  const locale = inferLocale(query)
  const response = await fetch('https://api.perplexity.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      max_tokens_per_page: 1024,
      country: locale.country,
    }),
  })

  if (!response.ok) {
    throw new Error(`Perplexity request failed: ${response.status}`)
  }

  const payload = await response.json()
  const rows = payload?.results || []
  return rows.slice(0, maxResults).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.snippet || '',
    source: 'perplexity',
    publishedDate: item.date || null,
    provider: 'perplexity',
  }))
}

async function runFirecrawlSearch({ query, type, maxResults }) {
  const locale = inferLocale(query)
  const source = type === 'images' ? 'images' : type === 'news' ? 'news' : 'web'
  const response = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      limit: maxResults,
      sources: [source],
      country: locale.country,
    }),
  })

  if (!response.ok) {
    throw new Error(`Firecrawl request failed: ${response.status}`)
  }

  const payload = await response.json()
  const rows = payload?.data?.[source] || []
  return rows.slice(0, maxResults).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.description || '',
    source: 'firecrawl',
    publishedDate: item.publishedDate || null,
    provider: 'firecrawl',
  }))
}

async function runTavilySearch({ query, type, maxResults }) {
  const locale = inferLocale(query)
  const topic = type === 'news' ? 'news' : 'general'
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      topic,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      country: locale.country === 'KR' ? 'south korea' : 'united states',
    }),
  })

  if (!response.ok) {
    throw new Error(`Tavily request failed: ${response.status}`)
  }

  const payload = await response.json()
  const rows = payload?.results || []
  return rows.slice(0, maxResults).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.content || '',
    source: 'tavily',
    publishedDate: item.published_date || null,
    provider: 'tavily',
  }))
}

export async function runXSearch({ query, maxResults }) {
  const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY
  if (!apiKey) throw new Error('XAI_API_KEY is required for x_search')

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: query }],
      model: 'grok-3',
      stream: false,
      search_parameters: {
        mode: 'auto',
        max_search_results: maxResults,
        return_citations: true,
      },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`x_search failed: ${response.status} ${body}`)
  }

  const payload = await response.json()
  const answer = payload?.choices?.[0]?.message?.content ?? ''
  const citations = payload?.citations ?? []

  return citations.slice(0, maxResults).map((url, i) => ({
    title: `Source ${i + 1}`,
    url,
    snippet: answer.slice(0, 200),
    source: 'x_search',
    provider: 'x_search',
  }))
}

async function searchWithProvider(provider, args) {
  switch (provider) {
    case 'serper':
      return runSerperSearch(args)
    case 'brave':
      return runBraveSearch(args)
    case 'perplexity':
      return runPerplexitySearch(args)
    case 'firecrawl':
      return runFirecrawlSearch(args)
    case 'tavily':
      return runTavilySearch(args)
    case 'x_search':
      return runXSearch(args)
    default:
      throw new Error(`Unsupported raw provider: ${provider}`)
  }
}

function dedupeResults(resultSets) {
  const seen = new Set()
  const merged = []
  for (const resultSet of resultSets) {
    for (const item of resultSet) {
      if (!item.url || seen.has(item.url)) continue
      seen.add(item.url)
      merged.push(item)
    }
  }
  return merged
}

export async function runRawSearch({
  keywords,
  providers,
  site,
  type = 'web',
  maxResults = 5,
  parallel = false,
}) {
  const query = buildQuery(keywords, site)
  if (!query) {
    throw new Error('keywords is required')
  }

  if (!providers?.length) {
    throw new Error('No raw providers are available')
  }

  if (!parallel) {
    const failures = []
    for (const provider of providers) {
      try {
        const results = await searchWithProvider(provider, { query, type, maxResults })
        return {
          mode: 'fallback',
          usedProvider: provider,
          query,
          results,
          failures,
        }
      } catch (error) {
        failures.push({
          provider,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    throw new Error(`All raw providers failed: ${failures.map(item => `${item.provider}: ${item.error}`).join(' | ')}`)
  }

  const settled = await Promise.allSettled(
    providers.map(async provider => {
      try {
        const results = await searchWithProvider(provider, { query, type, maxResults })
        return {
          provider,
          results,
        }
      } catch (error) {
        throw {
          provider,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )

  const providerResults = []
  const failures = []
  for (const row of settled) {
    if (row.status === 'fulfilled') {
      providerResults.push(row.value)
      continue
    }
    failures.push({
      provider: row.reason?.provider || null,
      error: row.reason?.error || (row.reason instanceof Error ? row.reason.message : String(row.reason)),
    })
  }

  if (!providerResults.length) {
    throw new Error(`All parallel raw providers failed: ${failures.map(item => item.error).join(' | ')}`)
  }

  return {
    mode: 'parallel',
    query,
    providerResults,
    failures,
    mergedResults: dedupeResults(providerResults.map(item => item.results)),
  }
}
