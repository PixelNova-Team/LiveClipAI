/**
 * ASR (Automatic Speech Recognition) provider system.
 * Supports multiple providers with word-level timestamps.
 */

export interface AsrSegment {
  /** Start time in seconds */
  start: number
  /** End time in seconds */
  end: number
  /** Recognized text */
  text: string
  /** Word-level timestamps (if available) */
  words?: AsrWord[]
}

export interface AsrWord {
  /** Start time in seconds */
  start: number
  /** End time in seconds */
  end: number
  /** Single word/character */
  text: string
}

export type AsrProviderType = 'paraformer' | 'volcengine' | 'whisper-local' | 'whisper-api'

export interface AsrProviderConfig {
  paraformer?: {
    api_key: string
    model?: string       // default: paraformer-v2
    language?: string    // default: zh
  }
  volcengine?: {
    app_id: string
    access_token: string
  }
  whisper_api?: {
    base_url: string
    api_key: string
    model?: string       // default: whisper-large-v3
  }
}

export interface AsrProvider {
  readonly name: AsrProviderType
  readonly label: string
  /** Check if this provider is configured and ready */
  isReady(): boolean
  /** Transcribe an audio file, returning segments with timestamps */
  transcribe(audioPath: string, language?: string): Promise<AsrSegment[]>
}
