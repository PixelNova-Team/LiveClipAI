import type { PlatformPlugin } from './platform/types'
import type { DanmakuCollector } from './danmaku/types'
import type { PublisherPlugin } from './publisher/types'
import type { PluginMetadata } from './types/metadata'

class PluginRegistry {
  private platforms = new Map<string, PlatformPlugin>()
  private danmaku = new Map<string, DanmakuCollector>()
  private publishers = new Map<string, PublisherPlugin>()
  private metadata = new Map<string, PluginMetadata>()

  registerPlatform(plugin: PlatformPlugin): void {
    this.platforms.set(plugin.name, plugin)
  }

  registerDanmaku(collector: DanmakuCollector): void {
    this.danmaku.set(collector.platform, collector)
  }

  registerPublisher(plugin: PublisherPlugin): void {
    this.publishers.set(plugin.name, plugin)
  }

  getPlatform(name: string): PlatformPlugin | undefined {
    return this.platforms.get(name)
  }

  getDanmaku(name: string): DanmakuCollector | undefined {
    return this.danmaku.get(name)
  }

  getPublisher(name: string): PublisherPlugin | undefined {
    return this.publishers.get(name)
  }

  listPlatforms(): PlatformPlugin[] {
    return [...this.platforms.values()]
  }

  listDanmaku(): DanmakuCollector[] {
    return [...this.danmaku.values()]
  }

  listPublishers(): PublisherPlugin[] {
    return [...this.publishers.values()]
  }

  /** Detect platform from URL */
  detectPlatform(url: string): PlatformPlugin | undefined {
    for (const plugin of this.platforms.values()) {
      if (plugin.validateUrl(url)) return plugin
    }
    return undefined
  }

  // Metadata tracking (new methods for plugin auto-discovery)

  registerMetadata(meta: PluginMetadata): void {
    this.metadata.set(meta.id, meta)
  }

  getMetadata(pluginId: string): PluginMetadata | undefined {
    return this.metadata.get(pluginId)
  }

  getAllMetadata(): PluginMetadata[] {
    return Array.from(this.metadata.values())
  }

  getPluginType(pluginId: string): 'platform' | 'danmaku' | 'publisher' | undefined {
    return this.metadata.get(pluginId)?.type
  }
}

export const registry = new PluginRegistry()
