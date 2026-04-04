/**
 * ASR provider registry.
 * Manages multiple ASR providers and routes transcription requests.
 */

import { getConfig } from '../config'
import { getLogger } from '../utils/logger'
import { isWhisperLocalReady, transcribeLocal } from '../whisper-local'
import { ParaformerProvider } from './paraformer'
import { VolcengineProvider } from './volcengine'
import type { AsrProvider, AsrProviderType, AsrSegment } from './types'

export type { AsrSegment, AsrProviderType } from './types'

const logger = getLogger('asr')

let cachedProviders: Map<AsrProviderType, AsrProvider> | null = null

/**
 * Get all configured ASR providers.
 */
function getProviders(): Map<AsrProviderType, AsrProvider> {
  if (cachedProviders) return cachedProviders

  cachedProviders = new Map()
  const config = getConfig() as any
  const asrConfig = config.asr

  // Paraformer (DashScope)
  if (asrConfig?.paraformer?.api_key) {
    cachedProviders.set('paraformer', new ParaformerProvider(asrConfig.paraformer))
  }

  // Volcengine
  if (asrConfig?.volcengine?.app_id && asrConfig?.volcengine?.access_token) {
    cachedProviders.set('volcengine', new VolcengineProvider(asrConfig.volcengine))
  }

  // Whisper API (OpenAI-compatible)
  if (asrConfig?.whisper_api?.api_key && asrConfig?.whisper_api?.base_url) {
    // Reuse existing whisper API logic — imported lazily below
  }

  return cachedProviders
}

/**
 * Get the active ASR provider based on config.
 */
export function getActiveAsrProvider(): AsrProvider | null {
  const config = getConfig() as any
  const providerName = config.asr?.provider as AsrProviderType | undefined

  if (!providerName || providerName === 'whisper-local') {
    // Check if local whisper is ready
    if (isWhisperLocalReady()) return null  // null = use local whisper
    // Fall through to find any available provider
  }

  if (providerName) {
    const providers = getProviders()
    const provider = providers.get(providerName)
    if (provider?.isReady()) return provider
  }

  return null
}

/**
 * Check if any ASR capability is available (cloud or local).
 */
export function isAsrAvailable(): boolean {
  const config = getConfig() as any

  // Check local whisper
  if (isWhisperLocalReady()) return true

  // Check cloud providers
  const providerName = config.asr?.provider as AsrProviderType | undefined
  if (providerName && providerName !== 'whisper-local') {
    const providers = getProviders()
    const provider = providers.get(providerName)
    if (provider?.isReady()) return true
  }

  // Check legacy whisper config
  const whisper = config.ai?.whisper
  if (whisper?.enabled && whisper?.api_key) return true

  return false
}

/**
 * Transcribe audio using the configured ASR provider.
 * Returns segments with timestamps.
 */
export async function transcribeAudio(audioPath: string): Promise<AsrSegment[]> {
  const config = getConfig() as any
  const providerName = (config.asr?.provider || 'whisper-local') as AsrProviderType

  // Priority 1: Cloud ASR providers (if configured as active)
  if (providerName !== 'whisper-local') {
    const providers = getProviders()
    const provider = providers.get(providerName)
    if (provider?.isReady()) {
      logger.info(`Using ${provider.label} for transcription`)
      const segments = await provider.transcribe(audioPath, config.asr?.language)
      if (segments.length > 0) return segments
      logger.warn(`${provider.label} returned empty results, falling back`)
    }
  }

  // Priority 2: Local whisper.cpp
  if (isWhisperLocalReady()) {
    logger.info('Using local whisper.cpp for transcription')
    const segments = await transcribeLocal(audioPath)
    return segments.map(s => ({ start: s.start, end: s.end, text: s.text }))
  }

  // Priority 3: Legacy whisper API config (backwards compatible)
  const whisper = config.ai?.whisper
  if (whisper?.enabled && whisper?.api_key && whisper?.base_url) {
    logger.info('Using legacy whisper API config for transcription')
    // Import lazily to avoid circular dependency
    const { transcribeAudio: legacyTranscribe } = require('../ai-client')
    return await legacyTranscribe(audioPath)
  }

  throw new Error('No ASR provider configured. Please configure ASR in Settings.')
}

/**
 * Get info about all available providers for the settings UI.
 */
export function getAsrProviderInfo(): Array<{
  name: AsrProviderType
  label: string
  configured: boolean
  active: boolean
}> {
  const config = getConfig() as any
  const activeProvider = config.asr?.provider || 'whisper-local'

  const providers: Array<{ name: AsrProviderType; label: string; configured: boolean; active: boolean }> = [
    {
      name: 'whisper-local',
      label: 'Whisper (本地离线)',
      configured: isWhisperLocalReady(),
      active: activeProvider === 'whisper-local',
    },
    {
      name: 'paraformer',
      label: 'Paraformer (阿里 DashScope)',
      configured: !!(config.asr?.paraformer?.api_key),
      active: activeProvider === 'paraformer',
    },
    {
      name: 'volcengine',
      label: '火山引擎 ASR (剪映同款)',
      configured: !!(config.asr?.volcengine?.app_id && config.asr?.volcengine?.access_token),
      active: activeProvider === 'volcengine',
    },
  ]

  return providers
}

/**
 * Reset cached providers (call when config changes).
 */
export function resetAsrProviders(): void {
  cachedProviders = null
}
