import axios from 'axios'
import type { PlatformPlugin, LiveInfo } from './types'
import type { PluginMetadata } from '../types/metadata'
import { getLogger } from '../../utils/logger'
import { mt } from '../../i18n'
import { extractRoomId } from '../../utils/platform-config'
import { loadCookies, cookiesToString } from '../../utils/cookies'

const logger = getLogger('plugin.kuaishou')

export const KUAISHOU_PLATFORM_METADATA = {
  label: '快手直播',
  label_en: 'Kuaishou Live',
  version: '1.0.0',
}

export const kuaishouPlatformMetadata: PluginMetadata = {
  id: 'platform-kuaishou',
  type: 'platform',
  name: 'kuaishou',
  platform: 'kuaishou',
  label: KUAISHOU_PLATFORM_METADATA.label,
  label_en: KUAISHOU_PLATFORM_METADATA.label_en,
  version: KUAISHOU_PLATFORM_METADATA.version,
  description: 'Live streaming platform plugin for Kuaishou',
  enabled: true,
}

function getRoomIdFromUrl(url: string): string | null {
  // Standard URLs: live.kuaishou.com/u/{id} or live.kuaishou.com/live/{id}
  const directMatch = extractRoomId('kuaishou', url)
  if (directMatch) return directMatch

  // Short URLs: v.kuaishou.com/{code} — will be resolved in resolveShortUrl
  return null
}

/**
 * Resolve short URLs (v.kuaishou.com) by following the 302 redirect.
 * The redirect URL format is: /fw/live/{principalId}?...&userId={numericId}&...
 * We extract the principalId from the path (NOT the numeric userId from params,
 * because /u/{numericId} returns error 22 on Kuaishou).
 */
// Cache resolved short URLs permanently (they don't change)
const shortUrlCache = new Map<string, string>()

async function resolveShortUrl(url: string): Promise<string | null> {
  if (!url.includes('v.kuaishou.com')) return null

  const cached = shortUrlCache.get(url)
  if (cached) return cached

  try {
    const resp = await axios.head(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      maxRedirects: 0,
      validateStatus: (s) => s >= 300 && s < 400,
      timeout: 10000,
    })
    const location = resp.headers['location'] || ''
    if (!location) {
      logger.warn('[Kuaishou] Short URL redirect has no Location header')
      return null
    }

    // Priority 1: Extract principalId from path /fw/live/{principalId}
    const pathMatch = location.match(/\/fw\/live\/([a-zA-Z0-9_-]+)/)
    if (pathMatch) {
      logger.info(`[Kuaishou] Resolved short URL: principalId=${pathMatch[1]}`)
      shortUrlCache.set(url, pathMatch[1])
      return pathMatch[1]
    }

    // Priority 2: /u/{principalId} pattern
    const uMatch = location.match(/\/u\/([a-zA-Z0-9_-]+)/)
    if (uMatch) {
      logger.info(`[Kuaishou] Resolved short URL: principalId=${uMatch[1]}`)
      shortUrlCache.set(url, uMatch[1])
      return uMatch[1]
    }

    logger.warn(`[Kuaishou] Cannot extract principalId from redirect: ${location.substring(0, 200)}`)
    return null
  } catch (e: any) {
    logger.warn(`[Kuaishou] Failed to resolve short URL: ${e.message}`)
    return null
  }
}

function getKSHeaders(): Record<string, string> {
  const cookies = loadCookies('kuaishou')
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://live.kuaishou.com/',
    ...(cookies.length ? { 'Cookie': cookiesToString(cookies) } : {}),
  }
}

// ─── Result cache ───

interface CachedResult { data: any; timestamp: number }
const cache = new Map<string, CachedResult>()
const CACHE_TTL = 180_000  // 3 minutes — Kuaishou rate-limits aggressively

function getCached(roomId: string): any | null {
  const entry = cache.get(roomId)
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data
  return null
}

/** Get stale cache (up to 30 min old) — used as fallback when rate-limited */
function getStaleCached(roomId: string): any | null {
  const entry = cache.get(roomId)
  if (entry && Date.now() - entry.timestamp < 1800_000) return entry.data
  return null
}

function setCache(roomId: string, data: any): void {
  cache.set(roomId, { data, timestamp: Date.now() })
}

// ─── HTML-based data extraction (fast, no BrowserWindow) ───

/**
 * Fetch the live page HTML and parse __INITIAL_STATE__ from server-rendered content.
 *
 * This is the most reliable method because:
 * 1. REST API (/live_api/liveroom/livedetail) returns result=2 for many rooms
 * 2. __INITIAL_STATE__ is server-rendered — no SPA hydration needed
 * 3. No BrowserWindow popup, much faster (~1-2s vs 15-20s)
 *
 * Key field mappings (Kuaishou-specific):
 * - Live status: playList[].isLiving (NOT author.living which can be false even when live)
 * - Cover image: liveStream.poster (NOT coverUrl)
 * - Stream title: gameInfo.name or author.description (NOT caption)
 */
function parseInitialState(html: string): any | null {
  const marker = '__INITIAL_STATE__='
  const idx = html.indexOf(marker)
  if (idx < 0) return null

  const start = idx + marker.length
  // Find the end — the script self-removes with (function(){...})()
  // The JSON ends at the first ";(" pattern
  let depth = 0
  let inString = false
  let escape = false
  let end = start

  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"' && !escape) { inString = !inString; continue }
    if (inString) continue
    if (ch === '{' || ch === '[') depth++
    if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }

  if (end <= start) return null

  try {
    let jsonStr = html.substring(start, end)
    // Kuaishou's __INITIAL_STATE__ is JavaScript, not strict JSON:
    // - Contains `undefined` as values (not valid JSON, replace with null)
    // - Only replace when it appears as a value (after : or , or [), not inside strings
    jsonStr = jsonStr.replace(/([:,\[]\s*)undefined\b/g, '$1null')
    return JSON.parse(jsonStr)
  } catch (e: any) {
    logger.warn(`[Kuaishou] Failed to parse __INITIAL_STATE__: ${e.message}`)
    return null
  }
}

function extractFromInitialState(state: any, roomId: string): any | null {
  const lr = state?.liveroom
  if (!lr) return null

  const playList = lr.playList
  if (playList && playList.length > 0) {
    const idx = lr.activeIndex || 0
    const item = playList[idx] || playList[0]
    if (!item) return null

    // CRITICAL: Detect rate-limit response BEFORE using the data.
    // When Kuaishou rate-limits, it returns errorType.type=2 with "请求过快".
    // The data in this response is INVALID (isLiving=false, empty author, no stream).
    // We must return null so the caller can use cached/fallback data instead.
    const errorType = item.errorType
    if (errorType && (errorType.type === 2 || (errorType.title && errorType.title.includes('请求过快')))) {
      logger.warn(`[Kuaishou] Rate-limited response detected for ${roomId}: ${JSON.stringify(errorType)}`)
      return null  // Signal caller to use fallback
    }

    const author = item.author || item.authorInfo || {}
    const stream = item.liveStream || {}
    const gameInfo = item.gameInfo || {}

    // CRITICAL: Use item.isLiving, NOT author.living
    // Kuaishou sets author.living=false even when the room is live (for event/team rooms)
    let isLiving = item.isLiving
    if (isLiving === undefined) isLiving = author.living
    if (isLiving === undefined) isLiving = item.living

    // Cover: Kuaishou uses 'poster', not 'coverUrl'
    const coverUrl = stream.poster || stream.coverUrl || item.poster || item.coverUrl || ''

    // Title: try caption first, then game name
    const caption = stream.caption || item.caption || gameInfo.name || ''

    const errStr = errorType ? JSON.stringify(errorType) : 'none'
    const status = item.status ? JSON.stringify(item.status) : 'none'
    logger.info(`[Kuaishou] Parsed from __INITIAL_STATE__: isLiving=${isLiving}, name=${author.name}, cover=${coverUrl ? 'yes' : 'no'}, caption=${caption}, errorType=${errStr}, status=${status}`)

    return {
      author: {
        living: !!isLiving,
        name: author.name || author.nickName || author.user_name || roomId,
      },
      liveStream: {
        caption,
        coverUrl,
        playUrls: stream.playUrls || item.playUrls || {},
      },
    }
  }

  // Fallback: try old liveroom.author path
  if (lr.author && typeof lr.author.living === 'boolean') {
    const stream = lr.liveStream || {}
    return {
      author: { living: lr.author.living, name: lr.author.name || roomId },
      liveStream: {
        caption: stream.caption || '',
        coverUrl: stream.poster || stream.coverUrl || '',
        playUrls: stream.playUrls || {},
      },
    }
  }

  return null
}

async function fetchLiveDetailViaHtml(roomId: string): Promise<any> {
  logger.info(`[Kuaishou] Fetching live detail via HTML for ${roomId}`)

  try {
    const liveUrl = `https://live.kuaishou.com/u/${roomId}`
    // IMPORTANT: Do NOT send cookies for status check.
    // Kuaishou returns broken data (isLiving=false, errorType present, empty author)
    // for some rooms when cookies are included. The public page without cookies
    // returns correct server-rendered data with full live status and stream URLs.
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://live.kuaishou.com/',
      'Accept': 'text/html,application/xhtml+xml',
    }
    let resp: any
    try {
      // Try with system proxy first
      resp = await axios.get(liveUrl, { headers, timeout: 10000, maxRedirects: 3 })
    } catch {
      // Fallback to direct connection if proxy fails
      logger.info('[Kuaishou] Proxy failed, trying direct connection')
      resp = await axios.get(liveUrl, { headers, timeout: 10000, maxRedirects: 3, proxy: false })
    }

    const html = typeof resp.data === 'string' ? resp.data : ''
    logger.info(`[Kuaishou] HTML response: status=${resp.status}, length=${html.length}`)
    if (!html) {
      logger.warn('[Kuaishou] Empty HTML response')
      return null
    }

    const state = parseInitialState(html)
    if (!state) {
      logger.warn(`[Kuaishou] __INITIAL_STATE__ not found in HTML (has marker: ${html.includes('__INITIAL_STATE__')})`)
      return null
    }

    return extractFromInitialState(state, roomId)
  } catch (e: any) {
    logger.warn(`[Kuaishou] HTML fetch failed: ${e.message}`)
    return null
  }
}

// ─── Main fetch function ───

async function fetchLiveDetail(roomId: string): Promise<any> {
  // Check cache first
  const cached = getCached(roomId)
  if (cached !== null) return cached

  // Primary method: parse __INITIAL_STATE__ from HTML (fast, reliable)
  const htmlData = await fetchLiveDetailViaHtml(roomId)
  if (htmlData) {
    setCache(roomId, htmlData)
    return htmlData
  }

  // htmlData is null — could be rate-limited. Use stale cache if available.
  const stale = getStaleCached(roomId)
  if (stale) {
    logger.info(`[Kuaishou] Using stale cache for ${roomId} (rate-limited or fetch failed)`)
    return stale
  }

  // Fallback: REST API (works for some simple rooms)
  try {
    const resp = await axios.get(
      `https://live.kuaishou.com/live_api/liveroom/livedetail?principalId=${roomId}`,
      { headers: getKSHeaders(), timeout: 10000, proxy: false },
    )
    const data = resp.data?.data
    logger.info(`[Kuaishou] REST API fallback: living=${data?.author?.living}, name=${data?.author?.name}, result=${data?.result}`)

    if (data?.result === 1 && data?.author?.living !== undefined) {
      // Fix coverUrl field: REST API may also use poster
      if (data.liveStream && !data.liveStream.coverUrl && data.liveStream.poster) {
        data.liveStream.coverUrl = data.liveStream.poster
      }
      setCache(roomId, data)
      return data
    }
  } catch { /* fall through */ }

  logger.warn(`[Kuaishou] All methods failed for room ${roomId}`)
  return null
}

// ─── Platform plugin ───

export const kuaishouPlatform: PlatformPlugin = {
  name: 'kuaishou',
  label: KUAISHOU_PLATFORM_METADATA.label,
  label_en: KUAISHOU_PLATFORM_METADATA.label_en,
  icon: 'kuaishou',

  validateUrl(url: string): boolean {
    return url.includes('kuaishou.com')
  },

  async getLiveInfo(url: string): Promise<LiveInfo> {
    let roomId = getRoomIdFromUrl(url)
    // Support short URLs: v.kuaishou.com/{code}
    if (!roomId) roomId = await resolveShortUrl(url)
    if (!roomId) throw new Error(mt('error.extractRoomId', { url }))

    const data = await fetchLiveDetail(roomId)
    if (!data) throw new Error(`Cannot get live info for ${roomId}`)

    return {
      roomId,
      title: data.liveStream?.caption || '',
      author: data.author?.name || roomId,
      coverUrl: data.liveStream?.coverUrl || '',
      platform: 'kuaishou',
    }
  },

  async getStreamUrl(url: string): Promise<string> {
    let roomId = getRoomIdFromUrl(url)
    if (!roomId) roomId = await resolveShortUrl(url)
    if (!roomId) throw new Error(mt('error.extractRoomIdShort', { url }))

    const data = await fetchLiveDetail(roomId)
    if (!data?.author?.living) throw new Error(`主播未开播 (${roomId})`)

    const playUrls = data.liveStream?.playUrls
    const h264 = playUrls?.h264
    const hevc = playUrls?.hevc

    const reps = h264?.adaptationSet?.representation || hevc?.adaptationSet?.representation || []
    if (reps.length > 0 && reps[0].url) {
      logger.info('快手直播流获取成功')
      return reps[0].url
    }

    const main = h264?.main || hevc?.main || []
    if (main.length > 0 && main[0].url) {
      logger.info('快手直播流获取成功 (main)')
      return main[0].url
    }

    throw new Error(`房间 ${roomId} 无可用直播流`)
  },

  async isLive(url: string): Promise<boolean> {
    let roomId = getRoomIdFromUrl(url)
    if (!roomId) roomId = await resolveShortUrl(url)
    if (!roomId) return false
    try {
      const data = await fetchLiveDetail(roomId)
      return data?.author?.living === true
    } catch {
      return false
    }
  },

  getLoginUrl(): string {
    return 'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.live.web&callback=https%3A%2F%2Flive.kuaishou.com%2F'
  },

  getHeaders(): Record<string, string> {
    return getKSHeaders()
  },
}
