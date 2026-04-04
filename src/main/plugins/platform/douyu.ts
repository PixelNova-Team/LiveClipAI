import axios from 'axios'
import { createHash, randomUUID } from 'crypto'
import type { PlatformPlugin, LiveInfo } from './types'
import type { PluginMetadata } from '../types/metadata'
import { getLogger } from '../../utils/logger'
import { mt } from '../../i18n'
import { extractRoomId } from '../../utils/platform-config'

const logger = getLogger('plugin.douyu')

// Metadata for plugin discovery
export const DOUYU_PLATFORM_METADATA = {
  label: '斗鱼直播',
  label_en: 'Douyu Live',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const douyuPlatformMetadata: PluginMetadata = {
  id: 'platform-douyu',
  type: 'platform',
  name: 'douyu',
  platform: 'douyu',
  label: DOUYU_PLATFORM_METADATA.label,
  label_en: DOUYU_PLATFORM_METADATA.label_en,
  version: DOUYU_PLATFORM_METADATA.version,
  description: 'Live streaming platform plugin for Douyu',
  enabled: true,
}

const BETARD_API = 'https://www.douyu.com/betard'
const ENCRYPTION_API = 'https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption'
const H5PLAY_API = 'https://www.douyu.com/lapi/live/getH5PlayV1'

const DOUYU_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.douyu.com/',
}

function getRoomIdFromUrl(url: string): string | null {
  return extractRoomId('douyu', url)
}

async function getRoomInfo(roomId: string): Promise<any> {
  const resp = await axios.get(`${BETARD_API}/${roomId}`, {
    headers: DOUYU_HEADERS,
    timeout: 15000,
  })
  const room = resp.data?.room
  if (!room) throw new Error(mt('error.roomNotExist', { platform: mt('platform.douyu'), roomId }))
  return room
}

async function getStreamViaApi(roomId: string): Promise<string | null> {
  const did = randomUUID().replace(/-/g, '').slice(0, 32)

  try {
    // Step 1: Get encryption key
    const encResp = await axios.get(`${ENCRYPTION_API}?did=${did}`, {
      headers: DOUYU_HEADERS,
      timeout: 10000,
    })
    if (encResp.data?.error !== 0) {
      logger.warn('getEncryption error:', encResp.data?.msg)
      return null
    }
    const keyInfo = encResp.data.data

    // Step 2: Calculate sign
    const ts = Math.floor(Date.now() / 1000).toString()
    const key = keyInfo.key
    const encTime = keyInfo.enc_time || 1
    const isSpecial = keyInfo.is_special || 0

    const o = isSpecial === 1 ? '' : `${roomId}${ts}`
    let u = keyInfo.rand_str || ''
    for (let i = 0; i < encTime; i++) {
      u = createHash('md5').update(`${u}${key}`).digest('hex')
    }
    const auth = createHash('md5').update(`${u}${key}${o}`).digest('hex')

    // Step 3: POST to getH5PlayV1
    const body = `enc_data=${keyInfo.enc_data}&tt=${ts}&did=${did}&auth=${auth}&cdn=&ver=Douyu_new&rate=-1&hevc=0&fa=0&ive=0`

    const playResp = await axios.post(`${H5PLAY_API}/${roomId}`, body, {
      headers: {
        ...DOUYU_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    })

    if (playResp.data?.error !== 0) {
      logger.warn('getH5PlayV1 error:', playResp.data?.error, playResp.data?.msg)
      return null
    }

    const data = playResp.data.data || {}
    const rtmpUrl = data.rtmp_url || ''
    const rtmpLive = data.rtmp_live || ''

    if (!rtmpUrl || !rtmpLive) return null

    let streamUrl = `${rtmpUrl}/${rtmpLive}`

    // Ensure we use HTTP-FLV, not RTMP (mpegts.js needs HTTP)
    if (streamUrl.startsWith('rtmp://')) {
      streamUrl = streamUrl.replace('rtmp://', 'http://')
    }

    logger.info(`斗鱼直播流获取成功: ${streamUrl.slice(0, 100)}`)
    return streamUrl
  } catch (e) {
    logger.warn('getStream failed:', e)
    return null
  }
}

export const douyuPlatform: PlatformPlugin = {
  name: 'douyu',
  label: DOUYU_PLATFORM_METADATA.label,
  label_en: DOUYU_PLATFORM_METADATA.label_en,
  icon: 'douyu',

  validateUrl(url: string): boolean {
    return url.includes('douyu.com')
  },

  async getLiveInfo(url: string): Promise<LiveInfo> {
    const roomId = getRoomIdFromUrl(url)
    if (!roomId) throw new Error(mt('error.extractRoomId', { url }))

    const room = await getRoomInfo(roomId)
    return {
      roomId,
      title: room.room_name || '',
      author: room.nickname || room.owner_name || '',
      coverUrl: room.room_pic || room.room_thumb || '',
      platform: 'douyu',
    }
  },

  async getStreamUrl(url: string): Promise<string> {
    const roomId = getRoomIdFromUrl(url)
    if (!roomId) throw new Error(mt('error.extractRoomIdShort', { url }))

    const room = await getRoomInfo(roomId)
    if (room.show_status !== 1) {
      throw new Error(mt('error.streamerOffline', { roomId, status: room.show_status }))
    }

    const streamUrl = await getStreamViaApi(roomId)
    if (!streamUrl) throw new Error(mt('error.noStreamUrl', { roomId }))
    return streamUrl
  },

  async isLive(url: string): Promise<boolean> {
    const roomId = getRoomIdFromUrl(url)
    if (!roomId) return false
    try {
      const room = await getRoomInfo(roomId)
      return room.show_status === 1
    } catch {
      return true
    }
  },

  getLoginUrl(): string | null {
    return 'https://www.douyu.com/'
  },

  getHeaders(): Record<string, string> {
    return { ...DOUYU_HEADERS }
  },
}
