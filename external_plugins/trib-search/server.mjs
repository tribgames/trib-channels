#!/usr/bin/env node

if (process.env.TRIB_SEARCH_SPAWNED) process.exit(0)

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { ensureDataDir, loadConfig } from './lib/config.mjs'
import { loadSettings } from './lib/settings.mjs'
import {
  loadUsageState,
  noteProviderFailure,
  noteProviderSuccess,
  rankProviders,
  rememberPreferredRawProviders,
  saveUsageState,
  updateProviderState,
} from './lib/state.mjs'
import { getAvailableRawProviders, RAW_PROVIDER_IDS, runRawSearch } from './lib/providers.mjs'
import { AI_PROVIDER_IDS, getAvailableAiProviders, runAiSearch } from './lib/ai-providers.mjs'
import { crawlSite, getScrapeCapabilities, mapSite, scrapeUrls } from './lib/web-tools.mjs'

ensureDataDir()

// Unified search schema — query accepts string or array for parallel execution
const searchArgsSchema = z.object({
  query: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  site: z.string().optional(),
  type: z.enum(['web', 'news', 'images']).optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
})

const ghSearchArgsSchema = z.object({
  query: z.string().min(1),
  language: z.string().optional(),
  repo: z.string().optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
})

const scrapeArgsSchema = z.object({
  urls: z.array(z.string().url()).min(1),
})

const mapArgsSchema = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(200).optional(),
  sameDomainOnly: z.boolean().optional(),
  search: z.string().optional(),
})

const crawlArgsSchema = z.object({
  url: z.string().url(),
  maxPages: z.number().int().min(1).max(200).optional(),
  maxDepth: z.number().int().min(0).max(5).optional(),
  sameDomainOnly: z.boolean().optional(),
})

function jsonText(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}

async function writeStartupSnapshot() {
  const usageState = loadUsageState()
  const rawProviders = getAvailableRawProviders()
  const aiProviders = await getAvailableAiProviders()
  const scrapeCapabilities = getScrapeCapabilities()

  for (const provider of rawProviders) {
    updateProviderState(usageState, provider, {
      available: true,
      connection: 'api',
      source: 'env',
    })
  }

  const config = loadConfig()
  for (const provider of aiProviders) {
    updateProviderState(usageState, provider, {
      available: true,
      connection:
        provider === 'grok' && config.grokApiKey
          ? 'api'
          : 'cli',
      source:
        provider === 'grok' && config.grokApiKey
          ? 'config'
          : 'binary',
    })
  }

  updateProviderState(usageState, 'readability', {
    available: scrapeCapabilities.readability,
    connection: 'builtin',
    source: 'local',
  })

  updateProviderState(usageState, 'puppeteer', {
    available: scrapeCapabilities.puppeteer,
    connection: 'local-browser',
    source: 'local',
  })

  updateProviderState(usageState, 'firecrawl-extractor', {
    available: scrapeCapabilities.firecrawl,
    connection: 'api',
    source: 'env',
  })
}

// --- Unified search: raw + ai combined with searchMode routing ---

async function runSingleSearch(query, config, usageState, options = {}) {
  const site = options.site
  const type = options.type
  const maxResults = options.maxResults || config.rawMaxResults
  const searchMode = config.searchMode || 'search-first'
  const results = { query, searchMode, raw: null, ai: null, errors: [] }

  // x.com always routes to grok x_search
  if (site === 'x.com') {
    try {
      const response = await runAiSearch({
        query,
        provider: 'grok',
        site,
        model: config.aiModels?.grok || null,
        timeoutMs: config.aiTimeoutMs,
      })
      noteProviderSuccess(usageState, 'grok')
      results.ai = { provider: 'grok', ...response }
    } catch (e) {
      noteProviderFailure(usageState, 'grok', e.message, 60000)
      results.errors.push({ provider: 'grok', error: e.message })
    }
    return results
  }

  const doRawSearch = async () => {
    const available = getAvailableRawProviders()
    const providers = rankProviders(
      config.rawProviders.filter(p => available.includes(p)),
      usageState,
      site,
    )
    if (!providers.length) return null
    try {
      const response = await runRawSearch({
        keywords: query,
        providers,
        site,
        type,
        maxResults,
        parallel: false,
      })
      if (response.mode === 'fallback') {
        noteProviderSuccess(usageState, response.usedProvider)
        for (const f of response.failures || []) noteProviderFailure(usageState, f.provider, f.error, 60000)
        if (site) rememberPreferredRawProviders(usageState, site, [response.usedProvider, ...providers.filter(p => p !== response.usedProvider)])
      } else {
        for (const row of response.providerResults) noteProviderSuccess(usageState, row.provider)
        for (const f of response.failures || []) if (f.provider) noteProviderFailure(usageState, f.provider, f.error, 60000)
        if (site) rememberPreferredRawProviders(usageState, site, response.providerResults.map(r => r.provider))
      }
      return response
    } catch (e) {
      results.errors.push({ source: 'raw', error: e.message })
      return null
    }
  }

  const doAiSearch = async () => {
    const available = await getAvailableAiProviders()
    const provider = config.aiDefaultProvider
    if (!available.includes(provider)) {
      // fallback chain
      const chain = AI_PROVIDER_IDS.filter(p => available.includes(p))
      if (!chain.length) return null
      for (const fallback of chain) {
        try {
          const response = await runAiSearch({
            query,
            provider: fallback,
            site,
            model: config.aiModels?.[fallback] || null,
            timeoutMs: config.aiTimeoutMs,
          })
          noteProviderSuccess(usageState, fallback)
          return { provider: fallback, ...response }
        } catch (e) {
          noteProviderFailure(usageState, fallback, e.message, 60000)
          results.errors.push({ provider: fallback, error: e.message })
        }
      }
      return null
    }
    try {
      const response = await runAiSearch({
        query,
        provider,
        site,
        model: config.aiModels?.[provider] || null,
        timeoutMs: config.aiTimeoutMs,
      })
      noteProviderSuccess(usageState, provider)
      return { provider, ...response }
    } catch (e) {
      noteProviderFailure(usageState, provider, e.message, 60000)
      results.errors.push({ provider, error: e.message })
      return null
    }
  }

  if (searchMode === 'ai-first') {
    results.ai = await doAiSearch()
    if (!results.ai) results.raw = await doRawSearch()
  } else {
    results.raw = await doRawSearch()
    if (!results.raw?.results?.length) results.ai = await doAiSearch()
  }

  return results
}

// --- GitHub code search ---

async function runGhSearch(query, options = {}) {
  const { spawn } = await import('child_process')
  const args = ['api', 'search/code', '-q', query]
  if (options.language) args.push('--jq', `.items | map(select(.language == "${options.language}"))`)
  if (options.repo) args[3] = `${query} repo:${options.repo}`
  const limit = options.maxResults || 10
  args.push('--jq', `.items[:${limit}] | map({repo: .repository.full_name, path: .path, url: .html_url, score: .score})`)

  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('gh search timed out')) }, 30000)
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('exit', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`gh exited ${code}: ${stderr.trim()}`))
      try { resolve(JSON.parse(stdout)) } catch { resolve([]) }
    })
  })
}

// --- Tool definitions ---

const toolDefinitions = [
  {
    name: 'search',
    description: 'Run web search. Single query or array for parallel. Routes through raw search and AI search based on configured searchMode.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        site: { type: 'string' },
        type: { type: 'string', enum: ['web', 'news', 'images'] },
        maxResults: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gh_search',
    description: 'Search GitHub code repositories.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        language: { type: 'string' },
        repo: { type: 'string' },
        maxResults: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  {
    name: 'scrape',
    description: 'Fetch and extract readable content from known URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string', format: 'uri' },
        },
      },
      required: ['urls'],
    },
  },
  {
    name: 'map',
    description: 'Discover links from a page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        limit: { type: 'integer' },
        sameDomainOnly: { type: 'boolean' },
        search: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'crawl',
    description: 'Traverse links from a starting URL and collect page summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        maxPages: { type: 'integer' },
        maxDepth: { type: 'integer' },
        sameDomainOnly: { type: 'boolean' },
      },
      required: ['url'],
    },
  },
]

const bundledSettings = loadSettings()

const server = new Server(
  {
    name: 'trib-search',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: bundledSettings,
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}))

server.setRequestHandler(CallToolRequestSchema, async request => {
  const config = loadConfig()
  const usageState = loadUsageState()
  const timeoutMs = config.requestTimeoutMs

  switch (request.params.name) {
    case 'search': {
      const args = searchArgsSchema.parse(request.params.arguments || {})
      const queries = Array.isArray(args.query) ? args.query : [args.query]

      if (queries.length === 1) {
        const result = await runSingleSearch(queries[0], config, usageState, {
          site: args.site,
          type: args.type,
          maxResults: args.maxResults,
        })
        saveUsageState(usageState)
        return jsonText({ tool: 'search', ...result })
      }

      // Parallel execution
      const results = await Promise.all(
        queries.map(q => runSingleSearch(q, config, usageState, {
          site: args.site,
          type: args.type,
          maxResults: args.maxResults,
        })),
      )
      saveUsageState(usageState)
      return jsonText({ tool: 'search', parallel: true, results })
    }

    case 'gh_search': {
      const args = ghSearchArgsSchema.parse(request.params.arguments || {})
      try {
        const results = await runGhSearch(args.query, {
          language: args.language,
          repo: args.repo,
          maxResults: args.maxResults,
        })
        return jsonText({ tool: 'gh_search', query: args.query, results })
      } catch (error) {
        return jsonText({
          tool: 'gh_search',
          query: args.query,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    case 'scrape': {
      const args = scrapeArgsSchema.parse(request.params.arguments || {})
      const pages = await scrapeUrls(args.urls, timeoutMs, usageState)
      updateProviderState(usageState, 'scrape', {
        lastUsedAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
      })
      return jsonText({ tool: 'scrape', pages })
    }

    case 'map': {
      const args = mapArgsSchema.parse(request.params.arguments || {})
      const links = await mapSite(
        args.url,
        {
          limit: args.limit || 50,
          sameDomainOnly: args.sameDomainOnly ?? true,
          search: args.search,
        },
        timeoutMs,
      )
      return jsonText({ tool: 'map', links })
    }

    case 'crawl': {
      const args = crawlArgsSchema.parse(request.params.arguments || {})
      const pages = await crawlSite(
        args.url,
        {
          maxPages: args.maxPages || config.crawl.maxPages,
          maxDepth: args.maxDepth ?? config.crawl.maxDepth,
          sameDomainOnly: args.sameDomainOnly ?? config.crawl.sameDomainOnly,
        },
        timeoutMs,
        usageState,
      )
      saveUsageState(usageState)
      return jsonText({ tool: 'crawl', pages })
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`)
  }
})

const transport = new StdioServerTransport()
await writeStartupSnapshot()
await server.connect(transport)
