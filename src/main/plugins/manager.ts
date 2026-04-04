/**
 * Plugin Manager
 * Orchestrates plugin discovery, loading, and lifecycle management
 */

import type {
  PluginMetadata,
  PluginLoadResult,
  FailedPlugin,
  HealthStatus,
  HealthCheckReport,
} from './types/metadata'
import { pluginDiscovery } from './discovery'
import { pluginLoader } from './loader'
import { registry } from './registry'
import type { PlatformPlugin } from './platform/types'
import type { DanmakuCollector } from './danmaku/types'
import type { PublisherPlugin } from './publisher/types'
import { getLogger } from '../utils/logger'

const logger = getLogger('plugin.manager')

export class PluginManager {
  private metadata: Map<string, PluginMetadata> = new Map()
  private failedPlugins: FailedPlugin[] = []
  private loadedPlugins: Set<string> = new Set()
  private disabledPlugins: Set<string> = new Set()
  private initialized = false

  /**
   * Initialize and load all plugins
   */
  async initialize(): Promise<PluginLoadResult> {
    const initStart = Date.now()
    logger.info('Plugin manager initialization started')

    try {
      // Discover plugins
      const plugins = await pluginDiscovery.discover()
      logger.info(`Discovered ${plugins.length} plugins`)

      // Validate all plugins
      const validationResults = pluginDiscovery.validatePlugins(plugins)

      // Separate enabled/disabled plugins
      const enabledPlugins: PluginMetadata[] = []
      const disabledPlugins: PluginMetadata[] = []

      plugins.forEach(plugin => {
        // Store metadata
        this.metadata.set(plugin.id, plugin)

        if (!plugin.enabled) {
          this.disabledPlugins.add(plugin.id)
          disabledPlugins.push(plugin)
        } else {
          enabledPlugins.push(plugin)
        }
      })

      // Load enabled plugins
      const results = await pluginLoader.loadPlugins(enabledPlugins)

      const platformLoaded: string[] = []
      const platformFailed: FailedPlugin[] = []
      const danmakuLoaded: string[] = []
      const danmakuFailed: FailedPlugin[] = []
      const publisherLoaded: string[] = []
      const publisherFailed: FailedPlugin[] = []

      // Register loaded plugins and track failures
      for (const result of results) {
        const metadata = this.metadata.get(result.pluginId)!

        if (result.success) {
          this.loadedPlugins.add(result.pluginId)

          // Register in registry
          await this.registerPlugin(metadata)

          // Track by type
          if (metadata.type === 'platform') platformLoaded.push(metadata.name)
          else if (metadata.type === 'danmaku') danmakuLoaded.push(metadata.name)
          else if (metadata.type === 'publisher') publisherLoaded.push(metadata.name)

          logger.info(
            `Loaded ${metadata.type} plugin: ${metadata.id} (${result.loadTime}ms)`
          )
        } else {
          // Track failure
          const failedPlugin: FailedPlugin = {
            id: result.pluginId,
            type: result.type,
            reason: result.error || 'Unknown error',
            timestamp: Date.now(),
          }
          this.failedPlugins.push(failedPlugin)

          // Track by type
          if (metadata.type === 'platform') platformFailed.push(failedPlugin)
          else if (metadata.type === 'danmaku') danmakuFailed.push(failedPlugin)
          else if (metadata.type === 'publisher') publisherFailed.push(failedPlugin)

          logger.error(
            `Failed to load ${metadata.type} plugin ${metadata.id}: ${result.error}`
          )
        }
      }

      const initTime = Date.now() - initStart
      this.initialized = true

      const loadResult: PluginLoadResult = {
        total: plugins.length,
        loaded: this.loadedPlugins.size,
        failed: this.failedPlugins.length,
        disabled: this.disabledPlugins.size,
        details: {
          platform: { loaded: platformLoaded, failed: platformFailed },
          danmaku: { loaded: danmakuLoaded, failed: danmakuFailed },
          publisher: { loaded: publisherLoaded, failed: publisherFailed },
        },
      }

      logger.info(
        `Plugin initialization complete (${initTime}ms): ` +
        `${loadResult.loaded} loaded, ` +
        `${loadResult.failed} failed, ` +
        `${loadResult.disabled} disabled`
      )

      return loadResult
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`Critical plugin initialization error: ${errorMsg}`)

      return {
        total: 0,
        loaded: 0,
        failed: 0,
        disabled: 0,
        details: {
          platform: { loaded: [], failed: [] },
          danmaku: { loaded: [], failed: [] },
          publisher: { loaded: [], failed: [] },
        },
      }
    }
  }

  /**
   * Register a loaded plugin in the global registry
   */
  private async registerPlugin(metadata: PluginMetadata): Promise<void> {
    try {
      // Load the module
      const module = await pluginLoader.loadModule(metadata.type, metadata.name)

      // Register in global registry based on type
      if (metadata.type === 'platform') {
        const exportName = `${metadata.name}Platform`
        const plugin = module[exportName] as PlatformPlugin
        registry.registerPlatform(plugin)
        registry.registerMetadata(metadata)
      } else if (metadata.type === 'danmaku') {
        const className = metadata.name.charAt(0).toUpperCase() + metadata.name.slice(1) + 'Danmaku'
        const PluginClass = module[className] as typeof DanmakuCollector
        const instance = new PluginClass()
        registry.registerDanmaku(instance as DanmakuCollector)
        registry.registerMetadata(metadata)
      } else if (metadata.type === 'publisher') {
        const exportName = `${metadata.name}Publisher`
        const plugin = module[exportName] as PublisherPlugin
        registry.registerPublisher(plugin)
        registry.registerMetadata(metadata)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`Failed to register plugin ${metadata.id}: ${errorMsg}`)
      throw error
    }
  }

  /**
   * Get list of loaded plugins
   */
  listLoadedPlugins(type?: 'platform' | 'danmaku' | 'publisher'): PluginMetadata[] {
    const plugins: PluginMetadata[] = []

    this.metadata.forEach(meta => {
      if (this.loadedPlugins.has(meta.id)) {
        if (!type || meta.type === type) {
          plugins.push(meta)
        }
      }
    })

    return plugins
  }

  /**
   * Get list of failed plugins
   */
  getFailedPlugins(): FailedPlugin[] {
    return [...this.failedPlugins]
  }

  /**
   * Get all metadata
   */
  getAllMetadata(): PluginMetadata[] {
    return Array.from(this.metadata.values())
  }

  /**
   * Get metadata for a specific plugin
   */
  getMetadata(pluginId: string): PluginMetadata | undefined {
    return this.metadata.get(pluginId)
  }

  /**
   * Get health status for a plugin
   */
  async getHealthStatus(pluginId: string): Promise<HealthStatus> {
    const metadata = this.metadata.get(pluginId)

    if (!metadata) {
      return {
        id: pluginId,
        healthy: false,
        status: 'missing',
        lastCheck: Date.now(),
        error: 'Plugin not found',
      }
    }

    if (this.disabledPlugins.has(pluginId)) {
      return {
        id: pluginId,
        healthy: true,
        status: 'disabled',
        lastCheck: Date.now(),
        version: metadata.version,
      }
    }

    if (!this.loadedPlugins.has(pluginId)) {
      const failed = this.failedPlugins.find(f => f.id === pluginId)
      return {
        id: pluginId,
        healthy: false,
        status: 'error',
        lastCheck: Date.now(),
        error: failed?.reason,
        version: metadata.version,
      }
    }

    return {
      id: pluginId,
      healthy: true,
      status: 'ok',
      lastCheck: Date.now(),
      version: metadata.version,
    }
  }

  /**
   * Get health check report for all plugins
   */
  async getHealthReport(): Promise<HealthCheckReport> {
    const healthStates = await Promise.all(
      Array.from(this.metadata.keys()).map(id => this.getHealthStatus(id))
    )

    const healthy = healthStates.filter(s => s.healthy).length
    const unhealthy = healthStates.filter(s => !s.healthy).length

    const recommendations: string[] = []

    if (this.failedPlugins.length > 0) {
      recommendations.push(`Failed to load ${this.failedPlugins.length} plugins`)
    }

    if (unhealthy > 0) {
      recommendations.push(`Check plugin configuration and dependencies`)
    }

    return {
      timestamp: Date.now(),
      summary: {
        total: healthStates.length,
        healthy,
        unhealthy,
      },
      plugins: healthStates,
      recommendations,
    }
  }

  /**
   * Reload a specific plugin
   */
  async reloadPlugin(pluginId: string): Promise<{ success: boolean; error?: string }> {
    const metadata = this.metadata.get(pluginId)

    if (!metadata) {
      return { success: false, error: 'Plugin not found' }
    }

    try {
      logger.info(`Reloading plugin ${pluginId}`)

      // Remove from tracking
      this.loadedPlugins.delete(pluginId)
      this.disabledPlugins.delete(pluginId)

      // Remove from failed list
      const failedIndex = this.failedPlugins.findIndex(f => f.id === pluginId)
      if (failedIndex >= 0) {
        this.failedPlugins.splice(failedIndex, 1)
      }

      // Reload
      const result = await pluginLoader.loadPlugin(metadata)

      if (result.success) {
        await this.registerPlugin(metadata)
        this.loadedPlugins.add(pluginId)
        logger.info(`Successfully reloaded plugin ${pluginId}`)
        return { success: true }
      } else {
        this.failedPlugins.push({
          id: pluginId,
          type: metadata.type,
          reason: result.error || 'Unknown error',
          timestamp: Date.now(),
        })
        return { success: false, error: result.error }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * Check if manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Get metadata for all platforms
   */
  getPlatformMetadata(): PluginMetadata[] {
    return Array.from(this.metadata.values()).filter(m => m.type === 'platform')
  }

  /**
   * Get metadata for all danmaku collectors
   */
  getDanmakuMetadata(): PluginMetadata[] {
    return Array.from(this.metadata.values()).filter(m => m.type === 'danmaku')
  }

  /**
   * Get metadata for all publishers
   */
  getPublisherMetadata(): PluginMetadata[] {
    return Array.from(this.metadata.values()).filter(m => m.type === 'publisher')
  }

  /**
   * Get all plugins metadata organized by type
   */
  getAllPluginsMetadata(): {
    platforms: PluginMetadata[]
    danmaku: PluginMetadata[]
    publishers: PluginMetadata[]
  } {
    return {
      platforms: this.getPlatformMetadata(),
      danmaku: this.getDanmakuMetadata(),
      publishers: this.getPublisherMetadata(),
    }
  }
}

export const pluginManager = new PluginManager()
