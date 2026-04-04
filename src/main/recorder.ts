import { join } from 'path'
import { existsSync, mkdirSync, statSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { getFFmpegPath } from './ffmpeg'
import { getLogger } from './utils/logger'

const logger = getLogger('recorder')

export interface RecorderEvents {
  error: (err: Error) => void
  stopped: () => void
}

/** Callback to refresh the stream URL when it expires / becomes invalid */
export type StreamUrlRefresher = () => Promise<{ url: string; headers: Record<string, string> }>

export class Recorder extends EventEmitter {
  private running = false
  private streamUrl: string
  private saveDir: string
  private headers: Record<string, string>
  private refreshStreamUrl: StreamUrlRefresher | null = null
  private proc: ChildProcess | null = null
  private _recordingPath = ''
  private _startTime = 0

  constructor(opts: {
    streamUrl: string
    saveDir: string
    headers?: Record<string, string>
    refreshStreamUrl?: StreamUrlRefresher
  }) {
    super()
    this.streamUrl = opts.streamUrl
    this.saveDir = opts.saveDir
    this.headers = opts.headers || {}
    this.refreshStreamUrl = opts.refreshStreamUrl || null

    if (!existsSync(this.saveDir)) {
      mkdirSync(this.saveDir, { recursive: true })
    }
  }

  async start(): Promise<void> {
    this.running = true
    let consecutiveFailures = 0
    const maxConsecutiveFailures = 10
    const headerStr = Object.keys(this.headers).map(k => `${k}=...`).join(', ')
    logger.info(`Recorder started: streamUrl=${this.streamUrl.slice(0, 100)}... headers=[${headerStr}]`)

    while (this.running) {
      this._recordingPath = join(this.saveDir, 'recording.ts')
      this._startTime = Date.now()

      const code = await this.runFFmpeg(this.streamUrl, this._recordingPath, this.headers)

      if (!this.running) break

      if (code !== 0) {
        consecutiveFailures++
        logger.error(`Recording segment failed with code ${code} (${consecutiveFailures}/${maxConsecutiveFailures}). Check logs for FFmpeg error details.`)

        if (consecutiveFailures >= maxConsecutiveFailures) {
          this.emit('error', new Error(`Recording failed after ${maxConsecutiveFailures} consecutive failures. Check app logs for FFmpeg error messages.`))
          break
        }

        // Try to refresh stream URL every 2 failures
        if (consecutiveFailures >= 2 && this.refreshStreamUrl) {
          try {
            logger.info('Attempting to refresh stream URL...')
            const refreshed = await this.refreshStreamUrl()
            this.streamUrl = refreshed.url
            this.headers = refreshed.headers
            logger.info('Stream URL refreshed successfully')
          } catch (e: any) {
            logger.warn(`Failed to refresh stream URL: ${e.message}`)
          }
        }

        const delay = Math.min(10000, 2000 + consecutiveFailures * 1500)
        await new Promise(r => setTimeout(r, delay))
        continue
      }

      // ffmpeg exited cleanly (stream ended or was stopped)
      consecutiveFailures = 0
      try {
        const fileSize = existsSync(this._recordingPath) ? statSync(this._recordingPath).size : 0
        logger.info(`Recording segment completed: ${this._recordingPath} (${fileSize} bytes)`)
      } catch (e) {
        logger.debug(`Failed to stat recording file: ${e}`)
      }
      if (this.running) {
        // Stream ended naturally — try to reconnect
        logger.info('Stream ended, reconnecting...')
        await new Promise(r => setTimeout(r, 3000))
      }
    }

    this.running = false
    this.emit('stopped')
  }

  private runFFmpeg(streamUrl: string, outputPath: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve) => {
      const ffmpegPath = getFFmpegPath()
      const args = ['-y']

      if (Object.keys(headers).length > 0) {
        const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n'
        args.push('-headers', headerStr)
      }

      const isHttp = streamUrl.startsWith('http://') || streamUrl.startsWith('https://')
      if (isHttp) {
        args.push(
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-reconnect_at_eof', '1',
        )
      }

      args.push(
        '-rw_timeout', '15000000',
        '-timeout', '15000000',
        '-i', streamUrl,
        '-c', 'copy',
        '-f', 'mpegts',
        '-err_detect', 'ignore_err',
        '-fflags', '+discardcorrupt+genpts',
        outputPath,
      )

      logger.debug(`Running: ${ffmpegPath} ${args.join(' ').slice(0, 200)}`)
      const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      this.proc = proc
      let stderrOutput = ''

      proc.stderr?.on('data', (data) => {
        const msg = data.toString('utf8')
        stderrOutput += msg
      })
      proc.on('close', (code) => {
        this.proc = null
        if (code !== 0) {
          // Extract meaningful error lines
          const errorLines = stderrOutput.split('\n').filter(l =>
            l.toLowerCase().includes('error') ||
            l.toLowerCase().includes('connection') ||
            l.includes('refused') ||
            l.includes('404') ||
            l.includes('403') ||
            l.includes('Input/output') ||
            l.includes('Connection refused')
          )
          const errorMsg = errorLines.slice(-3).join(' | ') || stderrOutput.split('\n').filter(l => l.trim()).slice(-2).join(' | ')
          logger.warn(`[FFmpeg-Recorder] FFmpeg exited with code ${code}: streamUrl=${streamUrl.slice(0, 80)}... error: ${errorMsg}`)
        }
        resolve(code ?? 1)
      })
      proc.on('error', (err) => {
        logger.warn(`FFmpeg process error: ${err.message}`)
        this.proc = null
        resolve(1)
      })
    })
  }

  stop(): void {
    this.running = false
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGINT') // graceful stop so ffmpeg writes trailer
      // Force kill after 5s if not exited
      const p = this.proc
      setTimeout(() => {
        if (p && !p.killed) p.kill('SIGKILL')
      }, 5000)
    }
    logger.info('Recorder stop requested')
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Path to the current recording file */
  get recordingPath(): string {
    return this._recordingPath
  }

  /** Seconds elapsed since recording started */
  get recordingElapsed(): number {
    if (!this._startTime) return 0
    return (Date.now() - this._startTime) / 1000
  }
}
