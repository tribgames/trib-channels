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

const searchArgsSchema = z.object({
  keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  providers: z.array(z.enum(RAW_PROVIDER_IDS)).optional(),
  site: z.string().optional(),
  type: z.enum(['web', 'news', 'images']).optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
})

const aiSearchArgsSchema = z.object({
  query: z.string().min(1),
  provider: z.enum(AI_PROVIDER_IDS).optional(),
  model: z.string().optional(),
  site: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
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

function buildInputSchema(schema) {
  return schema
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

const toolDefinitions = [
  {
    name: 'search',
    description: 'Run raw web search. If providers is omitted, configured priority fallback is used. If providers has multiple values, they run in parallel.',
    inputSchema: buildInputSchema({
      type: 'object',
      properties: {
        keywords: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        providers: {
          type: 'array',
          items: { type: 'string', enum: RAW_PROVIDER_IDS },
        },
        site: { type: 'string' },
        type: { type: 'string', enum: ['web', 'news', 'images'] },
        maxResults: { type: 'integer' },
      },
      required: ['keywords'],
    }),
  },
  {
    name: 'ai_search',
    description: 'Run AI search through configured providers. x.com is only supported by grok.',
    inputSchema: buildInputSchema({
      type: 'object',
      properties: {
        query: { type: 'string' },
        provider: { type: 'string', enum: AI_PROVIDER_IDS },
        model: { type: 'string' },
        site: { type: 'string' },
        timeoutMs: { type: 'integer' },
      },
      required: ['query'],
    }),
  },
  {
    name: 'scrape',
    description: 'Fetch and extract readable content from known URLs.',
    inputSchema: buildInputSchema({
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string', format: 'uri' },
        },
      },
      required: ['urls'],
    }),
  },
  {
    name: 'map',
    description: 'Discover links from a page.',
    inputSchema: buildInputSchema({
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        limit: { type: 'integer' },
        sameDomainOnly: { type: 'boolean' },
        search: { type: 'string' },
      },
      required: ['url'],
    }),
  },
  {
    name: 'crawl',
    description: 'Traverse links from a starting URL and collect page summaries.',
    inputSchema: buildInputSchema({
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        maxPages: { type: 'integer' },
        maxDepth: { type: 'integer' },
        sameDomainOnly: { type: 'boolean' },
      },
      required: ['url'],
    }),
  },
]

const bundledSettings = loadSettings()

const server = new Server(
  {
    name: 'trib-search',
    version: '0.0.6',
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
      const available = getAvailableRawProviders()
      const parallel = Boolean(args.providers?.length && args.providers.length > 1)
      const providers = args.providers?.length
        ? args.providers
        : rankProviders(
            config.rawProviders.filter(provider => available.includes(provider)),
            usageState,
            args.site,
          )

      if (!providers.length) {
        return jsonText({
          error: 'No raw search provider is available. Set SERPER_API_KEY or BRAVE_API_KEY.',
          availableProviders: available,
        })
      }

      try {
        const response = await runRawSearch({
          ...args,
          providers,
          maxResults: args.maxResults || config.rawMaxResults,
          parallel,
        })

        if (response.mode === 'fallback') {
          noteProviderSuccess(usageState, response.usedProvider)
          for (const failure of response.failures || []) {
            noteProviderFailure(usageState, failure.provider, failure.error, 60000)
          }
          if (args.site) {
            rememberPreferredRawProviders(usageState, args.site, [response.usedProvider, ...providers.filter(item => item !== response.usedProvider)])
          }
        } else {
          for (const row of response.providerResults) {
            noteProviderSuccess(usageState, row.provider)
          }
          for (const failure of response.failures || []) {
            if (!failure.provider) continue
            noteProviderFailure(usageState, failure.provider, failure.error, 60000)
          }
          if (args.site) {
            rememberPreferredRawProviders(usageState, args.site, response.providerResults.map(row => row.provider))
          }
        }

        return jsonText({
          tool: 'search',
          providers,
          response,
        })
      } catch (error) {
        for (const provider of providers) {
          noteProviderFailure(usageState, provider, error instanceof Error ? error.message : String(error), 60000)
        }
        return jsonText({
          tool: 'search',
          error: error instanceof Error ? error.message : String(error),
          providers,
        })
      }
    }

    case 'ai_search': {
      const args = aiSearchArgsSchema.parse(request.params.arguments || {})
      const available = await getAvailableAiProviders()
      const provider = args.site === 'x.com'
        ? 'grok'
        : (args.provider || config.aiDefaultProvider)
      const model = args.model || config.aiModels?.[provider] || null

      if (!available.includes(provider)) {
        return jsonText({
          error: `Provider ${provider} is not available.`,
          availableProviders: available,
        })
      }

      try {
        const response = await runAiSearch({
          query: args.query,
          provider,
          site: args.site,
          model,
          timeoutMs: args.timeoutMs || config.aiTimeoutMs,
        })
        noteProviderSuccess(usageState, provider)
        return jsonText({
          tool: 'ai_search',
          site: args.site || null,
          provider,
          model,
          response,
        })
      } catch (error) {
        noteProviderFailure(usageState, provider, error instanceof Error ? error.message : String(error), 60000)
        return jsonText({
          tool: 'ai_search',
          provider,
          model,
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
      return jsonText({
        tool: 'scrape',
        pages,
      })
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
      return jsonText({
        tool: 'map',
        links,
      })
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
      return jsonText({
        tool: 'crawl',
        pages,
      })
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`)
  }
})

const transport = new StdioServerTransport()
await writeStartupSnapshot()
await server.connect(transport)
