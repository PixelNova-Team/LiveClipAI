import axios from 'axios'
import type { BrowserWindow } from 'electron'
import type { PlatformPlugin, LiveInfo } from './types'
import type { PluginMetadata } from '../types/metadata'
import { getLogger } from '../../utils/logger'
import { mt } from '../../i18n'
import { loadCookies, cookiesToString } from '../../utils/cookies'

const logger = getLogger('plugin.huya')

// Metadata for plugin discovery
export const HUYA_PLATFORM_METADATA = {
  label: '虎牙直播',
  label_en: 'Huya Live',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const huyaPlatformMetadata: PluginMetadata = {
  id: 'platform-huya',
  type: 'platform',
  name: 'huya',
  platform: 'huya',
  label: HUYA_PLATFORM_METADATA.label,
  label_en: HUYA_PLATFORM_METADATA.label_en,
  version: HUYA_PLATFORM_METADATA.version,
  description: 'Live streaming platform plugin for Huya',
  enabled: true,
}

const HUYA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.huya.com/',
}

function extractRoomId(url: string): string | null {
  const m = /(?:www\.)?huya\.com\/(\w+)/.exec(url)
  return m ? m[1] : null
}

// 从用户名或房间ID获取房间号码
async function getRoomIdNumber(roomIdOrName: string): Promise<string | null> {
  try {
    // 如果已经是纯数字，直接返回
    if (/^\d+$/.test(roomIdOrName)) {
      return roomIdOrName
    }

    // 从页面中提取房间ID
    const cookies = loadCookies('huya')
    const headers = {
      ...HUYA_HEADERS,
      ...(cookies ? { 'Cookie': cookiesToString(cookies) } : {}),
    }

    const resp = await axios.get(`https://www.huya.com/${roomIdOrName}`, {
      headers,
      timeout: 10000,
    })

    // 从TT_ROOM_DATA中提取roomId: "id":294636272
    const roomDataMatch = /"id"\s*:\s*(\d+)/.exec(resp.data)
    if (roomDataMatch) {
      return roomDataMatch[1]
    }

    return null
  } catch (e) {
    logger.warn(`Failed to extract room number from ${roomIdOrName}: ${e}`)
    return null
  }
}

// 获取虎牙房间信息
async function getHuyaRoomInfo(roomIdOrName: string): Promise<any> {
  const cookies = loadCookies('huya')
  const headers = {
    ...HUYA_HEADERS,
    ...(cookies ? { 'Cookie': cookiesToString(cookies) } : {}),
  }

  const resp = await axios.get(`https://www.huya.com/${roomIdOrName}`, {
    headers,
    timeout: 15000,
  })

  const html = resp.data as string

  // 提取房间信息
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/.exec(html)
  const nickMatch = /"nick"\s*:\s*"([^"]+)"/.exec(html)
  const roomIdMatch = /"id"\s*:\s*(\d+)/.exec(html)
  const isOnMatch = /"isOn"\s*:\s*(true|false)/.exec(html)
  const coverMatch = /"screenshot"\s*:\s*"([^"]+)"/.exec(html)

  // Extract stream URL components
  const flvUrl = /"sFlvUrl"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  const streamName = /"sStreamName"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  const flvSuffix = /"sFlvUrlSuffix"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  const flvAntiCode = /"sFlvAntiCode"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  const hlsUrl = /"sHlsUrl"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  const hlsSuffix = /"sHlsUrlSuffix"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  const hlsAntiCode = /"sHlsAntiCode"\s*:\s*"([^"]+)"/.exec(html)?.[1]

  let streamUrl = ''
  if (flvUrl && streamName && flvSuffix && flvAntiCode) {
    streamUrl = `${flvUrl}/${streamName}.${flvSuffix}?${flvAntiCode}`.replace('http://', 'https://')
  } else if (hlsUrl && streamName && hlsSuffix && hlsAntiCode) {
    streamUrl = `${hlsUrl}/${streamName}.${hlsSuffix}?${hlsAntiCode}`.replace('http://', 'https://')
  }

  return {
    title: titleMatch ? titleMatch[1].replace(/-虎牙直播$/, '').trim() : '',
    author: nickMatch ? nickMatch[1] : '',
    roomId: roomIdMatch ? roomIdMatch[1] : roomIdOrName,
    isOn: isOnMatch ? isOnMatch[1] === 'true' : true,
    coverUrl: coverMatch ? coverMatch[1] : '',
    streamUrl,
  }
}

export const huyaPlatform: PlatformPlugin = {
  name: 'huya',
  label: HUYA_PLATFORM_METADATA.label,
  label_en: HUYA_PLATFORM_METADATA.label_en,
  icon: 'huya',

  validateUrl(url: string): boolean {
    return url.includes('huya.com')
  },

  async getLiveInfo(url: string): Promise<LiveInfo> {
    const roomIdOrName = extractRoomId(url)
    if (!roomIdOrName) throw new Error(mt('error.extractRoomId', { url }))

    const roomInfo = await getHuyaRoomInfo(roomIdOrName)

    return {
      // Use the URL slug (e.g. "chuhe") as roomId, not the numeric ID.
      // The BrowserWindow danmaku approach needs the slug to load the page.
      roomId: roomIdOrName,
      title: roomInfo.title,
      author: roomInfo.author,
      coverUrl: roomInfo.coverUrl,
      platform: 'huya',
    }
  },

  async getStreamUrl(url: string): Promise<string> {
    const roomIdOrName = extractRoomId(url)
    if (!roomIdOrName) throw new Error(mt('error.extractRoomIdShort', { url }))

    const roomInfo = await getHuyaRoomInfo(roomIdOrName)

    if (!roomInfo.isOn) {
      throw new Error(`主播未开播或房间不存在 (roomId: ${roomInfo.roomId})`)
    }

    // Use the real stream URL extracted from page HTML (includes auth tokens)
    if (roomInfo.streamUrl) {
      logger.info(`虎牙: 使用页面提取的流URL: ${roomInfo.streamUrl.substring(0, 100)}...`)
      return roomInfo.streamUrl
    }

    // Fallback (shouldn't happen if page loaded correctly)
    logger.warn('虎牙: 无法从页面提取流URL，使用猜测URL（可能不可用）')
    return `https://livepull.huya.com/hls/${roomInfo.roomId}/playlist.m3u8`
  },

  async isLive(url: string): Promise<boolean> {
    const roomIdOrName = extractRoomId(url)
    if (!roomIdOrName) return false

    try {
      const roomInfo = await getHuyaRoomInfo(roomIdOrName)
      return roomInfo.isOn
    } catch {
      return false
    }
  },

  getLoginUrl(): string | null {
    return 'https://www.huya.com/'
  },

  getHeaders(): Record<string, string> {
    const cookies = loadCookies('huya')
    return {
      ...HUYA_HEADERS,
      ...(cookies ? { 'Cookie': cookiesToString(cookies) } : {}),
    }
  },

  async onLoginSuccess(_win: BrowserWindow): Promise<void> {
    logger.info('[Huya] Login succeeded. Danmaku will use BrowserWindow approach (no token extraction needed).')
  },
}
