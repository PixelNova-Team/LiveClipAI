/**
 * Plugin Discovery Engine
 * Discovers plugins from configuration files and filesystem
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { PluginMetadata, PluginConfigFile, ValidationResult } from './types/metadata'
import { getLogger } from '../utils/logger'

const logger = getLogger('plugin.discovery')

export class PluginDiscovery {
  private configPath: string
  private pluginDirs: Record<string, string>

  constructor() {
    // Support both development and production paths
    const appPath = app.getAppPath()
    const possibleConfigPaths = [
      join(appPath, 'plugins.config.json'),           // prod: app root
      join(appPath, '..', 'plugins.config.json'),     // dev: parent of electron dir
      join(process.resourcesPath, 'plugins.config.json'), // production: resources dir
    ]

    this.configPath = possibleConfigPaths.find(p => existsSync(p)) || possibleConfigPaths[0]

    // Also support multiple plugin directory locations
    const possiblePlatformDirs = [
      join(appPath, 'src', 'main', 'plugins', 'platform'),      // dev: direct
      join(appPath, 'electron', 'src', 'main', 'plugins', 'platform'), // dev fallback
      join(process.resourcesPath, 'plugins', 'platform'),        // prod
    ]
    const possibleDanmakuDirs = [
      join(appPath, 'src', 'main', 'plugins', 'danmaku'),
      join(appPath, 'electron', 'src', 'main', 'plugins', 'danmaku'),
      join(process.resourcesPath, 'plugins', 'danmaku'),
    ]
    const possiblePublisherDirs = [
      join(appPath, 'src', 'main', 'plugins', 'publisher'),
      join(appPath, 'electron', 'src', 'main', 'plugins', 'publisher'),
      join(process.resourcesPath, 'plugins', 'publisher'),
    ]

    this.pluginDirs = {
      platform: possiblePlatformDirs.find(p => existsSync(p)) || possiblePlatformDirs[0],
      danmaku: possibleDanmakuDirs.find(p => existsSync(p)) || possibleDanmakuDirs[0],
      publisher: possiblePublisherDirs.find(p => existsSync(p)) || possiblePublisherDirs[0],
    }
  }

  /**
   * Discover all plugins from configuration file
   */
  async discoverFromConfig(): Promise<PluginMetadata[]> {
    try {
      if (!existsSync(this.configPath)) {
        logger.warn(`Plugin config not found at ${this.configPath}`)
        return []
      }

      const content = readFileSync(this.configPath, 'utf-8')
      const config: PluginConfigFile = JSON.parse(content)

      const plugins: PluginMetadata[] = []

      // Process platforms
      config.platforms?.forEach(p => {
        plugins.push({
          ...p,
          type: 'platform',
        } as PluginMetadata)
      })

      // Process danmaku collectors
      config.danmaku?.forEach(d => {
        plugins.push({
          ...d,
          type: 'danmaku',
        } as PluginMetadata)
      })

      // Process publishers
      config.publishers?.forEach(pub => {
        plugins.push({
          ...pub,
          type: 'publisher',
        } as PluginMetadata)
      })

      logger.info(`Discovered ${plugins.length} plugins from config`)
      return plugins
    } catch (error) {
      logger.error(`Failed to discover plugins from config: ${error.message}`)
      return []
    }
  }

  /**
   * Discover plugins by scanning filesystem
   * Useful as fallback if config file is missing
   */
  async discoverFromFileSystem(): Promise<PluginMetadata[]> {
    const plugins: PluginMetadata[] = []

    for (const [type, dir] of Object.entries(this.pluginDirs)) {
      if (!existsSync(dir)) {
        logger.warn(`Plugin directory not found: ${dir}`)
        continue
      }

      try {
        const files = readdirSync(dir)
        files.forEach(file => {
          // Skip non-typescript/javascript files
          if (!file.match(/\.(ts|js)$/) || file.startsWith('_') || file.startsWith('.')) {
            return
          }

          const name = file.replace(/\.(ts|js)$/, '')

          // Create minimal metadata from filesystem discovery
          const metadata: PluginMetadata = {
            id: `${type}.${name}`,
            type: type as 'platform' | 'danmaku' | 'publisher',
            name,
            label: this.humanizeName(name),
            version: '1.0.0',
            description: `Auto-discovered ${type} plugin: ${name}`,
            enabled: true,
            features: this.inferFeatures(type, name),
          }

          plugins.push(metadata)
        })
      } catch (error) {
        logger.error(`Error scanning plugin directory ${dir}: ${error.message}`)
      }
    }

    logger.info(`Discovered ${plugins.length} plugins from filesystem`)
    return plugins
  }

  /**
   * Merge discoveries from both sources, preferring config over filesystem
   */
  async discover(): Promise<PluginMetadata[]> {
    const configPlugins = await this.discoverFromConfig()

    if (configPlugins.length > 0) {
      return configPlugins
    }

    logger.warn('No plugins in config, falling back to filesystem discovery')
    return this.discoverFromFileSystem()
  }

  /**
   * Validate plugin metadata
   */
  validatePlugin(meta: PluginMetadata): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    // Required fields
    if (!meta.id) errors.push('Missing required field: id')
    if (!meta.name) errors.push('Missing required field: name')
    if (!meta.label) errors.push('Missing required field: label')
    if (!meta.version) errors.push('Missing required field: version')
    if (!meta.description) errors.push('Missing required field: description')

    // Type validation
    if (!['platform', 'danmaku', 'publisher'].includes(meta.type)) {
      errors.push(`Invalid type: ${meta.type}`)
    }

    // Danmaku and publisher must have platform reference
    if ((meta.type === 'danmaku' || meta.type === 'publisher') && !meta.platform) {
      errors.push(`${meta.type} plugin must reference a platform`)
    }

    // Semantic version check
    if (!meta.version.match(/^\d+\.\d+\.\d+/)) {
      warnings.push(`Version ${meta.version} does not follow semantic versioning`)
    }

    // Experimental flag warning
    if (meta.experimental && meta.enabled) {
      warnings.push('Experimental plugin is enabled - use with caution')
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * Validate all discovered plugins
   */
  validatePlugins(plugins: PluginMetadata[]): Map<string, ValidationResult> {
    const results = new Map<string, ValidationResult>()

    plugins.forEach(plugin => {
      const result = this.validatePlugin(plugin)
      results.set(plugin.id, result)

      if (!result.valid) {
        logger.warn(`Plugin ${plugin.id} validation failed: ${result.errors.join(', ')}`)
      }
      if (result.warnings.length > 0) {
        logger.info(`Plugin ${plugin.id} warnings: ${result.warnings.join(', ')}`)
      }
    })

    return results
  }

  /**
   * Helper: Convert filename to human-readable name
   */
  private humanizeName(name: string): string {
    return name
      .replace(/[-_]/g, ' ')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }

  /**
   * Helper: Infer features from type and name
   */
  private inferFeatures(type: string, name: string): string[] {
    if (type === 'platform') {
      return ['live', 'recording']
    }
    if (type === 'danmaku') {
      return ['danmaku', 'comments']
    }
    if (type === 'publisher') {
      return ['publish', 'upload']
    }
    return []
  }
}

export const pluginDiscovery = new PluginDiscovery()
