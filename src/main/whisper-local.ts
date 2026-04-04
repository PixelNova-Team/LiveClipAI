import { existsSync, mkdirSync, unlinkSync, createWriteStream, readFileSync, copyFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { spawn, spawnSync } from 'child_process'
import https from 'https'
import http from 'http'
import { getLogger } from './utils/logger'
import { BrowserWindow } from 'electron'

const logger = getLogger('whisper-local')

// Available whisper models (name → size in MB)
const WHISPER_MODELS: Record<string, { file: string; sizeMB: number; label: string }> = {
  'base':            { file: 'ggml-base.bin',            sizeMB: 148,  label: 'Base (148MB, 快但中文差)' },
  'medium':          { file: 'ggml-medium.bin',          sizeMB: 1530, label: 'Medium (1.5GB, 中文较好)' },
  'large-v3-turbo':  { file: 'ggml-large-v3-turbo.bin',  sizeMB: 1620, label: 'Large-v3-turbo (1.6GB, 推荐)' },
}

// Default model for best Chinese accuracy/speed balance
const DEFAULT_MODEL = 'large-v3-turbo'

function getSelectedModel(): string {
  try {
    const { getConfig } = require('./config')
    const config = getConfig()
    return config.whisperLocalModel || DEFAULT_MODEL
  } catch {
    return DEFAULT_MODEL
  }
}

function getModelInfo() {
  const selected = getSelectedModel()
  return WHISPER_MODELS[selected] || WHISPER_MODELS[DEFAULT_MODEL]
}

function getModelUrls(): string[] {
  const info = getModelInfo()
  return [
    `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/${info.file}`,
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${info.file}`,
  ]
}

const WHISPER_REPO = 'https://github.com/ggerganov/whisper.cpp.git'
// v1.5.5 uses plain Makefile (no cmake dependency)
const WHISPER_TAG = 'v1.5.5'

export interface WhisperSegment {
  start: number  // seconds
  end: number
  text: string
}

/**
 * Get the whisper data directory (binary + model stored here).
 */
function getWhisperDir(): string {
  const dir = join(app.getPath('userData'), 'whisper')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Get the path to the whisper binary.
 */
function getWhisperBin(): string {
  // 1. Check system install (Homebrew)
  for (const name of ['whisper-cpp', 'whisper']) {
    const result = spawnSync('which', [name], { encoding: 'utf8', timeout: 3000 })
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim()
    }
  }

  // 2. Check local build
  const localBin = join(getWhisperDir(), 'bin', 'whisper-cli')
  if (existsSync(localBin)) return localBin

  // Legacy binary name
  const legacyBin = join(getWhisperDir(), 'bin', 'main')
  if (existsSync(legacyBin)) return legacyBin

  return ''
}

/**
 * Get the model file path.
 */
function getModelPath(): string {
  return join(getWhisperDir(), getModelInfo().file)
}

/**
 * Check if whisper is ready (binary + model both available).
 */
export function isWhisperLocalReady(): boolean {
  return !!getWhisperBin() && existsSync(getModelPath())
}

/**
 * Get setup status for UI display.
 */
export function getWhisperLocalStatus(): {
  ready: boolean
  hasBinary: boolean
  hasModel: boolean
  binaryPath: string
  modelPath: string
  modelName: string
  modelLabel: string
  availableModels: Array<{ value: string; label: string; sizeMB: number; downloaded: boolean }>
} {
  const bin = getWhisperBin()
  const modelPath = getModelPath()
  const selected = getSelectedModel()
  const info = getModelInfo()
  const whisperDir = getWhisperDir()
  return {
    ready: !!bin && existsSync(modelPath),
    hasBinary: !!bin,
    hasModel: existsSync(modelPath),
    binaryPath: bin,
    modelPath,
    modelName: selected,
    modelLabel: info.label,
    availableModels: Object.entries(WHISPER_MODELS).map(([k, v]) => ({
      value: k, label: v.label, sizeMB: v.sizeMB,
      downloaded: existsSync(join(whisperDir, v.file)),
    })),
  }
}

/**
 * Delete a downloaded model file.
 */
export function deleteWhisperModel(modelName: string): { success: boolean; error?: string } {
  const model = WHISPER_MODELS[modelName]
  if (!model) return { success: false, error: `Unknown model: ${modelName}` }

  const filePath = join(getWhisperDir(), model.file)
  if (!existsSync(filePath)) return { success: false, error: 'Model file not found' }

  try {
    unlinkSync(filePath)
    logger.info(`Deleted whisper model: ${filePath}`)
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
}

/**
 * Setup whisper.cpp: compile binary and download model.
 * Sends progress updates to renderer via IPC.
 */
export async function setupWhisperLocal(
  onProgress?: (stage: string, percent: number) => void,
): Promise<void> {
  const whisperDir = getWhisperDir()

  // Step 1: Ensure binary exists
  if (!getWhisperBin()) {
    onProgress?.('compiling', 0)
    await compileWhisper(whisperDir, onProgress)
  }

  // Step 2: Download model if missing
  const modelPath = getModelPath()
  if (!existsSync(modelPath)) {
    const info = getModelInfo()
    onProgress?.('downloading_model', 0)
    sendProgress('downloading_model', 0, { modelSize: info.sizeMB })
    await downloadModel(modelPath, getModelUrls(), onProgress)
  }

  if (!isWhisperLocalReady()) {
    throw new Error('Whisper setup failed: binary or model missing')
  }

  onProgress?.('ready', 100)
  logger.info('Whisper local setup complete')
}

/**
 * Transcribe audio using local whisper.cpp.
 * Returns word-level timestamped segments.
 */
export async function transcribeLocal(audioPath: string): Promise<WhisperSegment[]> {
  const bin = getWhisperBin()
  const modelPath = getModelPath()

  if (!bin) throw new Error('whisper binary not found')
  if (!existsSync(modelPath)) throw new Error('whisper model not found')

  // whisper.cpp requires 16kHz mono WAV. Our extractAudio already produces this.
  // Output JSON to a temp file
  const outputPrefix = audioPath.replace(/\.[^.]+$/, '_whisper')

  const selectedModel = getSelectedModel()
  logger.info(`Whisper local: model=${selectedModel}, transcribing ${audioPath}`)
  if (selectedModel === 'base') {
    logger.warn('Using "base" model — Chinese recognition will be poor. Switch to "large-v3-turbo" in Settings for much better results.')
  }
  const startTime = Date.now()

  // Use async spawn to avoid blocking the main process
  //
  // Key params for Chinese live stream recognition:
  // - `-ml 10`: max ~10 chars per segment for tight subtitle timing
  // - `-bs 5`: beam search with 5 beams for better accuracy
  // - `-et 0.5`: entropy threshold slightly relaxed to avoid filtering valid quiet speech
  const result = await runAsync(bin, [
    '-m', modelPath,
    '-f', audioPath,
    '-l', 'zh',           // Chinese language
    '-oj',                // Output JSON
    '-of', outputPrefix,  // Output file prefix
    '-ml', '10',          // Max 10 chars per segment for tight subtitle sync
    '-bs', '5',           // Beam search: better recognition accuracy
    '-et', '0.6',         // Entropy threshold: higher = stricter filtering of uncertain segments
    '-lpt', '-0.5',       // Log probability threshold: filter low-probability hallucinations
    '-mc', '0',           // Max context = 0: prevent hallucination loops from context carryover
    '--suppress-regex', '[♪♫♬\\[\\(【].*[\\]\\)】]|谢谢观看|字幕由|Subscribe',
    '--no-prints',
  ], { timeoutMs: 600000 })

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  if (result.code !== 0) {
    logger.error(`Whisper failed (${elapsed}s): ${result.stderr.slice(-300)}`)
    throw new Error(`Whisper transcription failed: ${result.stderr.slice(-300)}`)
  }

  // Parse the output JSON
  const jsonPath = `${outputPrefix}.json`
  if (!existsSync(jsonPath)) {
    throw new Error('Whisper produced no output JSON')
  }

  try {
    const raw = readFileSync(jsonPath, 'utf8')
    const json = JSON.parse(raw)
    const segments = parseWhisperJson(json)
    logger.info(`Whisper local: ${segments.length} segments in ${elapsed}s`)
    return segments
  } finally {
    // Clean up temp JSON
    try { unlinkSync(jsonPath) } catch { /* ignore */ }
  }
}

/**
 * Parse whisper.cpp JSON output into our segment format.
 * Handles silence gaps: preserves timing gaps between segments so subtitles
 * disappear during silence rather than stretching across it.
 */
function parseWhisperJson(json: any): WhisperSegment[] {
  const raw: WhisperSegment[] = []

  // whisper.cpp JSON format:
  // { "transcription": [{ "timestamps": {"from": "00:00:00,000", "to": "00:00:02,000"}, "text": "..." }] }
  const transcription = json.transcription || json.segments || []

  for (const seg of transcription) {
    let start: number
    let end: number
    let text: string

    if (seg.timestamps) {
      // whisper.cpp format
      start = parseTimestamp(seg.timestamps.from)
      end = parseTimestamp(seg.timestamps.to)
      text = (seg.text || '').trim()
    } else if (seg.offsets) {
      // Alternative format with millisecond offsets
      start = (seg.offsets.from || 0) / 1000
      end = (seg.offsets.to || 0) / 1000
      text = (seg.text || '').trim()
    } else {
      // OpenAI-style format
      start = seg.start || 0
      end = seg.end || 0
      text = (seg.text || '').trim()
    }

    // Clean text: strip leading/trailing punctuation and whitespace
    text = cleanSubtitleText(text)

    if (text && end > start && !isNoiseText(text)) {
      // Cap segment duration: Chinese speech is ~3-5 chars/second.
      // If segment is way too long for its text, whisper extended end time
      // into silence. Cap at max 1.5s per char (very generous) or 5s minimum.
      const maxDur = Math.max(5, text.length * 1.5)
      if (end - start > maxDur) {
        end = start + maxDur
      }
      raw.push({ start, end, text })
    }
  }

  // Pre-merge: detect and remove consecutive duplicate segments (hallucination loops).
  // E.g. "我看你","了","我看你","了","我看你","了" → keep only first occurrence
  const deduped: WhisperSegment[] = []
  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i]
    // Check if this segment repeats the pattern of recent segments
    if (deduped.length >= 2) {
      const prev1 = deduped[deduped.length - 1]
      const prev2 = deduped[deduped.length - 2]
      // Two-segment repeat pattern: A,B,A,B,A,B...
      if (i + 1 < raw.length && seg.text === prev2.text && raw[i + 1].text === prev1.text) {
        // Skip this and next (they repeat the pattern)
        i++ // skip next too
        continue
      }
    }
    if (deduped.length >= 1) {
      const prev = deduped[deduped.length - 1]
      // Single-segment repeat: A,A,A,A...
      if (seg.text === prev.text) {
        // Keep extending the previous segment's end time but don't add a new one
        prev.end = seg.end
        continue
      }
    }
    deduped.push({ ...seg })
  }
  if (deduped.length < raw.length) {
    logger.info(`Dedup filter: ${raw.length} → ${deduped.length} segments (removed ${raw.length - deduped.length} consecutive duplicates)`)
  }

  // Merge segments into subtitle-sized groups (6~12 chars) while keeping the tight
  // start/end timestamps from the first/last character in each group.
  //
  // Merge rules:
  // 1. Keep merging if gap < 0.3s AND combined length <= 12 chars
  // 2. Break at sentence punctuation (。！？) regardless of length
  // 3. Break at clause punctuation (，、；) if combined > 6 chars
  // 4. Break if gap >= 0.3s (silence = new subtitle)
  const merged: WhisperSegment[] = []
  const sentencePunct = /[。！？!?]$/
  const clausePunct = /[，、；;：:,]$/

  for (const seg of deduped) {
    const last = merged[merged.length - 1]

    if (!last) {
      merged.push({ ...seg })
      continue
    }

    const gap = seg.start - last.end
    const combinedLen = last.text.length + seg.text.length

    // Force break conditions
    const isSilenceGap = gap >= 0.3
    const lastEndsSentence = sentencePunct.test(last.text)
    const lastEndsClause = clausePunct.test(last.text) && combinedLen > 6
    const tooLong = combinedLen > 12

    if (isSilenceGap || lastEndsSentence || lastEndsClause || tooLong) {
      merged.push({ ...seg })
    } else {
      // Merge: keep first segment's start, extend end, concatenate text
      last.end = seg.end
      last.text = last.text + seg.text
    }
  }

  // Post-merge filter: remove segments that became repetitive after merging
  const filtered = merged.filter(seg => !isNoiseText(seg.text))
  if (filtered.length < merged.length) {
    logger.info(`Post-merge noise filter: removed ${merged.length - filtered.length} noisy segments`)
  }

  return filtered
}

/**
 * Clean subtitle text: remove stray punctuation, special characters, and garbled output.
 */
function cleanSubtitleText(text: string): string {
  let t = text.trim()
  // Remove leading punctuation (full-width and half-width)
  t = t.replace(/^[\s，。？！、,!?.…：:；;·\-—]+/, '')
  // Remove trailing ellipsis/dots that look like garbled output
  t = t.replace(/[.。…]{3,}$/, '')
  // Normalize spaces: collapse multiple spaces into one
  t = t.replace(/\s{2,}/g, ' ')
  // Remove zero-width characters and other invisible unicode
  t = t.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
  return t.trim()
}

/**
 * Filter out noise/hallucination text that whisper commonly produces.
 * These are typically background sounds, music, or repeated filler text.
 */
function isNoiseText(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  // Whisper hallucination patterns: [music], (applause), ♪, etc.
  if (/^\[.*\]$|^\(.*\)$|^【.*】$/.test(t)) return true
  // Music symbols
  if (/^[♪♫♬\s]+$/.test(t)) return true
  // Only punctuation / symbols (full-width and half-width): ？。！，、,!?.… etc.
  if (/^[\s\p{P}\p{S}]+$/u.test(t)) return true
  // Strip all punctuation — if nothing meaningful remains, it's noise
  const stripped = t.replace(/[\s\p{P}\p{S}]/gu, '')
  if (stripped.length === 0) return true
  // Too short after stripping punctuation (single char like "啊" or "嗯")
  if (stripped.length <= 1) return true
  // Single repeated character (e.g. "啊啊啊啊啊")
  if (stripped.length >= 3 && new Set(stripped).size <= 1) return true
  // Repetitive pattern hallucination (e.g. "我操我操我操", "对对对对")
  // If unique chars / total chars ratio is very low, it's likely a hallucination loop
  if (stripped.length >= 4 && new Set(stripped).size <= 2) return true
  // Detect repeating substrings: "ABCABC", "ABAB", "ABCDABCD" patterns
  if (stripped.length >= 4) {
    const maxPat = Math.min(Math.floor(stripped.length / 2), 6)
    for (let patLen = 1; patLen <= maxPat; patLen++) {
      const pat = stripped.slice(0, patLen)
      const repeated = pat.repeat(Math.ceil(stripped.length / patLen)).slice(0, stripped.length)
      if (repeated === stripped) return true
    }
  }
  // Common whisper hallucination phrases
  const hallucinations = [
    '谢谢观看', '字幕由', '字幕提供', '感谢观看', '请订阅',
    'Thank you', 'Subscribe', '请不吝点赞', 'Thanks for watching',
    '下集更精彩', '敬请期待', '欢迎收看',
  ]
  if (hallucinations.some(h => t.includes(h))) return true
  // Garbled / nonsensical: contains replacement chars or excessive non-CJK non-ASCII
  if (/\uFFFD/.test(t)) return true
  return false
}

/**
 * Parse timestamp string "HH:MM:SS,mmm" or "HH:MM:SS.mmm" to seconds.
 */
function parseTimestamp(ts: string): number {
  if (!ts) return 0
  const match = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!match) return 0
  return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000
}

/**
 * Run a command asynchronously (non-blocking).
 */
function runAsync(
  cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: opts?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    let killed = false

    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    proc.stdout?.on('data', () => { /* drain */ })
    proc.on('close', (code) => resolve({ code: killed ? 1 : (code ?? 1), stderr }))
    proc.on('error', (err) => resolve({ code: 1, stderr: err.message }))

    if (opts?.timeoutMs) {
      setTimeout(() => {
        if (!proc.killed) { killed = true; proc.kill('SIGKILL') }
      }, opts.timeoutMs)
    }
  })
}

/**
 * Compile whisper.cpp from source (fully async, non-blocking).
 */
async function compileWhisper(
  whisperDir: string,
  onProgress?: (stage: string, percent: number) => void,
): Promise<void> {
  const srcDir = join(whisperDir, 'whisper.cpp')
  const binDir = join(whisperDir, 'bin')

  // Clone if not already present
  if (!existsSync(join(srcDir, 'Makefile'))) {
    logger.info('Cloning whisper.cpp...')
    onProgress?.('cloning', 10)
    sendProgress('cloning', 10)

    // Remove old directory if exists
    if (existsSync(srcDir)) {
      await runAsync('rm', ['-rf', srcDir], { timeoutMs: 10000 })
    }

    const cloneResult = await runAsync('git', [
      'clone', '--depth', '1', '--branch', WHISPER_TAG,
      WHISPER_REPO, srcDir,
    ], { timeoutMs: 120000 })

    if (cloneResult.code !== 0) {
      throw new Error(`Git clone failed: ${cloneResult.stderr.slice(-200)}`)
    }
  }

  // Compile (v1.5.5 uses plain Makefile, target = main)
  logger.info('Compiling whisper.cpp...')
  onProgress?.('compiling', 30)
  sendProgress('compiling', 30)

  // Detect number of CPU cores for parallel compilation
  let nproc = '4'
  try {
    const result = spawnSync('sysctl', ['-n', 'hw.ncpu'], { encoding: 'utf8', timeout: 3000 })
    if (result.stdout?.trim()) nproc = result.stdout.trim()
  } catch { /* use default */ }

  const makeResult = await runAsync('make', [`-j${nproc}`, 'main'], {
    cwd: srcDir,
    timeoutMs: 300000,
  })

  if (makeResult.code !== 0) {
    throw new Error(`Compile failed: ${makeResult.stderr.slice(-300)}`)
  }

  onProgress?.('compiling', 90)
  sendProgress('compiling', 90)

  // Copy binary to bin directory
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true })

  const builtBin = join(srcDir, 'main')
  if (!existsSync(builtBin)) {
    throw new Error(`Compiled binary not found at ${builtBin}`)
  }

  const targetBin = join(binDir, 'whisper-cli')
  copyFileSync(builtBin, targetBin)
  chmodSync(targetBin, 0o755)

  logger.info(`Whisper binary installed: ${targetBin}`)
  onProgress?.('compiling', 100)
  sendProgress('compiling', 100)
}

/**
 * Send progress update to renderer windows.
 */
function sendProgress(stage: string, percent: number, extra?: Record<string, any>): void {
  try {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('whisper:progress', { stage, percent, ...extra })
    }
  } catch { /* ignore */ }
}

/**
 * Download whisper model, trying mirror URLs in order.
 */
async function downloadModel(
  targetPath: string,
  urls: string[],
  onProgress?: (stage: string, percent: number) => void,
): Promise<void> {
  const errors: string[] = []

  for (const modelUrl of urls) {
    logger.info(`Trying to download whisper model from: ${modelUrl}`)
    sendProgress('downloading_model', 0, { source: modelUrl })

    try {
      await downloadFromUrl(modelUrl, targetPath, onProgress)
      return // success
    } catch (e: any) {
      logger.warn(`Download failed from ${modelUrl}: ${e.message}`)
      errors.push(`${modelUrl}: ${e.message}`)
      // Clean up partial download
      const tmpPath = targetPath + '.tmp'
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
    }
  }

  throw new Error(`All download mirrors failed:\n${errors.join('\n')}`)
}

/**
 * Download a file from a URL with redirect following and progress reporting.
 */
function downloadFromUrl(
  url: string,
  targetPath: string,
  onProgress?: (stage: string, percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpPath = targetPath + '.tmp'

    const doRequest = (reqUrl: string, redirectCount: number = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'))
        return
      }

      const mod = reqUrl.startsWith('https') ? https : http
      const req = mod.get(reqUrl, (res) => {
        // Follow redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location
          if (location) {
            doRequest(location, redirectCount + 1)
            return
          }
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10)
        let downloaded = 0

        const file = createWriteStream(tmpPath)
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          file.write(chunk)
          if (totalBytes > 0) {
            const pct = Math.round((downloaded / totalBytes) * 100)
            onProgress?.('downloading_model', pct)
            sendProgress('downloading_model', pct, {
              downloaded: Math.round(downloaded / 1024 / 1024),
              total: Math.round(totalBytes / 1024 / 1024),
            })
          }
        })

        res.on('end', () => {
          file.end(() => {
            try {
              const fs = require('fs')
              fs.renameSync(tmpPath, targetPath)
              logger.info(`Model downloaded: ${targetPath} (${Math.round(downloaded / 1024 / 1024)}MB)`)
              resolve()
            } catch (e: any) {
              reject(new Error(`Failed to save model: ${e.message}`))
            }
          })
        })

        res.on('error', (e: Error) => {
          file.end()
          try { unlinkSync(tmpPath) } catch { /* ignore */ }
          reject(e)
        })
      })

      req.on('error', (e: Error) => reject(e))
      req.setTimeout(600000, () => {
        req.destroy()
        reject(new Error('Download timeout'))
      })
    }

    doRequest(url)
  })
}
