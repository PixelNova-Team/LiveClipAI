import axios from 'axios'
import type { PlatformPlugin, LiveInfo } from './types'
import type { PluginMetadata } from '../types/metadata'
import { abSign } from './douyin-sign'
import { getLogger } from '../../utils/logger'
import { loadCookies, cookiesToString } from '../../utils/cookies'
import { mt } from '../../i18n'

const logger = getLogger('plugin.douyin')

// Metadata for plugin discovery
export const DOUYIN_PLATFORM_METADATA = {
  label: '抖音直播',
  label_en: 'Douyin Live',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const douyinPlatformMetadata: PluginMetadata = {
  id: 'platform-douyin',
  type: 'platform',
  name: 'douyin',
  platform: 'douyin',
  label: DOUYIN_PLATFORM_METADATA.label,
  label_en: DOUYIN_PLATFORM_METADATA.label_en,
  version: DOUYIN_PLATFORM_METADATA.version,
  description: 'Live streaming platform plugin for Douyin',
  enabled: true,
}

const DOUYIN_LIVE_PATTERN = /live\.douyin\.com\/(\d+)/
const WEBCAST_API = 'https://live.douyin.com/webcast/room/web/enter/'

const DOUYIN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36 Core/1.116.567.400 QQBrowser/19.7.6764.400',
  'Referer': 'https://live.douyin.com/',
}

function extractRoomId(url: string): string | null {
  const m = DOUYIN_LIVE_PATTERN.exec(url)
  return m ? m[1] : null
}

async function getTtwid(): Promise<string | null> {
  try {
    const resp = await axios.get('https://live.douyin.com/', {
      headers: DOUYIN_HEADERS,
      maxRedirects: 5,
      timeout: 15000,
    })
    const cookies = resp.headers['set-cookie'] || []
    for (const h of cookies) {
      const m = /ttwid=([^;]+)/.exec(h)
      if (m) return m[1]
    }
    // Fallback: __ac_nonce flow
    for (const h of cookies) {
      const m = /__ac_nonce=([^;]+)/.exec(h)
      if (m) {
        const resp2 = await axios.get('https://live.douyin.com/', {
          headers: { ...DOUYIN_HEADERS, Cookie: `__ac_nonce=${m[1]}` },
          maxRedirects: 5,
          timeout: 15000,
        })
        const cookies2 = resp2.headers['set-cookie'] || []
        for (const h2 of cookies2) {
          const m2 = /ttwid=([^;]+)/.exec(h2)
          if (m2) return m2[1]
        }
      }
    }
  } catch (e) {
    logger.warn('Failed to get ttwid:', e)
  }
  return null
}

async function callWebcastApi(webRid: string, cookie: string): Promise<any> {
  const params = new URLSearchParams({
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '116.0.0.0',
    web_rid: webRid,
    msToken: '',
  })

  const queryString = params.toString()
  const aBogus = abSign(queryString, DOUYIN_HEADERS['User-Agent'])
  const url = `${WEBCAST_API}?${queryString}&a_bogus=${aBogus}`

  try {
    const resp = await axios.get(url, {
      headers: { ...DOUYIN_HEADERS, cookie },
      timeout: 15000,
    })
    return resp.data
  } catch (e) {
    logger.warn('Douyin webcast API error:', e)
    return null
  }
}

export const douyinPlatform: PlatformPlugin = {
  name: 'douyin',
  label: DOUYIN_PLATFORM_METADATA.label,
  label_en: DOUYIN_PLATFORM_METADATA.label_en,
  icon: 'douyin',

  validateUrl(url: string): boolean {
    return url.includes('live.douyin.com')
  },

  async getLiveInfo(url: string): Promise<LiveInfo> {
    const webRid = extractRoomId(url)
    if (!webRid) throw new Error(mt('error.extractRoomId', { url }))

    const ttwid = await getTtwid()
    if (!ttwid) throw new Error(mt('error.ttwidFailed'))

    const data = await callWebcastApi(webRid, `ttwid=${ttwid}`)
    if (!data || data.status_code !== 0) {
      throw new Error(mt('error.apiError', { platform: mt('platform.douyin'), message: data?.status_code ?? 'empty' }))
    }

    const dataList = data.data?.data || []
    const user = data.data?.user || {}

    logger.info(`getLiveInfo: webRid=${webRid}, title=${dataList[0]?.title}`)

    // Prefer live room cover over streamer avatar
    const roomCover = dataList[0]?.cover?.url_list?.[0] || ''
    const avatarUrl = user.avatar_thumb?.url_list?.[0] || ''

    return {
      roomId: webRid,
      title: dataList[0]?.title || '',
      author: user.nickname || '',
      coverUrl: roomCover || avatarUrl,
      platform: 'douyin',
    }
  },

  async getStreamUrl(url: string): Promise<string> {
    const webRid = extractRoomId(url)
    if (!webRid) throw new Error(mt('error.extractRoomIdShort', { url }))

    const ttwid = await getTtwid()
    if (!ttwid) throw new Error(mt('error.ttwidFailed'))

    const data = await callWebcastApi(webRid, `ttwid=${ttwid}`)
    if (!data || data.status_code !== 0) {
      throw new Error(mt('error.apiError', { platform: mt('platform.douyin'), message: data?.status_code ?? 'empty' }))
    }

    const dataList = data.data?.data || []
    if (!dataList.length) throw new Error(mt('error.roomDataEmpty', { roomId: webRid }))

    const room = dataList[0]
    if (room.status !== 2) throw new Error(mt('error.streamerOffline', { roomId: webRid, status: room.status }))

    const streamUrlData = room.stream_url || {}

    // Prefer FLV
    const flvPull = streamUrlData.flv_pull_url || {}
    for (const quality of ['FULL_HD1', 'HD1', 'SD1', 'SD2']) {
      if (flvPull[quality]) {
        logger.info(`抖音直播流获取成功: quality=${quality}`)
        return flvPull[quality]
      }
    }
    const firstFlv = Object.values(flvPull)[0] as string | undefined
    if (firstFlv) return firstFlv

    // Fallback to HLS
    const hlsPull = streamUrlData.hls_pull_url_map || {}
    const firstHls = Object.values(hlsPull)[0] as string | undefined
    if (firstHls) return firstHls

    throw new Error(mt('error.noStreamUrl', { roomId: webRid }))
  },

  async isLive(url: string): Promise<boolean> {
    const webRid = extractRoomId(url)
    if (!webRid) return false

    try {
      const ttwid = await getTtwid()
      if (!ttwid) return true // Don't kill monitor on cookie failure

      const data = await callWebcastApi(webRid, `ttwid=${ttwid}`)
      if (!data || data.status_code !== 0) return true

      const dataList = data.data?.data || []
      return dataList.length > 0 && dataList[0].status === 2
    } catch {
      return true
    }
  },

  getLoginUrl(): string {
    return 'https://sso.douyin.com/login/?service=https%3A%2F%2Fwww.douyin.com&aid=6383'
  },

  getHeaders(): Record<string, string> {
    return { ...DOUYIN_HEADERS }
  },
}
