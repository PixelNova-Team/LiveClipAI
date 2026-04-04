import axios from 'axios'
import type { PlatformPlugin, LiveInfo } from './types'
import type { PluginMetadata } from '../types/metadata'
import { getLogger } from '../../utils/logger'
import { mt } from '../../i18n'
import { extractRoomId } from '../../utils/platform-config'

const logger = getLogger('plugin.bilibili')

// Metadata for plugin discovery
export const BILIBILI_PLATFORM_METADATA = {
  label: 'B站直播',
  label_en: 'Bilibili Live',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const bilibiliPlatformMetadata: PluginMetadata = {
  id: 'platform-bilibili',
  type: 'platform',
  name: 'bilibili',
  platform: 'bilibili',
  label: BILIBILI_PLATFORM_METADATA.label,
  label_en: BILIBILI_PLATFORM_METADATA.label_en,
  version: BILIBILI_PLATFORM_METADATA.version,
  description: 'Live streaming platform plugin for Bilibili',
  enabled: true,
}

const BILIBILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://live.bilibili.com/',
}

const ROOM_INFO_API = 'https://api.live.bilibili.com/room/v1/Room/get_info'
const PLAY_INFO_API = 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo'
const USER_INFO_API = 'https://api.live.bilibili.com/live_user/v1/Master/info'

function getRoomIdFromUrl(url: string): string | null {
  return extractRoomId('bilibili', url)
}

export const bilibiliPlatform: PlatformPlugin = {
  name: 'bilibili',
  label: BILIBILI_PLATFORM_METADATA.label,
  label_en: BILIBILI_PLATFORM_METADATA.label_en,
  icon: 'bilibili',

  validateUrl(url: string): boolean {
    return url.includes('live.bilibili.com')
  },

  async getLiveInfo(url: string): Promise<LiveInfo> {
    const roomId = getRoomIdFromUrl(url)
    if (!roomId) throw new Error(mt('error.extractRoomId', { url }))

    const resp = await axios.get(ROOM_INFO_API, {
      headers: BILIBILI_HEADERS,
      params: { room_id: roomId },
      timeout: 15000,
    })

    if (resp.data?.code !== 0) {
      throw new Error(mt('error.apiError', { platform: mt('platform.bilibili'), message: resp.data?.message || 'unknown' }))
    }

    const roomData = resp.data.data || {}
    const uid = roomData.uid

    let author = ''
    if (uid) {
      try {
        const userResp = await axios.get(USER_INFO_API, {
          headers: BILIBILI_HEADERS,
          params: { uid },
          timeout: 10000,
        })
        if (userResp.data?.code === 0) {
          author = userResp.data.data?.info?.uname || ''
        }
      } catch (e) {
        logger.warn('获取B站主播信息失败:', e)
      }
    }

    return {
      roomId,
      title: roomData.title || '',
      author,
      coverUrl: roomData.user_cover || roomData.keyframe || '',
      platform: 'bilibili',
    }
  },

  async getStreamUrl(url: string): Promise<string> {
    const roomId = getRoomIdFromUrl(url)
    if (!roomId) throw new Error(mt('error.extractRoomIdShort', { url }))

    const resp = await axios.get(PLAY_INFO_API, {
      headers: BILIBILI_HEADERS,
      params: {
        room_id: roomId,
        protocol: '0,1',
        format: '0,1,2',
        codec: '0,1',
        qn: 10000,
        platform: 'web',
        ptype: 8,
      },
      timeout: 15000,
    })

    if (resp.data?.code !== 0) {
      throw new Error(mt('error.apiError', { platform: mt('platform.bilibili'), message: resp.data?.message || 'unknown' }))
    }

    const playurl = resp.data.data?.playurl_info?.playurl
    if (!playurl) throw new Error(mt('error.noStreamUrlMayOffline', { roomId }))

    // Prefer http_stream/flv
    for (const stream of playurl.stream || []) {
      if (stream.protocol_name !== 'http_stream') continue
      for (const fmt of stream.format || []) {
        if (fmt.format_name !== 'flv') continue
        for (const codec of fmt.codec || []) {
          const urlInfo = codec.url_info || []
          const baseUrl = codec.base_url || ''
          if (urlInfo.length && baseUrl) {
            const host = urlInfo[0].host || ''
            const extra = urlInfo[0].extra || ''
            logger.info(`B站直播流: codec=${codec.codec_name} qn=${codec.current_qn}`)
            return `${host}${baseUrl}${extra}`
          }
        }
      }
    }

    // Fallback: any stream
    for (const stream of playurl.stream || []) {
      for (const fmt of stream.format || []) {
        for (const codec of fmt.codec || []) {
          const urlInfo = codec.url_info || []
          const baseUrl = codec.base_url || ''
          if (urlInfo.length && baseUrl) {
            return `${urlInfo[0].host}${baseUrl}${urlInfo[0].extra || ''}`
          }
        }
      }
    }

    throw new Error(mt('error.streamUrlEmpty', { roomId }))
  },

  async isLive(url: string): Promise<boolean> {
    const roomId = getRoomIdFromUrl(url)
    if (!roomId) return false
    try {
      const resp = await axios.get(ROOM_INFO_API, {
        headers: BILIBILI_HEADERS,
        params: { room_id: roomId },
        timeout: 10000,
      })
      return resp.data?.data?.live_status === 1
    } catch {
      return false
    }
  },

  getLoginUrl(): string | null {
    return 'https://www.bilibili.com/'
  },

  getHeaders(): Record<string, string> {
    return { ...BILIBILI_HEADERS }
  },
}
