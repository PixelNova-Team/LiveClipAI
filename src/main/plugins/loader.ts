/**
 * Plugin Loader
 * Dynamically loads plugin modules with error isolation
 */

import type { PluginMetadata, LoadResultDetail } from './types/metadata'
import type { PlatformPlugin } from './platform/types'
import type { DanmakuCollector } from './danmaku/types'
import type { PublisherPlugin } from './publisher/types'
import { getLogger } from '../utils/logger'

const logger = getLogger('plugin.loader')

/**
 * Module import map - maintains all plugin imports without eval
 * Enables dynamic loading while preserving type safety
 */
const PLUGIN_MODULES = {
  // Platforms
  'platform.douyin': () => import('./platform/douyin'),
  'platform.bilibili': () => import('./platform/bilibili'),
  'platform.douyu': () => import('./platform/douyu'),
  'platform.huya': () => import('./platform/huya'),
  'platform.kuaishou': () => import('./platform/kuaishou'),
  'platform.youtube': () => import('./platform/youtube'),

  // Danmaku
  'danmaku.douyin': () => import('./danmaku/douyin'),
  'danmaku.bilibili': () => import('./danmaku/bilibili'),
  'danmaku.douyu': () => import('./danmaku/douyu'),
  'danmaku.huya': () => import('./danmaku/huya'),
  'danmaku.kuaishou': () => import('./danmaku/kuaishou'),
  'danmaku.youtube': () => import('./danmaku/youtube'),

  // Publishers
  'publisher.douyin': () => import('./publisher/douyin'),
  'publisher.bilibili': () => import('./publisher/bilibili'),
  'publisher.kuaishou': () => import('./publisher/kuaishou'),
  'publisher.youtube': () => import('./publisher/youtube'),
} as Record<string, () => Promise<any>>

export class PluginLoader {
  /**
   * Load a plugin module
   * @param type - Plugin type: 'platform', 'danmaku', or 'publisher'
   * @param name - Plugin name (e.g., 'douyin', 'bilibili')
   * @returns The exported plugin object
   * @throws Error if module not found or loading fails
   */
  async loadModule<T = PlatformPlugin | DanmakuCollector | PublisherPlugin>(
    type: string,
    name: string
  ): Promise<T> {
    const key = `${type}.${name}`

    const loader = PLUGIN_MODULES[key as keyof typeof PLUGIN_MODULES]
    if (!loader) {
      throw new Error(`Unknown plugin module: ${key}`)
    }

    try {
      const startTime = Date.now()
      const module = await loader()
      const loadTime = Date.now() - startTime

      logger.debug(`Loaded ${key} in ${loadTime}ms`)
      return module as T
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to load ${key}: ${errorMsg}`)
    }
  }

  /**
   * Load a plugin and extract the correct export
   * Handles different export patterns for different plugin types
   */
  async loadPlugin(metadata: PluginMetadata): Promise<LoadResultDetail> {
    const startTime = Date.now()
    const loadTime = () => Date.now() - startTime

    try {
      const module = await this.loadModule(metadata.type, metadata.name)

      // Export validation
      let plugin: any

      // Platform plugins export as `{name}Platform`
      if (metadata.type === 'platform') {
        const exportName = `${metadata.name}Platform`
        plugin = module[exportName]
        if (!plugin) {
          throw new Error(
            `Platform plugin "${metadata.name}" must export const ${exportName}: PlatformPlugin`
          )
        }
      }
      // Danmaku collectors: try const first, then class
      else if (metadata.type === 'danmaku') {
        // First try: export as const object {name}Danmaku
        const constName = `${metadata.name}Danmaku`
        plugin = module[constName]

        // Fallback: export as class {Name}Danmaku that needs instantiation
        if (!plugin) {
          const className = metadata.name.charAt(0).toUpperCase() + metadata.name.slice(1) + 'Danmaku'
          const exportClass = module[className]
          if (exportClass && typeof exportClass === 'function') {
            plugin = new exportClass()
          }
        }

        if (!plugin) {
          throw new Error(
            `Danmaku plugin "${metadata.name}" must export either:
            - const ${constName}: DanmakuCollector
            - class ${metadata.name.charAt(0).toUpperCase() + metadata.name.slice(1) + 'Danmaku'} implements DanmakuCollector`
          )
        }
      }
      // Publisher plugins export as `{name}Publisher`
      else if (metadata.type === 'publisher') {
        const exportName = `${metadata.name}Publisher`
        plugin = module[exportName]
        if (!plugin) {
          throw new Error(
            `Publisher plugin "${metadata.name}" must export const ${exportName}: PublisherPlugin`
          )
        }
      }

      if (!plugin) {
        throw new Error(`No valid export found in module`)
      }

      return {
        success: true,
        pluginId: metadata.id,
        type: metadata.type,
        loadTime: loadTime(),
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`Failed to load plugin ${metadata.id}: ${errorMsg}`)

      return {
        success: false,
        pluginId: metadata.id,
        type: metadata.type,
        error: errorMsg,
        loadTime: loadTime(),
      }
    }
  }

  /**
   * Batch load multiple plugins with error isolation
   */
  async loadPlugins(plugins: PluginMetadata[]): Promise<Array<LoadResultDetail>> {
    const results = await Promise.all(
      plugins.map(meta => this.loadPlugin(meta))
    )

    const summary = {
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    }

    logger.info(
      `Batch load complete: ${summary.succeeded}/${summary.total} succeeded, ` +
      `${summary.failed} failed`
    )

    return results
  }

  /**
   * Get list of available plugin modules (for debugging/info)
   */
  getAvailableModules(): string[] {
    return Object.keys(PLUGIN_MODULES)
  }

  /**
   * Check if a plugin module is available
   */
  hasModule(type: string, name: string): boolean {
    return `${type}.${name}` in PLUGIN_MODULES
  }
}

export const pluginLoader = new PluginLoader()
