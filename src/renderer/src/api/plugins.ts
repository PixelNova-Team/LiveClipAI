import ipc from './client'

export interface PlatformInfo {
  id: string
  name: string
  label: string
  label_en: string
  icon: string
  brandColor?: string
}

export interface DanmakuInfo {
  id: string
  name: string
  label: string
  label_en: string
}

export interface PublisherInfo {
  id: string
  name: string
  label: string
  label_en: string
}

export interface AllPluginsMetadata {
  platforms: PlatformInfo[]
  danmaku: DanmakuInfo[]
  publishers: PublisherInfo[]
}

/**
 * Get all platform metadata from backend
 */
export async function getPlatforms(): Promise<PlatformInfo[]> {
  return ipc.invoke('plugins:get-platforms')
}

/**
 * Get all danmaku collector metadata from backend
 */
export async function getDanmakuCollectors(): Promise<DanmakuInfo[]> {
  return ipc.invoke('plugins:get-danmaku')
}

/**
 * Get all publisher metadata from backend
 */
export async function getPublishers(): Promise<PublisherInfo[]> {
  return ipc.invoke('plugins:get-publishers')
}

/**
 * Get all plugins metadata organized by type
 */
export async function getAllPluginsMetadata(): Promise<AllPluginsMetadata> {
  return ipc.invoke('plugins:get-all-metadata')
}

/**
 * Detect platform from URL using plugin system
 * Returns platform name (e.g., 'douyin', 'bilibili') or null if not supported
 */
export async function detectPlatformFromUrl(url: string): Promise<string | null> {
  return ipc.invoke('plugins:detect-platform', url)
}

/**
 * Check if URL is supported by any platform
 */
export async function isSupportedUrl(url: string): Promise<boolean> {
  return ipc.invoke('plugins:is-supported-url', url)
}
