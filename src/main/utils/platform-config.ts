/**
 * Platform Configuration Helper
 * Provides unified access to platform metadata from plugins.config.json
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getLogger } from './logger'

const logger = getLogger('platform.config')

interface PlatformConfig {
  cdnDomains: string[]
  cookieDomain: string
  publisherSsoUrl?: string
  authCookieNames: string[]
  brandColor?: string
  roomIdRegex?: string
}

interface ConfigFile {
  platforms: Array<{
    name: string
    cdnDomains?: string[]
    cookieDomain?: string
    publisherSsoUrl?: string
    authCookieNames?: string[]
    brandColor?: string
    roomIdRegex?: string
  }>
}

let cachedConfigs: Map<string, PlatformConfig> | null = null

function loadConfigFile(): ConfigFile {
  // Try multiple locations for plugins.config.json
  const paths = [
    join(app.getAppPath(), 'plugins.config.json'),           // prod: app root
    join(app.getAppPath(), '..', 'plugins.config.json'),     // dev: parent of electron dir
    join(process.resourcesPath, 'plugins.config.json'),       // production: resources dir
  ]

  logger.info(`[loadConfigFile] Trying paths: ${paths.join(' | ')}`)

  let configPath: string | null = null
  for (const p of paths) {
    if (existsSync(p)) {
      configPath = p
      break
    }
  }

  if (!configPath) {
    logger.warn(`Platform config file not found at: ${paths.join(' | ')}`)
    return { platforms: [] }
  }

  try {
    const content = readFileSync(configPath, 'utf-8')
    logger.info(`Loaded platform config from: ${configPath}`)
    return JSON.parse(content) as ConfigFile
  } catch (error) {
    logger.error(`Failed to load platform config from ${configPath}: ${error}`)
    return { platforms: [] }
  }
}

function initializeConfigs(): Map<string, PlatformConfig> {
  const configFile = loadConfigFile()
  const configs = new Map<string, PlatformConfig>()

  configFile.platforms.forEach(p => {
    configs.set(p.name, {
      cdnDomains: p.cdnDomains || [],
      cookieDomain: p.cookieDomain || '',
      publisherSsoUrl: p.publisherSsoUrl,
      authCookieNames: p.authCookieNames || [],
      brandColor: p.brandColor,
      roomIdRegex: p.roomIdRegex,
    })
  })

  return configs
}

/**
 * Get platform configuration by platform name
 */
export function getPlatformConfig(platformName: string): PlatformConfig | undefined {
  if (!cachedConfigs) {
    cachedConfigs = initializeConfigs()
  }
  return cachedConfigs.get(platformName)
}

/**
 * Get all CDN domains mapped to their platforms
 */
export function getCdnDomainMap(): Map<string, string> {
  if (!cachedConfigs) {
    cachedConfigs = initializeConfigs()
  }

  const map = new Map<string, string>()

  cachedConfigs.forEach((config, platformName) => {
    config.cdnDomains.forEach(domain => {
      map.set(domain, platformName)
    })
  })

  return map
}

/**
 * Detect platform from URL by checking CDN domains
 */
export function detectPlatformFromUrl(url: string): string | null {
  const lowerUrl = url.toLowerCase()
  const cdnMap = getCdnDomainMap()

  for (const [domain, platform] of cdnMap) {
    if (lowerUrl.includes(domain)) {
      return platform
    }
  }

  return null
}

/**
 * Get referer URL for a platform
 */
export function getRefererUrl(platformName: string): string {
  const defaults: Record<string, string> = {
    douyu: 'https://www.douyu.com/',
    douyin: 'https://live.douyin.com/',
    bilibili: 'https://live.bilibili.com/',
    huya: 'https://www.huya.com/',
    kuaishou: 'https://www.kuaishou.com/',
  }

  return defaults[platformName] || 'https://www.google.com/'
}

/**
 * Get User-Agent for a platform (default modern Chrome)
 */
export function getUserAgent(_platformName: string): string {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

/**
 * Check if URL belongs to a specific platform's CDN
 */
export function isCdnUrlForPlatform(url: string, platformName: string): boolean {
  const config = getPlatformConfig(platformName)
  if (!config) return false

  const lowerUrl = url.toLowerCase()
  return config.cdnDomains.some(domain => lowerUrl.includes(domain))
}

/**
 * Get brand color for a platform
 */
export function getBrandColor(platformName: string): string {
  const config = getPlatformConfig(platformName)
  return config?.brandColor || '#909399'
}

/**
 * Get room ID regex for a platform
 */
export function getRoomIdRegex(platformName: string): RegExp | null {
  const config = getPlatformConfig(platformName)
  if (!config?.roomIdRegex) return null

  try {
    return new RegExp(config.roomIdRegex)
  } catch (error) {
    logger.warn(`Invalid roomIdRegex for ${platformName}: ${config.roomIdRegex}`)
    return null
  }
}

/**
 * Extract room ID from URL using platform's regex
 */
export function extractRoomId(platformName: string, url: string): string | null {
  const regex = getRoomIdRegex(platformName)
  if (!regex) return null

  const match = regex.exec(url)
  return match ? match[1] : null
}
