import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformPlugin, LiveInfo } from './types'
import type { PluginMetadata } from '../types/metadata'
import { getLogger } from '../../utils/logger'

const logger = getLogger('plugin.youtube')

// Metadata for plugin discovery
export const YOUTUBE_PLATFORM_METADATA = {
  label: 'YouTube',
  label_en: 'YouTube',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const youtubePlatformMetadata: PluginMetadata = {
  id: 'platform-youtube',
  type: 'platform',
  name: 'youtube',
  platform: 'youtube',
  label: YOUTUBE_PLATFORM_METADATA.label,
  label_en: YOUTUBE_PLATFORM_METADATA.label_en,
  version: YOUTUBE_PLATFORM_METADATA.version,
  description: 'Live streaming platform plugin for YouTube',
  enabled: true,
}
const execFileAsync = promisify(execFile)

const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
}

function extractVideoId(url: string): string | null {
  // youtube.com/watch?v=xxx or youtube.com/live/xxx or youtu.be/xxx
  const patterns = [
    /youtube\.com\/watch\?v=([^&]+)/,
    /youtube\.com\/live\/([^?&]+)/,
    /youtu\.be\/([^?&]+)/,
    /youtube\.com\/@[^/]+\/live/,
  ]
  for (const p of patterns) {
    const m = p.exec(url)
    if (m && m[1]) return m[1]
  }
  return null
}

export const youtubePlatform: PlatformPlugin = {
  name: 'youtube',
  label: YOUTUBE_PLATFORM_METADATA.label,
  label_en: YOUTUBE_PLATFORM_METADATA.label_en,
  icon: 'youtube',

  validateUrl(url: string): boolean {
    return url.includes('youtube.com') || url.includes('youtu.be')
  },

  async getLiveInfo(url: string): Promise<LiveInfo> {
    try {
      const { stdout } = await execFileAsync('yt-dlp', [
        '--dump-json', '--no-download', url,
      ], { timeout: 30000 })

      const info = JSON.parse(stdout)
      return {
        roomId: info.id || extractVideoId(url) || '',
        title: info.title || info.fulltitle || '',
        author: info.uploader || info.channel || '',
        coverUrl: info.thumbnail || '',
        platform: 'youtube',
      }
    } catch (e) {
      logger.warn('yt-dlp failed, using fallback:', e)
      return {
        roomId: extractVideoId(url) || url,
        title: 'YouTube Live',
        author: '',
        platform: 'youtube',
      }
    }
  },

  async getStreamUrl(url: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('yt-dlp', [
        '-g', '-f', 'best[ext=mp4]/best', url,
      ], { timeout: 30000 })

      const streamUrl = stdout.trim().split('\n')[0]
      if (!streamUrl) throw new Error('yt-dlp returned empty URL')
      logger.info('YouTube直播流获取成功')
      return streamUrl
    } catch (e: any) {
      throw new Error(`无法获取YouTube直播流: ${e.message}`)
    }
  },

  async isLive(url: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('yt-dlp', [
        '--dump-json', '--no-download', url,
      ], { timeout: 15000 })

      const info = JSON.parse(stdout)
      return info.is_live === true
    } catch {
      return false
    }
  },

  getLoginUrl(): string | null {
    return null
  },

  getHeaders(): Record<string, string> {
    return { ...YT_HEADERS }
  },
}
