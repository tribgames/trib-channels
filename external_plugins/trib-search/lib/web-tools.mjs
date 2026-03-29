import fs from 'fs'
import { JSDOM } from 'jsdom'
import puppeteer from 'puppeteer-core'
import { Readability } from '@mozilla/readability'
import {
  noteProviderFailure,
  noteProviderSuccess,
  rankScrapeExtractors,
  rememberPreferredScrapeExtractor,
} from './state.mjs'

const DEFAULT_EXTRACTORS = ['readability', 'puppeteer', 'firecrawl']

const COMMON_BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

export function getScrapeCapabilities() {
  const browserAvailable = Boolean(
    (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) ||
    COMMON_BROWSER_PATHS.some(item => fs.existsSync(item)),
  )

  return {
    readability: true,
    puppeteer: browserAvailable,
    firecrawl: Boolean(process.env.FIRECRAWL_API_KEY),
  }
}

function normalizeUrl(url) {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

function withTimeout(controller, timeoutMs) {
  return setTimeout(() => controller.abort(), timeoutMs)
}

function buildHeaders() {
  return {
    'User-Agent': 'trib-search/0.0.1',
    'Accept-Language': 'ko,en;q=0.8',
  }
}

function buildContentPayload(url, title, content, extractor, extra = {}) {
  const normalized = (content || '').trim()
  if (!normalized) {
    throw new Error(`${extractor} returned empty content`)
  }
  return {
    url,
    title: (title || '').trim(),
    content: normalized,
    excerpt: normalized.slice(0, 240),
    extractor,
    ...extra,
  }
}

function extractReadableArticle(url, html) {
  const dom = new JSDOM(html, { url })
  const reader = new Readability(dom.window.document)
  const article = reader.parse()
  if (article?.textContent?.trim()) {
    return buildContentPayload(
      url,
      article.title || dom.window.document.title || '',
      article.textContent,
      'readability',
    )
  }

  const bodyText = dom.window.document.body?.textContent?.trim() || ''
  if (!bodyText) {
    throw new Error('readability returned no readable body')
  }

  return buildContentPayload(
    url,
    dom.window.document.title || '',
    bodyText,
    'dom-text',
  )
}

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController()
  const timer = withTimeout(controller, timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: buildHeaders(),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function scrapeWithReadability(url, timeoutMs) {
  const html = await fetchHtml(url, timeoutMs)
  return extractReadableArticle(url, html)
}

function resolveBrowserLaunchOptions() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
  }

  for (const executablePath of COMMON_BROWSER_PATHS) {
    if (fs.existsSync(executablePath)) {
      return { executablePath }
    }
  }

  return { channel: 'chrome' }
}

async function scrapeWithPuppeteer(url, timeoutMs) {
  let browser
  try {
    browser = await puppeteer.launch({
      headless: true,
      ...resolveBrowserLaunchOptions(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
  } catch (error) {
    throw new Error(`puppeteer launch failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const page = await browser.newPage()
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ko,en;q=0.8',
    })
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: timeoutMs,
    })
    const html = await page.content()
    try {
      return {
        ...extractReadableArticle(url, html),
        extractor: 'puppeteer',
      }
    } catch {
      const bodyText = await page.evaluate(() => document.body?.innerText || '')
      return buildContentPayload(url, await page.title(), bodyText, 'puppeteer')
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function scrapeWithFirecrawl(url, timeoutMs) {
  if (!process.env.FIRECRAWL_API_KEY) {
    throw new Error('FIRECRAWL_API_KEY is not configured')
  }

  const controller = new AbortController()
  const timer = withTimeout(controller, timeoutMs)
  try {
    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        timeout: timeoutMs,
      }),
    })

    if (!response.ok) {
      throw new Error(`Firecrawl scrape failed: ${response.status}`)
    }

    const payload = await response.json()
    const markdown = payload?.data?.markdown || payload?.markdown || ''
    const title = payload?.data?.metadata?.title || payload?.metadata?.title || ''
    return buildContentPayload(url, title, markdown, 'firecrawl')
  } finally {
    clearTimeout(timer)
  }
}

async function tryExtractor(extractor, url, timeoutMs) {
  switch (extractor) {
    case 'readability':
      return scrapeWithReadability(url, timeoutMs)
    case 'puppeteer':
      return scrapeWithPuppeteer(url, timeoutMs)
    case 'firecrawl':
      return scrapeWithFirecrawl(url, timeoutMs)
    default:
      throw new Error(`Unknown extractor: ${extractor}`)
  }
}

function filterLinks(rawLinks, baseUrl, { limit = 50, sameDomainOnly = true, search }) {
  const originHost = new URL(baseUrl).host
  const items = []
  const seen = new Set()

  for (const rawLink of rawLinks) {
    const href = rawLink?.href
    if (!href) continue

    let absolute
    try {
      absolute = normalizeUrl(new URL(href, baseUrl).toString())
    } catch {
      continue
    }

    if (sameDomainOnly && new URL(absolute).host !== originHost) {
      continue
    }

    const text = (rawLink.text || '').trim()
    if (search && !absolute.includes(search) && !text.includes(search)) {
      continue
    }

    if (seen.has(absolute)) continue
    seen.add(absolute)
    items.push({ url: absolute, text })
    if (items.length >= limit) break
  }

  return items
}

function extractLinksFromHtml(baseUrl, html, options) {
  const dom = new JSDOM(html, { url: baseUrl })
  const links = Array.from(dom.window.document.querySelectorAll('a[href]')).map(link => ({
    href: link.getAttribute('href'),
    text: link.textContent || '',
  }))
  return filterLinks(links, baseUrl, options)
}

async function mapWithHttp(url, options, timeoutMs) {
  const html = await fetchHtml(url, timeoutMs)
  return extractLinksFromHtml(url, html, options)
}

async function mapWithPuppeteer(url, options, timeoutMs) {
  let browser
  try {
    browser = await puppeteer.launch({
      headless: true,
      ...resolveBrowserLaunchOptions(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: timeoutMs,
    })
    const links = await page.$$eval('a[href]', nodes => nodes.map(node => ({
      href: node.getAttribute('href'),
      text: node.textContent || '',
    })))
    return filterLinks(links, url, options)
  } finally {
    await browser?.close().catch(() => {})
  }
}

export async function scrapeUrl(url, timeoutMs, usageState) {
  const normalizedUrl = normalizeUrl(url)
  const host = new URL(normalizedUrl).host
  const extractors = rankScrapeExtractors(host, usageState, DEFAULT_EXTRACTORS)
  const failures = []

  for (const extractor of extractors) {
    try {
      const page = await tryExtractor(extractor, normalizedUrl, timeoutMs)
      rememberPreferredScrapeExtractor(usageState, host, extractor)
      noteProviderSuccess(usageState, extractor)
      return {
        ...page,
        triedExtractors: extractors,
        failures,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ extractor, error: message })
      noteProviderFailure(usageState, extractor, message, 60000)
    }
  }

  throw new Error(`All extractors failed for ${normalizedUrl}: ${failures.map(item => `${item.extractor}: ${item.error}`).join(' | ')}`)
}

export async function scrapeUrls(urls, timeoutMs, usageState) {
  return Promise.all(urls.map(url => scrapeUrl(url, timeoutMs, usageState)))
}

export async function mapSite(url, { limit = 50, sameDomainOnly = true, search }, timeoutMs) {
  const options = { limit, sameDomainOnly, search }
  try {
    const links = await mapWithHttp(url, options, timeoutMs)
    if (links.length > 0) {
      return links
    }
  } catch {
    // fall through to puppeteer
  }

  return mapWithPuppeteer(url, options, timeoutMs)
}

export async function crawlSite(
  startUrl,
  { maxPages = 10, maxDepth = 1, sameDomainOnly = true },
  timeoutMs,
  usageState,
) {
  const visited = new Set()
  const queue = [{ url: normalizeUrl(startUrl), depth: 0 }]
  const pages = []

  while (queue.length > 0 && pages.length < maxPages) {
    const current = queue.shift()
    if (!current || visited.has(current.url)) continue
    visited.add(current.url)

    try {
      const page = await scrapeUrl(current.url, timeoutMs, usageState)
      pages.push({
        url: current.url,
        depth: current.depth,
        title: page.title,
        excerpt: page.excerpt,
        extractor: page.extractor,
      })
    } catch (error) {
      pages.push({
        url: current.url,
        depth: current.depth,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (current.depth >= maxDepth) {
      continue
    }

    let links = []
    try {
      links = await mapSite(
        current.url,
        {
          limit: maxPages,
          sameDomainOnly,
        },
        timeoutMs,
      )
    } catch {
      links = []
    }

    for (const link of links) {
      if (!visited.has(link.url)) {
        queue.push({
          url: link.url,
          depth: current.depth + 1,
        })
      }
    }
  }

  return pages
}
