import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import YAML from 'yaml'
import { getLogger } from './utils/logger'

const logger = getLogger('config')

export interface AppConfig {
  ai: {
    active_provider: string
    providers: Record<string, { base_url: string; api_key: string; model: string }>
    /** Whisper speech-to-text config (separate from LLM, since most Chinese LLMs don't support it) */
    whisper?: {
      enabled: boolean
      base_url: string   // e.g. "https://api.openai.com/v1" or "https://api.groq.com/openai/v1"
      api_key: string
      model: string      // e.g. "whisper-1" or "whisper-large-v3"
    }
    // Legacy fields (for migration)
    provider?: string
    api_key?: string
    model?: string
    base_url?: string
  }
  live: {
    analysis_interval: number
    record_duration: number
    custom_keywords: Record<string, number>
  }
  slice: {
    pre_buffer: number
    post_buffer: number
    min_duration: number
    max_duration: number
    burst_threshold: number
    heating_threshold: number
    // Signal weights (sum to 1.0, auto-redistributed when signals unavailable)
    danmaku_weight: number
    audio_weight: number
    ai_weight: number
    // Max concurrent slice jobs across all monitors (default 1)
    max_concurrent_slices: number
  }
  storage: {
    output_dir: string
    cache_dir: string
    temp_dir: string
  }
  publish: {
    auto_publish: boolean
    auto_publish_threshold: number
    default_platforms: string[]
    show_publish_window: boolean
    default_description: string
    default_tags: string[]
  }
  /** ASR (speech recognition) provider config — independent from LLM */
  asr: {
    /** Active provider: 'whisper-local' | 'paraformer' | 'volcengine' */
    provider: string
    language?: string
    paraformer?: {
      api_key: string
      model?: string
    }
    volcengine?: {
      app_id: string
      access_token: string
    }
  }
  /** Local whisper.cpp model: 'base' | 'medium' | 'large-v3-turbo' */
  whisperLocalModel?: string
  logging: {
    level: string
  }
}

const DEFAULT_CONFIG: AppConfig = {
  ai: {
    active_provider: 'qwen',
    providers: {},
  },
  live: {
    analysis_interval: 1,
    record_duration: 0,
    custom_keywords: {},
  },
  slice: {
    pre_buffer: 5,
    post_buffer: 3,
    min_duration: 10,
    max_duration: 120,
    burst_threshold: 0.6,
    heating_threshold: 0.35,
    danmaku_weight: 0.45,
    audio_weight: 0.25,
    ai_weight: 0.30,
    max_concurrent_slices: 1,
  },
  publish: {
    auto_publish: false,
    auto_publish_threshold: 0.6,
    default_platforms: [],
    show_publish_window: false,
    default_description: '',
    default_tags: ['直播切片', '精彩时刻'],
  },
  asr: {
    provider: 'whisper-local',
  },
  storage: {
    output_dir: '',
    cache_dir: '',
    temp_dir: '',
  },
  logging: {
    level: 'info',
  },
}

let currentConfig: AppConfig | null = null

function getConfigPath(): string {
  try {
    return join(app.getPath('userData'), 'config.yaml')
  } catch {
    return join(process.cwd(), 'config.yaml')
  }
}

function getDefaultDirs(): { output: string; cache: string; temp: string } {
  try {
    const base = app.getPath('userData')
    return {
      output: join(base, 'output'),
      cache: join(base, 'cache'),
      temp: join(base, 'temp'),
    }
  } catch {
    return {
      output: join(process.cwd(), 'output'),
      cache: join(process.cwd(), 'cache'),
      temp: join(process.cwd(), 'temp'),
    }
  }
}

export function loadConfig(): AppConfig {
  if (currentConfig) return currentConfig

  const configPath = getConfigPath()
  let config = { ...DEFAULT_CONFIG }

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = YAML.parse(raw)
      config = deepMerge(config, parsed)
      logger.info(`Config loaded from ${configPath}`)
    } catch (e) {
      logger.warn('Failed to load config, using defaults:', e)
    }
  }

  // Migrate: burst_threshold from live to slice
  if ((config as any).live?.burst_threshold !== undefined && config.slice.burst_threshold === DEFAULT_CONFIG.slice.burst_threshold) {
    config.slice.burst_threshold = (config as any).live.burst_threshold
    delete (config as any).live.burst_threshold
  }

  // Migrate: old custom_keywords from string[] to Record<string,number>
  const oldKw = (config as any).slice?.custom_keywords
  if (Array.isArray(oldKw)) {
    const kwObj: Record<string, number> = {}
    for (const kw of oldKw) kwObj[kw] = 5
    config.live.custom_keywords = { ...kwObj, ...config.live.custom_keywords }
    delete (config as any).slice.custom_keywords
  }

  // Fill in default directories
  const dirs = getDefaultDirs()
  if (!config.storage.output_dir) config.storage.output_dir = dirs.output
  if (!config.storage.cache_dir) config.storage.cache_dir = dirs.cache
  if (!config.storage.temp_dir) config.storage.temp_dir = dirs.temp

  // Ensure directories exist
  for (const dir of [config.storage.output_dir, config.storage.cache_dir, config.storage.temp_dir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  currentConfig = config
  return config
}

export function saveConfig(updates: Partial<AppConfig>): AppConfig {
  const config = loadConfig()
  const merged = deepMerge(config, updates as any)
  currentConfig = merged

  const configPath = getConfigPath()
  writeFileSync(configPath, YAML.stringify(merged), 'utf-8')
  logger.info(`Config saved to ${configPath}`)

  return merged
}

export function getConfig(): AppConfig {
  return loadConfig()
}

function deepMerge(target: any, source: any): any {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key])
    } else if (source[key] !== undefined) {
      result[key] = source[key]
    }
  }
  return result
}
