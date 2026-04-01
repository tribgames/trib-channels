/**
 * Holiday checker — uses Nager.Date API with local cache + fallback.
 *
 * Cache: {DATA_DIR}/holidays-cache.json (1-month expiry)
 * Fallback: ~/.claude/schedules/holidays.json (manual list)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { DATA_DIR } from './config.js'

const CACHE_FILE = join(DATA_DIR, 'holidays-cache.json')
const FALLBACK_FILE = join(homedir(), '.claude', 'schedules', 'holidays.json')
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 1 month

interface Holiday {
  date: string       // "YYYY-MM-DD"
  localName: string
  name: string
}

interface HolidayCache {
  year: number
  countryCode: string
  fetchedAt: number  // timestamp
  holidays: Holiday[]
}

/** Fetch public holidays from Nager.Date API */
async function fetchHolidays(year: number, countryCode: string): Promise<Holiday[]> {
  const url = `https://date.nager.at/api/v3/publicholidays/${year}/${countryCode}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Nager API ${res.status}: ${res.statusText}`)
  return res.json() as Promise<Holiday[]>
}

/** Load cached holidays, returns null if missing or expired */
function loadCache(year: number, countryCode: string): Holiday[] | null {
  try {
    if (!existsSync(CACHE_FILE)) return null
    const cache: HolidayCache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    if (cache.year !== year || cache.countryCode !== countryCode) return null
    if (Date.now() - cache.fetchedAt > CACHE_MAX_AGE_MS) return null
    return cache.holidays
  } catch {
    return null
  }
}

/** Save holidays to cache */
function saveCache(year: number, countryCode: string, holidays: Holiday[]): void {
  const cache: HolidayCache = { year, countryCode, fetchedAt: Date.now(), holidays }
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
  } catch {
    // non-critical, ignore write errors
  }
}

/** Load fallback holiday dates from ~/.claude/schedules/holidays.json */
function loadFallback(): Set<string> {
  try {
    if (!existsSync(FALLBACK_FILE)) return new Set()
    const data = JSON.parse(readFileSync(FALLBACK_FILE, 'utf8'))
    const dates: string[] = data.holidays ?? []
    return new Set(dates)
  } catch {
    return new Set()
  }
}

/**
 * Check if a given date is a public holiday.
 *
 * Resolution order:
 * 1. Local cache (if fresh)
 * 2. Nager.Date API (fetches + caches)
 * 3. Fallback file (~/.claude/schedules/holidays.json)
 */
export async function isHoliday(date: Date, countryCode: string): Promise<boolean> {
  const year = date.getFullYear()
  const dateStr = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

  // 1. Try cache
  let holidays = loadCache(year, countryCode)

  // 2. Try API
  if (!holidays) {
    try {
      holidays = await fetchHolidays(year, countryCode)
      saveCache(year, countryCode, holidays)
    } catch (err) {
      process.stderr.write(`trib-channels holidays: API fetch failed: ${err}\n`)
      holidays = null
    }
  }

  // 3. Check API/cache result
  if (holidays) {
    return holidays.some(h => h.date === dateStr)
  }

  // 4. Fallback to manual list
  const fallback = loadFallback()
  return fallback.has(dateStr)
}
