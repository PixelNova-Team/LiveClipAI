/**
 * Plugin Metadata and Related Types
 * Defines the structure for plugin discovery, configuration, and status tracking
 */

export interface PluginMetadata {
  id: string                          // Unique identifier
  type: 'platform' | 'danmaku' | 'publisher'
  name: string                        // Internal name (matches import)
  label: string                       // Display name
  icon?: string                       // Icon identifier
  version: string                     // Semantic version
  description: string
  enabled: boolean                    // Whether plugin is enabled in config
  experimental?: boolean              // Experimental feature flag
  dependencies?: string[]             // IDs of dependent plugins
  requires_login?: boolean            // Requires authentication
  features?: string[]                 // List of supported features
  platform?: string                   // For danmaku/publisher: associated platform ID
}

export interface PluginLoadResult {
  total: number
  loaded: number
  failed: number
  disabled: number
  details: {
    platform: {
      loaded: string[]
      failed: FailedPlugin[]
    }
    danmaku: {
      loaded: string[]
      failed: FailedPlugin[]
    }
    publisher: {
      loaded: string[]
      failed: FailedPlugin[]
    }
  }
}

export interface FailedPlugin {
  id: string
  type: string
  reason: string
  error?: string
  timestamp: number
}

export interface HealthStatus {
  id: string
  healthy: boolean
  status: 'ok' | 'error' | 'timeout' | 'missing' | 'disabled'
  lastCheck: number
  error?: string
  version?: string
}

export interface LoadResultDetail {
  success: boolean
  pluginId: string
  type: string
  error?: string
  loadTime?: number
}

export interface PluginConfigFile {
  version: string
  platforms: PlatformConfig[]
  danmaku: DanmakuConfig[]
  publishers: PublisherConfig[]
}

export interface PlatformConfig extends Omit<PluginMetadata, 'type'> {
  type?: never
}

export interface DanmakuConfig extends Omit<PluginMetadata, 'type'> {
  type?: never
  platform: string
}

export interface PublisherConfig extends Omit<PluginMetadata, 'type'> {
  type?: never
  platform: string
  requires_login?: boolean
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface HealthCheckReport {
  timestamp: number
  summary: {
    total: number
    healthy: number
    unhealthy: number
  }
  plugins: HealthStatus[]
  recommendations: string[]
}
