import { spawn } from 'child_process'
import { existsSync, openSync, readSync, closeSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getLogger } from './utils/logger'

const logger = getLogger('ffmpeg')

/** Cached result of subtitles filter availability check */
let subtitlesFilterAvailable: boolean | null = null

/**
 * Check if the current ffmpeg supports the 'subtitles' filter (requires libass).
 * Result is cached after first check.
 */
export function hasSubtitlesFilter(): boolean {
  if (subtitlesFilterAvailable !== null) return subtitlesFilterAvailable
  try {
    const { spawnSync } = require('child_process')
    const result = spawnSync(getFFmpegPath(), ['-filters'], { encoding: 'utf8', timeout: 5000 })
    const output = (result.stdout || '') + (result.stderr || '')
    // subtitles filter handles both SRT and ASS files (requires libass)
    subtitlesFilterAvailable = output.includes('subtitles')
    if (!subtitlesFilterAvailable) {
      logger.warn('ffmpeg lacks subtitles/ass filter (no libass) — subtitle burn-in disabled')
    }
  } catch {
    subtitlesFilterAvailable = false
  }
  return subtitlesFilterAvailable
}

/**
 * Get video width and height using ffprobe / ffmpeg.
 * Returns { width, height } or null if detection fails.
 */
export async function getVideoResolution(videoPath: string): Promise<{ width: number; height: number } | null> {
  try {
    const ffprobePath = getFFmpegPath().replace(/ffmpeg(\.exe)?$/, 'ffprobe$1')
    const probeBin = existsSync(ffprobePath) ? ffprobePath : 'ffprobe'
    const { spawnSync } = require('child_process')
    const result = spawnSync(probeBin, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      videoPath,
    ], { encoding: 'utf8', timeout: 10000 })

    const json = JSON.parse(result.stdout)
    const stream = json.streams?.[0]
    if (stream?.width && stream?.height) {
      return { width: Number(stream.width), height: Number(stream.height) }
    }
  } catch (e: any) {
    logger.warn(`getVideoResolution failed: ${e.message}`)
  }
  return null
}

export function getFFmpegPath(): string {
  // Windows: Check bundled ffmpeg.exe from static/ffmpeg/win (extraResources)
  if (process.platform === 'win32') {
    try {
      const ext = '.exe'
      const resourcePath = join(app.getAppPath(), '..', 'ffmpeg', `ffmpeg${ext}`)
      if (existsSync(resourcePath)) {
        logger.info(`Using bundled Windows ffmpeg: ${resourcePath}`)
        return resourcePath
      }
    } catch (e) {
      logger.warn(`Failed to check bundled Windows ffmpeg: ${e}`)
    }
  }

  // macOS/Linux: Check ffmpeg-static (bundled in node_modules and unpacked by asar)
  // Verify it's actually executable — macOS Gatekeeper may block unsigned binaries
  try {
    const ffmpegStatic = require('ffmpeg-static')
    if (ffmpegStatic && existsSync(ffmpegStatic)) {
      // Ensure execute permission
      try {
        require('fs').chmodSync(ffmpegStatic, 0o755)
      } catch { /* ignore */ }

      // Verify binary actually runs (macOS blocks unsigned binaries with error -88)
      const { spawnSync } = require('child_process')
      const test = spawnSync(ffmpegStatic, ['-version'], { timeout: 3000, encoding: 'utf8' })
      if (test.error) {
        logger.warn(`ffmpeg-static blocked by OS (${test.error.message}), using system ffmpeg`)
      } else {
        logger.info(`Using ffmpeg-static: ${ffmpegStatic}`)
        return ffmpegStatic
      }
    }
  } catch (e) {
    logger.warn(`ffmpeg-static not available: ${e}`)
  }

  // Fall back to system ffmpeg
  logger.warn('Falling back to system ffmpeg')
  return 'ffmpeg'
}

export function runFFmpeg(args: string[], timeoutMs?: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const ffmpegPath = getFFmpegPath()
    logger.debug(`Running: ${ffmpegPath} ${args.join(' ')}`)

    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let killed = false

    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    proc.on('close', (code) => resolve({ code: killed ? 1 : (code ?? 1), stderr }))
    proc.on('error', (err) => resolve({ code: 1, stderr: err.message }))

    if (timeoutMs && timeoutMs > 0) {
      setTimeout(() => {
        if (!proc.killed) {
          killed = true
          proc.kill('SIGKILL')
          logger.warn(`FFmpeg killed after ${timeoutMs}ms timeout`)
        }
      }, timeoutMs)
    }
  })
}

/**
 * Detect silence intervals in an audio file using ffmpeg silencedetect.
 * Returns an array of speech boundaries: [{start, end}, ...] representing
 * time ranges where speech is present (gaps between silence).
 */
export async function detectSpeechSegments(audioPath: string): Promise<Array<{ start: number; end: number }>> {
  // silencedetect outputs lines like:
  //   [silencedetect @ ...] silence_start: 1.234
  //   [silencedetect @ ...] silence_end: 2.567 | silence_duration: 1.333
  const result = await runFFmpeg([
    '-i', audioPath,
    '-af', 'silencedetect=noise=-30dB:d=0.5',
    '-f', 'null', '-',
  ], 30000)

  const stderr = result.stderr
  const silenceStartRegex = /silence_start:\s*([\d.]+)/g
  const silenceEndRegex = /silence_end:\s*([\d.]+)/g

  const silenceStarts: number[] = []
  const silenceEnds: number[] = []
  let m: RegExpExecArray | null
  while ((m = silenceStartRegex.exec(stderr)) !== null) silenceStarts.push(parseFloat(m[1]))
  while ((m = silenceEndRegex.exec(stderr)) !== null) silenceEnds.push(parseFloat(m[1]))

  // Get total audio duration
  const durMatch = stderr.match(/time=(\d+):(\d+):(\d[\d.]*)/g)
  let totalDuration = 0
  if (durMatch) {
    const last = durMatch[durMatch.length - 1]
    const parts = last.replace('time=', '').split(':')
    totalDuration = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2])
  }

  // Build speech segments (inverse of silence)
  const speechSegments: Array<{ start: number; end: number }> = []
  let cursor = 0

  for (let i = 0; i < silenceStarts.length; i++) {
    const silStart = silenceStarts[i]
    if (silStart > cursor + 0.1) {
      speechSegments.push({ start: cursor, end: silStart })
    }
    cursor = silenceEnds[i] ?? silStart + 0.3
  }

  // Add final speech segment after last silence
  if (totalDuration > 0 && cursor < totalDuration - 0.1) {
    speechSegments.push({ start: cursor, end: totalDuration })
  }

  // If no silence detected, return entire audio as one segment
  if (speechSegments.length === 0 && totalDuration > 0) {
    speechSegments.push({ start: 0, end: totalDuration })
  }

  logger.info(`detectSpeechSegments: found ${speechSegments.length} speech segments, ${silenceStarts.length} silences`)
  return speechSegments
}

/**
 * Extract the meaningful error from ffmpeg stderr.
 * FFmpeg stderr always starts with version/config info (500+ chars),
 * the actual error is in the last few lines.
 */
function extractFFmpegError(stderr: string, maxLen: number = 300): string {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
  // Take last lines that contain the actual error
  const errorLines = lines.slice(-6).join(' | ')
  if (errorLines.length > 0) return errorLines.slice(0, maxLen)
  return stderr.slice(-maxLen)
}

/**
 * Extract a segment from a live .ts file using stream copy (very fast).
 * This creates a finite, complete file that won't cause FFmpeg to hang
 * waiting for more data from the still-growing source.
 */
export async function extractTsSegment(
  input: string, output: string, startSec: number, duration: number,
  timeoutMs: number = 60000
): Promise<void> {
  const args = [
    '-y',
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '5000000', '-probesize', '5000000', '-f', 'mpegts',
    '-ss', String(startSec),
    '-i', input,
    '-t', String(duration),
    '-c', 'copy',  // stream copy = instant, no re-encoding
    '-avoid_negative_ts', 'make_zero',  // normalize timestamps to prevent audio gaps
    '-f', 'mpegts',
    output,
  ]
  const result = await runFFmpeg(args, timeoutMs)
  if (result.code !== 0) {
    throw new Error(`FFmpeg segment extraction failed: ${extractFFmpegError(result.stderr)}`)
  }
}

/** MPEG-TS packet size — all packets are exactly 188 bytes */
const TS_PACKET_SIZE = 188
/** MPEG-TS sync byte — every packet starts with 0x47 */
const TS_SYNC_BYTE = 0x47

/**
 * Read the last `bytes` of a file into memory, aligned to MPEG-TS packet boundaries.
 * O(1) seek — doesn't read through the whole file, works even while file is being written.
 * Scans forward from the read offset to find the first 0x47 sync byte at a 188-byte boundary,
 * ensuring FFmpeg gets clean packet data without costly resync.
 */
function readFileTail(src: string, bytes: number): Buffer | null {
  try {
    const stat = statSync(src)
    const fileSize = stat.size
    if (fileSize < 1024) return null
    const readSize = Math.min(bytes, fileSize)
    const offset = fileSize - readSize
    const fd = openSync(src, 'r')
    try {
      const buf = Buffer.alloc(readSize)
      const bytesRead = readSync(fd, buf, 0, readSize, offset)

      // Find first valid TS sync byte (0x47) that also has 0x47 at +188 and +376
      let syncOffset = 0
      for (; syncOffset < Math.min(bytesRead - TS_PACKET_SIZE * 3, TS_PACKET_SIZE * 10); syncOffset++) {
        if (buf[syncOffset] === TS_SYNC_BYTE &&
            buf[syncOffset + TS_PACKET_SIZE] === TS_SYNC_BYTE &&
            buf[syncOffset + TS_PACKET_SIZE * 2] === TS_SYNC_BYTE) {
          break
        }
      }
      if (syncOffset >= TS_PACKET_SIZE * 10) syncOffset = 0  // fallback: let FFmpeg handle it

      return buf.subarray(syncOffset, bytesRead)
    } finally {
      closeSync(fd)
    }
  } catch (e: any) {
    logger.warn(`readFileTail failed: ${e.message}`)
    return null
  }
}

/**
 * Copy the last `bytes` of a file to `dest`, aligned to MPEG-TS packet boundaries.
 * Wrapper around readFileTail for callers that need a file on disk (e.g. extractCover).
 */
function copyFileTail(src: string, dest: string, bytes: number): boolean {
  const data = readFileTail(src, bytes)
  if (!data) return false
  writeFileSync(dest, data)
  return true
}

/**
 * Pipe MPEG-TS data into FFmpeg via stdin and extract audio.
 * Using pipe:0 input solves the EOF problem — when the pipe closes,
 * FFmpeg's MPEG-TS demuxer definitively stops (unlike file input where
 * the streaming demuxer may keep waiting for more packets).
 */
function extractAudioFromPipe(
  data: Buffer, output: string, timeoutMs: number = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFFmpegPath()
    const args = [
      '-y',
      '-f', 'mpegts',       // input format hint for piped data
      '-probesize', '1000000',
      '-analyzeduration', '1000000',
      '-i', 'pipe:0',       // read from stdin
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      output,
    ]

    logger.debug(`Pipe FFmpeg: ${ffmpegPath} ${args.join(' ')}`)
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let killed = false
    let done = false

    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      if (done) return
      done = true
      if (killed || (code !== null && code !== 0)) {
        reject(new Error(`FFmpeg pipe extract failed (code=${code}): ${extractFFmpegError(stderr)}`))
      } else {
        resolve()
      }
    })

    proc.on('error', (err) => {
      if (done) return
      done = true
      reject(err)
    })

    const timer = setTimeout(() => {
      if (!proc.killed) {
        killed = true
        proc.kill('SIGKILL')
        logger.warn(`FFmpeg pipe killed after ${timeoutMs}ms timeout`)
      }
    }, timeoutMs)

    proc.on('close', () => clearTimeout(timer))

    // Write all data to stdin, then close the pipe.
    // Closing stdin is what signals EOF to FFmpeg's MPEG-TS demuxer.
    proc.stdin?.write(data, () => {
      proc.stdin?.end()
    })
    proc.stdin?.on('error', () => { /* ignore broken pipe errors */ })
  })
}

export async function extractAudio(
  input: string, output: string, startSec?: number, duration?: number, timeoutMs?: number
): Promise<void> {
  const isMpegTs = input.endsWith('.ts') || input.endsWith('.mpegts')
  const isLiveTs = input.endsWith('.ts')  // only .ts is actively growing

  logger.info(`[FFmpeg-Audio] Extracting audio: input=${input}, startSec=${startSec}, duration=${duration}s, timeout=${timeoutMs}ms, isLiveTs=${isLiveTs}`)

  // For live .ts files that are actively growing:
  // FFmpeg hangs reading growing files AND hangs on static tail-copy files
  // (MPEG-TS demuxer never sees a clean EOF, keeps waiting for more packets).
  // Solution: read last 3MB into memory, pipe to FFmpeg via stdin.
  // When stdin closes, FFmpeg receives a definitive EOF and finishes immediately.
  if (isLiveTs && duration !== undefined) {
    const tailBytes = 3 * 1024 * 1024  // 3MB ≈ 8-12 seconds at typical bitrate
    const tailData = readFileTail(input, tailBytes)
    if (tailData) {
      logger.info(`[FFmpeg-Audio] Piping ${(tailData.length / 1024).toFixed(0)}KB tail data to FFmpeg (live .ts)`)
      await extractAudioFromPipe(tailData, output, 5000)
      logger.info(`[FFmpeg-Audio] Pipe extraction completed, output=${output}`)
      return
    }
    logger.warn(`[FFmpeg-Audio] Tail read failed, falling back to direct file read`)
  }

  // Non-live files or fallback: standard file-based extraction
  const args = ['-y']
  if (isMpegTs || input.endsWith('.ts')) {
    args.push('-fflags', '+genpts+discardcorrupt+igndts')
    args.push('-analyzeduration', '5000000', '-probesize', '5000000', '-f', 'mpegts')
  }
  if (startSec !== undefined) args.push('-ss', String(startSec))
  args.push('-i', input)
  if (duration !== undefined) args.push('-t', String(duration))
  args.push('-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
    '-af', 'aresample=async=1000',
    output)

  logger.debug(`[FFmpeg-Audio] Running FFmpeg: ${args.join(' ')}`)
  const result = await runFFmpeg(args, timeoutMs || 30000)
  if (result.code !== 0) {
    const err = `FFmpeg extract audio failed (code=${result.code}): ${extractFFmpegError(result.stderr)}`
    logger.error(`[FFmpeg-Audio] ${err}`)
    throw new Error(err)
  }
  logger.info(`[FFmpeg-Audio] Audio extraction completed successfully, output=${output}`)
}

export async function sliceVideo(
  input: string, output: string, startSec: number, endSec: number,
  headers?: Record<string, string>,
  subtitlePath?: string,
  videoResolution?: { width: number; height: number } | null,
  outputResolution?: string,
): Promise<void> {
  const isMpegTs = input.endsWith('.ts') || input.endsWith('.mpegts')
  const isLiveTs = input.endsWith('.ts')  // only .ts is actively growing
  const clipDuration = endSec - startSec
  let actualInput = input
  let tmpSegment = ''
  let actualStart = startSec
  let actualDuration = clipDuration

  // For live .ts files being actively written:
  // Step 1: Extract the segment via stream copy into a temp file (instant, no re-encode).
  // NOTE: When caller pre-extracts a shared segment (.mpegts), this is skipped.
  if (isLiveTs) {
    tmpSegment = input.replace(/\.ts$/, `_slice_seg_${Date.now()}.ts`)
    // Grab a bit extra before/after for keyframe alignment
    const grabStart = Math.max(0, startSec - 10)
    const grabDuration = clipDuration + 15
    logger.info(`sliceVideo: extracting segment ${grabStart.toFixed(0)}s~${(grabStart + grabDuration).toFixed(0)}s via stream copy`)
    try {
      await extractTsSegment(input, tmpSegment, grabStart, grabDuration)
      actualInput = tmpSegment
      // Adjust seek position relative to the temp file
      actualStart = startSec - grabStart
      actualDuration = clipDuration
      logger.info(`sliceVideo: segment extracted, re-encoding from temp file (start=${actualStart.toFixed(1)}s, dur=${actualDuration.toFixed(0)}s)`)
    } catch (e: any) {
      logger.warn(`Segment extraction failed, falling back to direct read: ${e.message}`)
      tmpSegment = ''
      // Fall through to direct read below
    }
  }

  try {
    const args = ['-y']

    if (actualInput.endsWith('.ts') || actualInput.endsWith('.mpegts')) {
      // genpts: regenerate PTS to fix discontinuities from stream-copy extraction
      // discardcorrupt: skip damaged packets that cause audio dropout
      args.push('-fflags', '+genpts+discardcorrupt')
      args.push('-analyzeduration', '10000000', '-probesize', '10000000', '-f', 'mpegts')
    }

    if (headers && !tmpSegment) {
      const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n'
      args.push('-headers', headerStr)
    }

    // Seeking strategy depends on whether subtitles are being burned in.
    // Two-pass seeking (-ss before AND after -i) breaks subtitle sync because
    // the subtitle filter sees frames from PTS 0 (= coarseSeek), but SRT timestamps
    // are 0-based relative to the actual clip start. This causes subtitles to appear
    // ~fineSeek seconds early, with the first few seconds of subtitles lost entirely.
    //
    // With subtitles: use single input-seek so PTS 0 = clip start = SRT time 0.
    // Without subtitles: use two-pass for frame-accurate cuts.
    const hasSubtitles = subtitlePath && existsSync(subtitlePath)

    if (hasSubtitles) {
      // Single-pass: input seek directly to target, PTS starts from 0 = clip start
      args.push(
        '-ss', String(actualStart),
        '-i', actualInput,
        '-t', String(actualDuration),
      )
    } else {
      // Two-pass: coarse input seek + fine output seek for frame-accurate cuts
      const coarseSeek = Math.max(0, actualStart - 3)
      const fineSeek = actualStart - coarseSeek
      args.push(
        '-ss', String(coarseSeek),
        '-i', actualInput,
        '-ss', String(fineSeek),
        '-t', String(actualDuration),
      )
    }

    // Re-encode video for clean output.
    const vf: string[] = []

    // Burn in subtitles if provided
    if (hasSubtitles) {
      const escaped = subtitlePath!
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, '\\\u0027')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/ /g, '\\ ')
      if (subtitlePath!.endsWith('.ass')) {
        // ASS files have built-in styles (font, size, color, position, resolution).
        // Use `subtitles=` filter (not `ass=`) because `subtitles` handles both
        // SRT and ASS, while `ass` filter may not be available in all ffmpeg builds.
        logger.info(`Using ASS subtitle with built-in styles: ${subtitlePath}`)
        vf.push(`subtitles=${escaped}`)
      } else if (subtitlePath!.endsWith('.srt')) {
        // SRT fallback: apply force_style for styling
        const w = videoResolution?.width || 1920
        const h = videoResolution?.height || 1080
        const isPortrait = h > w
        let fontSize: number
        if (isPortrait) {
          fontSize = Math.round(w * 0.052)
        } else {
          fontSize = Math.round(h * 0.067)
        }
        fontSize = Math.max(36, Math.min(120, fontSize))
        const outline = Math.max(2, Math.round(fontSize / 16))
        const marginV = Math.round(h * 0.055)
        const marginLR = Math.round(w * 0.025)
        logger.info(`SRT subtitle style: ${w}x${h}, fontSize=${fontSize}, outline=${outline}`)
        vf.push(`subtitles=${escaped}:force_style='FontName=PingFang SC,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=${outline},Shadow=1,Alignment=2,MarginV=${marginV},MarginL=${marginLR},MarginR=${marginLR},Bold=-1,WrapStyle=0,PlayResX=${w},PlayResY=${h}'`)
      } else {
        vf.push(`subtitles=${escaped}`)
      }
    }

    // Scale to target output resolution if configured (e.g. "1920x1080", "1280x720")
    if (outputResolution) {
      const match = outputResolution.match(/^(\d+)x(\d+)$/)
      if (match) {
        const [, ow, oh] = match
        // scale + pad to exact resolution, preserving aspect ratio
        vf.push(`scale=${ow}:${oh}:force_original_aspect_ratio=decrease,pad=${ow}:${oh}:(ow-iw)/2:(oh-ih)/2:black`)
        logger.info(`Output resolution: scaling to ${ow}x${oh}`)
      }
    }

    if (vf.length > 0) {
      args.push('-vf', vf.join(','))
    }

    // aresample=async=1000: fill audio gaps/discontinuities from TS stream copy
    // This prevents the "only first few seconds have audio" problem
    args.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '20',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-af', 'aresample=async=1000',
      '-max_muxing_queue_size', '2048',
      '-movflags', '+faststart',
      output,
    )

    // Encoding from a finite temp file is predictable — timeout scales with clip duration
    const encodeTimeout = Math.max(60000, (30 + clipDuration * 2) * 1000)
    logger.info(`sliceVideo: encoding ${actualDuration.toFixed(0)}s clip, timeout=${(encodeTimeout / 1000).toFixed(0)}s`)
    const result = await runFFmpeg(args, encodeTimeout)
    if (result.code !== 0) {
      const isSubtitleError = subtitlePath && vf.length > 0 && (
        result.stderr.includes('No such filter') ||
        result.stderr.includes('No option name') ||
        result.stderr.includes('Error parsing filter')
      )
      if (isSubtitleError) {
        logger.warn('Subtitles filter unavailable (ffmpeg lacks libass), retrying without subtitles')
        // Retry without subtitles — pass actualInput to avoid re-extracting segment
        const retryArgs = ['-y']
        if (actualInput.endsWith('.ts') || actualInput.endsWith('.mpegts')) {
          retryArgs.push('-fflags', '+genpts+discardcorrupt')
          retryArgs.push('-analyzeduration', '10000000', '-probesize', '10000000', '-f', 'mpegts')
        }
        retryArgs.push('-ss', String(actualStart), '-i', actualInput, '-t', String(actualDuration))
        retryArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-af', 'aresample=async=1000', '-max_muxing_queue_size', '2048', '-movflags', '+faststart', output)
        const retryResult = await runFFmpeg(retryArgs, encodeTimeout)
        if (retryResult.code !== 0) {
          throw new Error(`FFmpeg slice failed (no subs): ${extractFFmpegError(retryResult.stderr)}`)
        }
        return
      }
      throw new Error(`FFmpeg slice failed: ${extractFFmpegError(result.stderr)}`)
    }
  } finally {
    // Clean up temp segment
    if (tmpSegment && existsSync(tmpSegment)) {
      try { require('fs').unlinkSync(tmpSegment) } catch { /* ignore */ }
    }
  }
}

/**
 * Burn ASS/SRT subtitles into an existing MP4 video.
 * Re-encodes video only; audio is stream-copied (no quality loss, faster).
 */
export async function burnSubtitles(
  input: string, output: string, subtitlePath: string,
): Promise<void> {
  const escaped = subtitlePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '\\\u0027')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/ /g, '\\ ')

  const vf = `subtitles=${escaped}`
  const clipDuration = await probeDuration(input)
  const encodeTimeout = Math.max(60000, (30 + clipDuration * 2) * 1000)

  const args = [
    '-y',
    '-i', input,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    output,
  ]

  logger.info(`burnSubtitles: re-encoding video with ${subtitlePath.endsWith('.ass') ? 'ASS' : 'SRT'} subtitles`)
  const result = await runFFmpeg(args, encodeTimeout)
  if (result.code !== 0) {
    throw new Error(`FFmpeg burn subtitles failed: ${extractFFmpegError(result.stderr)}`)
  }
}

/**
 * Get the duration of a media file in seconds using ffprobe.
 */
async function probeDuration(filePath: string): Promise<number> {
  try {
    const ffprobePath = getFFmpegPath().replace(/ffmpeg(\.exe)?$/, 'ffprobe$1')
    const probeBin = existsSync(ffprobePath) ? ffprobePath : 'ffprobe'
    const { spawnSync } = require('child_process')
    const result = spawnSync(probeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ], { encoding: 'utf8', timeout: 10000 })
    const dur = parseFloat(result.stdout?.trim() || '0')
    return dur > 0 ? dur : 60
  } catch {
    return 60
  }
}

/**
 * Extract a thumbnail/cover image from a video at a given timestamp.
 * Outputs high-quality JPEG, scaled to fit within 1280x720 (preserving aspect ratio).
 * Handles live-recording .ts files that may still be written to.
 */
export async function extractCover(
  input: string, output: string, seekSec: number = 0
): Promise<void> {
  const isLiveTs = input.endsWith('.ts')

  if (isLiveTs) {
    // For live .ts files being actively written:
    // Copy tail of file to temp, extract frame from that static snapshot.
    const tmpTail = input.replace(/\.ts$/, `_cover_tail_${Date.now()}.ts`)
    const tailBytes = 2 * 1024 * 1024  // 2MB — enough for at least one keyframe
    let coverInput = input
    let needCleanup = false

    if (copyFileTail(input, tmpTail, tailBytes)) {
      coverInput = tmpTail
      needCleanup = true
    }

    try {
      const result = await runFFmpeg([
        '-y',
        '-fflags', '+genpts+discardcorrupt+igndts',
        '-analyzeduration', '1000000',
        '-probesize', '1000000',
        '-f', 'mpegts',
        '-i', coverInput,
        '-vframes', '1',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease',
        '-q:v', '5',
        output,
      ], 10000)

      if (result.code !== 0) {
        throw new Error(`FFmpeg extract cover failed: ${extractFFmpegError(result.stderr)}`)
      }
    } finally {
      if (needCleanup && existsSync(tmpTail)) {
        try { require('fs').unlinkSync(tmpTail) } catch { /* ignore */ }
      }
    }
  } else {
    // Regular files: input seeking (fast, accurate)
    const args = ['-y', '-ss', String(seekSec), '-i', input,
      '-vframes', '1',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease',
      '-q:v', '5',
      output,
    ]
    const result = await runFFmpeg(args, 30000)
    if (result.code !== 0) {
      throw new Error(`FFmpeg extract cover failed: ${extractFFmpegError(result.stderr)}`)
    }
  }
}

/**
 * Detect a CJK-capable font available on the current system.
 */
function detectFont(): string {
  const platform = process.platform
  const candidates: string[] = platform === 'darwin'
    ? [
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/System/Library/Fonts/STHeiti Medium.ttc',
        '/System/Library/Fonts/STHeiti Light.ttc',
        '/Library/Fonts/Arial Unicode.ttf',
        '/System/Library/Fonts/Supplemental/Songti.ttc',
      ]
    : platform === 'win32'
    ? [
        'C:/Windows/Fonts/msyh.ttc',     // Microsoft YaHei
        'C:/Windows/Fonts/simhei.ttf',    // SimHei
        'C:/Windows/Fonts/arial.ttf',
      ]
    : [
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
        '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',
        '/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      ]

  for (const f of candidates) {
    if (existsSync(f)) return f
  }
  return ''
}

/**
 * Split text into lines for cover overlay.
 * Allows multiple lines (not just 2) so text wraps naturally instead of being truncated.
 */
function splitCoverText(text: string, maxCharsPerLine: number = 12): string[] {
  text = text.trim()
  if (text.length <= maxCharsPerLine) return [text]

  const punctuation = /[，。？！、,!?：:；;]/
  const lines: string[] = []
  let remaining = text

  while (remaining.length > maxCharsPerLine) {
    // Try to break at punctuation near maxCharsPerLine
    let splitIdx = -1
    for (let i = maxCharsPerLine; i >= Math.max(1, maxCharsPerLine - 4); i--) {
      if (i <= remaining.length && punctuation.test(remaining[i - 1])) {
        splitIdx = i
        break
      }
    }
    if (splitIdx < 0) splitIdx = maxCharsPerLine

    lines.push(remaining.slice(0, splitIdx).trim())
    remaining = remaining.slice(splitIdx).trim()
  }
  if (remaining) lines.push(remaining)

  return lines
}

/**
 * Escape text for ffmpeg drawtext filter.
 */
function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "\u2019")       // replace apostrophe with unicode
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/%/g, '%%')
}

/**
 * Overlay title text on a cover image. Produces a B-site style cover with
 * large bold text and black outline in the upper portion of the image.
 */
export async function overlayTextOnCover(
  inputImage: string,
  outputImage: string,
  title: string,
  options?: { fontColor?: string; fontSize?: number; position?: 'top' | 'center' | 'bottom'; videoResolution?: { width: number; height: number } | null }
): Promise<boolean> {
  const fontPath = detectFont()
  logger.info(`overlayTextOnCover: title="${title}", font="${fontPath}"`)
  if (!fontPath) {
    logger.warn('No CJK font found, skipping text overlay')
    return false
  }

  const { fontColor = 'white', position = 'center', videoResolution } = options || {}

  // Adapt font size to image dimensions:
  // Cover images are scaled to fit 1280x720 (force_original_aspect_ratio=decrease).
  // Portrait source (e.g. 720x1280) → cover ~405x720, so fontSize must be much smaller.
  // Landscape source (e.g. 1920x1080) → cover 1280x720, standard font size.
  let fontSize = options?.fontSize || 128
  if (!options?.fontSize && videoResolution) {
    const { width: vw, height: vh } = videoResolution
    const isPortrait = vh > vw
    if (isPortrait) {
      const coverWidth = Math.round(720 * (vw / vh))
      fontSize = Math.max(88, Math.min(144, Math.round(coverWidth * 0.36)))
      logger.info(`Cover text: portrait video ${vw}x${vh}, est. cover width=${coverWidth}, fontSize=${fontSize}`)
    }
  }

  const isPortraitCover = videoResolution ? videoResolution.height > videoResolution.width : false
  const lines = splitCoverText(title, isPortraitCover ? 3 : 5)

  // Auto-shrink font if text block would exceed ~80% of cover height (720px)
  const coverHeight = 720
  const maxTextHeight = coverHeight * 0.8
  let lineHeight = Math.round(fontSize * 1.25)
  let totalTextHeight = lines.length * lineHeight
  if (totalTextHeight > maxTextHeight) {
    fontSize = Math.max(36, Math.floor(maxTextHeight / (lines.length * 1.25)))
    lineHeight = Math.round(fontSize * 1.25)
    totalTextHeight = lines.length * lineHeight
    logger.info(`Cover text auto-shrink: fontSize=${fontSize} for ${lines.length} lines`)
  }

  // Build drawtext filter chain — one drawtext per line
  const filters: string[] = []

  // Calculate Y start position based on placement
  let yStart: string
  if (position === 'center') {
    yStart = `(h-${totalTextHeight})/2`
  } else if (position === 'bottom') {
    yStart = `h-${totalTextHeight + 40}`
  } else {
    yStart = '40' // top with padding
  }

  // Escape font path for ffmpeg drawtext filter (handle spaces, colons, quotes)
  const escapedFontPath = fontPath
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\\\:')
    .replace(/'/g, '\u2019')

  for (let i = 0; i < lines.length; i++) {
    const escaped = escapeDrawText(lines[i])
    const yExpr = i === 0 ? yStart : `${yStart}+${i * lineHeight}`
    const borderW = Math.max(2, Math.round(fontSize / 12))
    const shadowD = Math.max(1, Math.round(fontSize / 24))
    filters.push(
      `drawtext=text='${escaped}'` +
      `:fontfile='${escapedFontPath}'` +
      `:fontsize=${fontSize}` +
      `:fontcolor=${fontColor}` +
      `:borderw=${borderW}` +
      `:bordercolor=black@0.9` +
      `:shadowx=${shadowD}:shadowy=${shadowD}:shadowcolor=black@0.6` +
      `:x=(w-text_w)/2` +  // horizontally centered
      `:y=${yExpr}`
    )
  }

  const args = [
    '-y',
    '-i', inputImage,
    '-vf', filters.join(','),
    '-q:v', '1',
    outputImage,
  ]

  const result = await runFFmpeg(args, 30000)
  if (result.code !== 0) {
    const stderrMsg = extractFFmpegError(result.stderr)
    if (result.stderr.includes('No such filter') || result.stderr.includes('drawtext')) {
      logger.warn('Text overlay failed: ffmpeg was compiled without drawtext support')
    } else {
      logger.warn(`Text overlay failed: ${stderrMsg}`)
    }
    return false
  }
  return true
}

