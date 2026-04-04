import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { EventEmitter } from 'events'
import { registry } from './plugins/registry'
import { Recorder } from './recorder'
import { BurstDetector, type BurstEvent } from './burst-detector'
import { analyzeExcitement } from './audio-analyzer'
import { ScoringEngine, type ScoringResult } from './scoring-engine'
import { cutSlice } from './slice-worker'
import { enqueueSlice, getQueueStatus } from './slice-queue'
import { updateTask, getTask } from './task-manager'
import { getConfig } from './config'
import { isAiConfigured, isWhisperConfigured } from './ai-client'
// extractCover import removed — no longer needed for AI scoring loop
import type { DanmakuMessage } from './plugins/danmaku/types'
import { getLogger } from './utils/logger'
import { pushNotification } from './notification-service'
import { mt } from './i18n'

const logger = getLogger('live-monitor')

export class LiveMonitor extends EventEmitter {
  private taskId: string
  private url: string
  private platform: string
  private recorder: Recorder | null = null
  private burstDetector: BurstDetector
  private scoringEngine: ScoringEngine
  private analyzeTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private danmakuCount = 0
  private danmakuWindow: number[] = []
  private analysisOffset = 0
  private recentDanmaku: DanmakuMessage[] = []
  private logs: { time: string; level: string; message: string }[] = []
  private analyzing = false
  private audioAnalyzing = false        // separate lock for audio extraction (non-blocking)
  private lastAudioFeatures: any = null // cached audio features from last successful extraction
  private lastCoverRefreshTime = 0      // timestamp of last cover refresh
  private prevState: string = 'warmup'  // previous burst detector state for transition logging (starts as 'warmup')
  private sliceCount = 0                // number of slices created this session
  private slicingActive = 0              // number of slice jobs currently executing
  private monitorStartedAt: string = '' // actual monitoring start timestamp
  private prevConfigSnapshot: Record<string, any> = {} // for change detection
  private loggedWaitingDanmaku = false
  private audioOnlyMode = false          // true when running without danmaku baseline

  constructor(taskId: string, url: string, platform: string) {
    super()
    this.taskId = taskId
    this.url = url
    this.platform = platform
    const config = getConfig()
    this.burstDetector = new BurstDetector({
      burstThreshold: config.slice.burst_threshold,
      heatingThreshold: config.slice.heating_threshold,
      // minBurstDuration: minimum HIGH-ENERGY duration to confirm a real burst
      minBurstDuration: Math.max(5, config.slice.min_duration - config.slice.pre_buffer - config.slice.post_buffer),
      // maxBurstDuration: final slice = pre_buffer + burst + post_buffer, so burst ≤ max_duration - buffers
      maxBurstDuration: Math.max(30, config.slice.max_duration - config.slice.pre_buffer - config.slice.post_buffer),
      heatingTimeout: 30,
    })
    this.scoringEngine = new ScoringEngine()
    this.scoringEngine.setWeights({
      danmaku: config.slice.danmaku_weight,
      audio: config.slice.audio_weight,
      ai: config.slice.ai_weight,
    })
    this.scoringEngine.setCustomKeywords(config.live.custom_keywords)

    this.burstDetector.on('burst', (event: BurstEvent) => {
      this.handleBurst(event)
    })
  }

  private addLog(level: string, message: string): void {
    this.logs.push({ time: new Date().toISOString(), level, message })
    // Keep last 100 logs
    if (this.logs.length > 100) this.logs = this.logs.slice(-100)
  }

  /** Persist current logs to the task record so the frontend can display them */
  private flushLogs(): void {
    const task = getTask(this.taskId)
    const currentStats = task?.live_stats || {}
    updateTask(this.taskId, {
      live_stats: { ...currentStats, processing_logs: this.logs.slice(-50) },
    })
  }

  async start(): Promise<void> {
    logger.info(`Starting live monitor for task ${this.taskId}`)
    this.running = true
    this.addLog('info', mt('monitor.initStart'))

    const platformPlugin = registry.getPlatform(this.platform)
    if (!platformPlugin) {
      this.addLog('error', mt('monitor.unknownPlatform', { platform: this.platform }))
      updateTask(this.taskId, { status: 'failed', error_message: `Unknown platform: ${this.platform}` })
      return
    }

    try {
      // Get live info
      this.addLog('info', mt('monitor.fetchingInfo'))
      const liveInfo = await platformPlugin.getLiveInfo(this.url)
      this.addLog('info', mt('monitor.liveInfo', { title: liveInfo.title, author: liveInfo.author }))
      updateTask(this.taskId, {
        title: liveInfo.title,
        author: liveInfo.author,
        cover_url: liveInfo.coverUrl || '',
      })

      // Get stream URL
      this.addLog('info', mt('monitor.fetchingStream'))
      const streamUrl = await platformPlugin.getStreamUrl(this.url)
      this.addLog('info', mt('monitor.streamSuccess'))

      const headers = platformPlugin.getHeaders()
      this.monitorStartedAt = new Date().toISOString()
      updateTask(this.taskId, {
        status: 'recording',
        live_stats: { monitor_started_at: this.monitorStartedAt },
      })

      // Start danmaku collector (non-blocking — don't delay recorder start)
      const danmakuCollector = registry.getDanmaku(this.platform)
      if (danmakuCollector) {
        this.addLog('info', mt('monitor.connectingDanmaku', { roomId: liveInfo.roomId }))
        danmakuCollector.onMessage((msg) => this.handleDanmaku(msg))
        danmakuCollector.connect(liveInfo.roomId)
          .then(() => {
            if (danmakuCollector.isConnected) {
              this.addLog('info', mt('monitor.danmakuConnected'))
            } else {
              this.addLog('warn', mt('monitor.danmakuNeedLogin'))
            }
            this.flushLogs()
          })
          .catch((e: any) => {
            logger.warn(`Danmaku connection failed: ${e}`)
            this.addLog('warn', mt('monitor.danmakuFailed', { message: e.message || e }))
            this.flushLogs()
          })
      } else {
        this.addLog('info', mt('monitor.danmakuUnsupported', { platform: this.platform }))
      }
      this.flushLogs()

      // Start recorder (continuous single-file recording)
      const config = getConfig()
      this.recorder = new Recorder({
        streamUrl,
        saveDir: join(config.storage.cache_dir, this.taskId),
        headers: platformPlugin.getHeaders(),
        refreshStreamUrl: async () => {
          this.addLog('info', mt('monitor.refreshingStream'))
          const newUrl = await platformPlugin.getStreamUrl(this.url)
          const newHeaders = platformPlugin.getHeaders()
          this.addLog('info', mt('monitor.streamRefreshed'))
          return { url: newUrl, headers: newHeaders }
        },
      })

      this.recorder.on('error', (err) => {
        logger.warn(`Recorder error: ${err.message}`)
        this.addLog('warn', mt('monitor.recordError', { message: err.message }))
        this.flushLogs()
      })

      // Start analysis loop
      const aiStatus = isAiConfigured() ? mt('monitor.aiConfigured') : mt('monitor.aiNotConfigured')
      this.addLog('info', mt('monitor.analysisStart', {
        interval: config.live.analysis_interval,
        threshold: Math.round(config.slice.burst_threshold * 100),
        aiStatus,
      }))
      this.analyzeTimer = setInterval(() => this.analyzeLoop(), config.live.analysis_interval * 1000)

      // Start recording (blocks until stopped)
      this.addLog('info', mt('monitor.recordingStart'))
      this.flushLogs()
      await this.recorder.start()

    } catch (e: any) {
      logger.error(`Live monitor error: ${e.message}`)
      this.addLog('error', mt('monitor.monitorError', { message: e.message }))
      this.flushLogs()
      updateTask(this.taskId, { status: 'failed', error_message: e.message })
    } finally {
      this.addLog('info', mt('monitor.monitorStopped', { count: this.sliceCount }))
      this.flushLogs()
      this.cleanup()
    }
  }

  stop(): void {
    this.running = false
    this.recorder?.stop()
    if (this.analyzeTimer) {
      clearInterval(this.analyzeTimer)
      this.analyzeTimer = null
    }
    // Let queued slice jobs finish — the recording file still exists,
    // so slices can be cut even after monitoring stops.
    // Directly disconnect danmaku — don't rely on cleanup() which runs asynchronously
    const danmaku = registry.getDanmaku(this.platform)
    if (danmaku?.isConnected) {
      danmaku.disconnect().catch(() => {})
    }
    logger.info(`Live monitor stopped for task ${this.taskId}`)
  }

  private handleDanmaku(msg: DanmakuMessage): void {
    this.danmakuCount++
    this.danmakuWindow.push(Date.now())
    // Keep last 60s of timestamps
    const cutoff = Date.now() - 60000
    this.danmakuWindow = this.danmakuWindow.filter(t => t > cutoff)

    // Feed to scoring engine for text/gift analysis
    this.scoringEngine.feedDanmaku(msg)

    // Keep recent danmaku for UI and per-burst AI context
    this.recentDanmaku.push(msg)
    if (this.recentDanmaku.length > 200) this.recentDanmaku.shift()
  }

  private getDanmakuCountInWindow(intervalSeconds: number): number {
    const cutoff = Date.now() - intervalSeconds * 1000
    return this.danmakuWindow.filter(t => t > cutoff).length
  }

  private async analyzeLoop(): Promise<void> {
    if (!this.running) return
    // Prevent overlapping analysis — if previous cycle is still running, skip this one
    if (this.analyzing) {
      logger.debug('Skipping analysis cycle — previous one still running')
      return
    }
    this.analyzing = true

    try {
      await this.doAnalysis()
    } catch (e: any) {
      logger.warn(`Analysis cycle error: ${e.message}`)
    } finally {
      this.analyzing = false
    }
  }

  private async doAnalysis(): Promise<void> {
    const config = getConfig()
    // Detect and log config changes
    this.detectConfigChanges(config)
    // Sync settings from config so changes take effect immediately
    this.burstDetector.updateConfig({
      burstThreshold: config.slice.burst_threshold,
      heatingThreshold: config.slice.heating_threshold,
      minBurstDuration: Math.max(5, config.slice.min_duration - config.slice.pre_buffer - config.slice.post_buffer),
      maxBurstDuration: Math.max(30, config.slice.max_duration - config.slice.pre_buffer - config.slice.post_buffer),
    })
    this.scoringEngine.setWeights({
      danmaku: config.slice.danmaku_weight,
      audio: config.slice.audio_weight,
      ai: config.slice.ai_weight,
    })
    this.scoringEngine.setCustomKeywords(config.live.custom_keywords)
    this.analysisOffset += config.live.analysis_interval

    // Refresh cover every 5 minutes (non-blocking, avoid platform rate limits)
    const now = Date.now()
    if (now - this.lastCoverRefreshTime > 300000) {
      this.lastCoverRefreshTime = now
      this.refreshCover().catch(() => {})
    }

    // Audio analysis — extract features from end of current recording
    // Run NON-BLOCKING: fire-and-forget, use cached result for scoring.
    // This prevents slow FFmpeg operations (10-60s) from blocking the analysis loop.
    const cycle = Math.floor(this.analysisOffset / config.live.analysis_interval)
    const audioCycleInterval = Math.max(1, Math.ceil(3 / config.live.analysis_interval))
    if (this.recorder && cycle % audioCycleInterval === 0 && !this.audioAnalyzing) {
      const recPath = this.recorder.recordingPath
      const elapsed = this.recorder.recordingElapsed

      // Lower requirements: try analysis as soon as we have minimum data
      // Previous: required elapsed > 8s AND file > 10KB (too strict)
      // New: try after 3s OR if file > 5KB (more lenient for fast-growing files)
      const hasMinData = (elapsed > 3 && existsSync(recPath) && statSync(recPath).size > 5120) ||
                         (elapsed > 8 && existsSync(recPath))

      if (recPath && hasMinData) {
        this.audioAnalyzing = true
        const seekTo = Math.max(0, elapsed - 5) // Analyze last 5 seconds
        logger.info(`[Monitor-Audio] Cycle ${cycle}: analyzing from ${seekTo.toFixed(1)}s (elapsed=${elapsed.toFixed(1)}s, file=${statSync(recPath).size}B)`)
        analyzeExcitement(recPath, seekTo, 5)
          .then(result => {
            this.lastAudioFeatures = result.features
            logger.info(`[Monitor-Audio] ✓ Analysis result: rms=${result.features.rms.toFixed(4)}, loud=${result.features.loudness.toFixed(4)}, score=${result.score.toFixed(3)}`)
          })
          .catch((e) => {
            logger.warn(`[Monitor-Audio] ✗ Analysis error: ${e.message || e}`)
          })
          .finally(() => { this.audioAnalyzing = false })
      } else if (this.recorder && !this.audioAnalyzing) {
        const fileSize = existsSync(recPath) ? statSync(recPath).size : 0
        const reason = !recPath ? 'no path' : `elapsed=${elapsed.toFixed(1)}s file=${fileSize}B (need 3s+5KB or 8s)`
        logger.debug(`[Monitor-Audio] Cycle ${cycle}: skip audio analysis (${reason})`)
      }
    }
    const audioFeatures = this.lastAudioFeatures

    // Check danmaku connection status
    const danmakuCollector = registry.getDanmaku(this.platform)
    const danmakuConnected = danmakuCollector?.isConnected || false

    // AI analysis removed from scoring loop — AI now reviews post-slice only
    const aiScores = undefined

    // Compute all signal scores via scoring engine
    const scoring = this.scoringEngine.computeScores(
      this.danmakuWindow,
      audioFeatures,
      config.live.analysis_interval,
      aiScores,
    )

    // --- Warmup guard: don't activate burst detection until baseline is stable ---
    const warmedUp = this.scoringEngine.isWarmedUp()
    let newState: string

    if (!warmedUp) {
      // During warmup, just collect baseline data — don't trigger any bursts
      newState = 'warmup'
      const feedCount = this.scoringEngine.getFeedCount()
      const cycleNum = Math.floor(this.analysisOffset / config.live.analysis_interval)
      if (feedCount === 0) {
        // Haven't received any danmaku yet — log only once
        if (!this.loggedWaitingDanmaku) {
          this.addLog('info', mt('monitor.waitingDanmaku'))
          logger.info(`[Monitor-Warmup] Cycle ${cycleNum}: No danmaku received yet, waiting for data...`)
          this.loggedWaitingDanmaku = true
        }
      } else {
        const remaining = 5 - feedCount
        const remainingTime = remaining > 0 ? (remaining * config.live.analysis_interval).toFixed(0) : '0'
        this.addLog('info', mt('monitor.buildingBaseline', {
          current: feedCount,
          rate: this.scoringEngine.getBaselineRate().toFixed(1),
          remaining: remainingTime,
        }))
        logger.info(`[Monitor-Warmup] Cycle ${cycleNum}: Building baseline (${feedCount}/5 feeds, rate=${this.scoringEngine.getBaselineRate().toFixed(1)}/s, remaining=${remainingTime}s, audio=${audioFeatures ? 'ready' : 'waiting'})`)
      }
    } else {
      // Feed to burst detector
      // CRITICAL: use recordingElapsed (real wall-clock time since recording started),
      // NOT analysisOffset which drifts when analysis cycles are skipped.
      // The recording file's PTS corresponds to real time, so burst timestamps
      // must also be in real time for accurate seeking during slicing.
      const feedTimestamp = this.recorder?.recordingElapsed ?? this.analysisOffset
      newState = this.burstDetector.feed(scoring.totalScore, feedTimestamp)
    }

    // --- State transition logging ---
    const scoreStr = `${Math.round(scoring.totalScore * 100)}%`
    const thresholdStr = `${Math.round(config.slice.burst_threshold * 100)}%`
    const cycleNum = Math.floor(this.analysisOffset / config.live.analysis_interval)

    if (warmedUp && this.prevState === 'warmup') {
      const baseRate = this.scoringEngine.getBaselineRate().toFixed(1)
      const hasDanmakuBaseline = this.scoringEngine.getFeedCount() >= 5
      if (hasDanmakuBaseline) {
        const msg = mt('monitor.baselineComplete', { rate: baseRate })
        this.addLog('info', msg)
        logger.info(`[Monitor-Warmup] Cycle ${cycleNum}: ✓ Warmup complete! Baseline rate=${baseRate}/s, activating burst detection`)
      } else {
        const msg = mt('monitor.audioOnlyMode')
        this.addLog('info', msg)
        logger.info(`[Monitor-Warmup] Cycle ${cycleNum}: ✓ Warmup complete! No danmaku baseline (${this.scoringEngine.getFeedCount()} feeds), using audio-only mode`)
        this.audioOnlyMode = true
      }
      this.prevState = 'idle'
    }

    // Upgrade from audio-only to full mode when danmaku baseline becomes available
    if (this.audioOnlyMode && this.scoringEngine.getFeedCount() >= 5) {
      const baseRate = this.scoringEngine.getBaselineRate().toFixed(1)
      const msg = mt('monitor.baselineComplete', { rate: baseRate })
      this.addLog('info', msg)
      logger.info(`[Monitor-Warmup] Cycle ${cycleNum}: ✓ Danmaku baseline now available! rate=${baseRate}/s, upgrading to full mode`)
      this.audioOnlyMode = false
    }

    if (newState !== this.prevState) {
      if (newState === 'heating' && this.prevState === 'idle') {
        const topSignals = this.getTopSignals(scoring.signals)
        this.addLog('info', mt('monitor.heating', { score: `${scoreStr} (${mt('label.configBurstThreshold')} ${thresholdStr})` }) + ` — ${topSignals}`)
      } else if (newState === 'burst') {
        const detail = this.getScoreBreakdown(scoring)
        this.addLog('info', mt('monitor.burst', { score: scoreStr }) + ` — ${detail}`)
      } else if (newState === 'idle' && this.prevState === 'burst') {
        this.addLog('info', mt('monitor.burstEnd'))
      } else if (newState === 'idle' && this.prevState === 'heating') {
        const detail = this.getScoreBreakdown(scoring)
        this.addLog('info', mt('monitor.coolingDown', { score: scoreStr }) + ` — ${detail}`)
      }
      this.prevState = newState
    } else if (cycle % 5 === 0 && cycle > 0) {
      // Periodic heartbeat log every 5 cycles so the user can see the monitor is alive
      const recElapsed = this.recorder?.recordingElapsed ?? 0
      const drift = Math.abs(recElapsed - this.analysisOffset)
      if (drift > 5) {
        logger.warn(`[Monitor-Drift] Time drift detected: analysisOffset=${this.analysisOffset.toFixed(0)}s vs recordingElapsed=${recElapsed.toFixed(0)}s (drift=${drift.toFixed(0)}s)`)
      }
      const elapsed = this.formatTime(recElapsed || this.analysisOffset)
      const dmCount = this.danmakuWindow.length
      const baseRate = this.scoringEngine.getBaselineRate().toFixed(1)
      const feedCount = this.scoringEngine.getFeedCount()
      const giftCount = this.scoringEngine.getGiftCountInWindow(config.live.analysis_interval)
      const audioStr = audioFeatures ? `rms=${audioFeatures.rms.toFixed(3)}` : 'pending'
      this.addLog('info',
        mt('monitor.heartbeat', { elapsed, score: `${scoreStr} | ${mt('label.scoreDanmaku')} ${dmCount}/min (${baseRate}/s) | ${newState}` }))
      logger.debug(`[Monitor-Heartbeat] Cycle ${cycle}: elapsed=${elapsed}, score=${scoreStr}, danmaku=${dmCount}/min (rate=${baseRate}/s, feed=${feedCount}/5), gifts=${giftCount}, audio=${audioStr}, state=${newState}`)
    }

    // Update live stats with detailed signal breakdown (includes logs)
    const hasDanmaku = this.danmakuWindow.length > 0
    updateTask(this.taskId, {
      live_stats: {
        monitor_started_at: this.monitorStartedAt,
        cycle: Math.floor(this.analysisOffset / config.live.analysis_interval),
        offset: this.analysisOffset,
        total_score: scoring.totalScore,
        threshold: this.burstDetector.getThreshold(),
        danmaku_score: scoring.signals.danmakuDensity,
        danmaku_baseline_rate: this.scoringEngine.getBaselineRate(),
        danmaku_acceleration: scoring.signals.danmakuAcceleration,
        unique_user_burst: scoring.signals.uniqueUserBurst,
        emotion_score: scoring.signals.emotionScore,
        consensus_score: scoring.signals.consensusScore,
        gift_score: scoring.signals.giftScore,
        gift_count: this.scoringEngine.getGiftCountInWindow(config.live.analysis_interval),
        danmaku_count: this.getDanmakuCountInWindow(config.live.analysis_interval),
        audio_excitement: scoring.signals.audioExcitement,
        audio_surge: scoring.signals.audioSurge,
        voice_surge: scoring.signals.voiceSurge,
        causal_bonus: scoring.signals.causalBonus,
        audio_details: audioFeatures || {},
        ai_frame_score: 0,
        ai_text_score: 0,
        ai_reason: '',
        resonance_bonus: scoring.resonanceBonus,
        state: !warmedUp ? 'warmup'
          : this.burstDetector.getState() !== 'idle' ? this.burstDetector.getState()
          : this.slicingActive > 0 ? 'slicing'
          : 'idle',
        danmaku_connected: danmakuConnected,
        has_danmaku: hasDanmaku,
        recent_danmaku: this.recentDanmaku.slice(-20),
        processing_logs: this.logs.slice(-50),
      },
    })
  }

  /** Get a human-readable summary of top scoring signals */
  private getTopSignals(signals: Record<string, number>): string {
    const labels: Record<string, string> = {
      danmakuDensity: mt('label.signalDanmakuDensity'),
      danmakuAcceleration: mt('label.signalDanmakuAccel'),
      uniqueUserBurst: mt('label.signalUniqueUsers'),
      emotionScore: mt('label.signalEmotion'),
      consensusScore: mt('label.signalConsensus'),
      giftScore: mt('label.signalGift'),
      audioExcitement: mt('label.signalAudio'),
      audioSurge: mt('label.signalAudioSurge'),
      voiceSurge: mt('label.signalVoiceSurge'),
      causalBonus: mt('label.signalCausalBonus'),
      aiFrameScore: mt('label.signalAiFrame'),
      aiTextScore: mt('label.signalAiText'),
    }
    return Object.entries(signals)
      .filter(([, v]) => v > 0.2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${labels[k] || k} ${Math.round(v * 100)}%`)
      .join(', ') || mt('label.noSignal')
  }

  /** Get a human-readable breakdown of why the total score is what it is */
  private getScoreBreakdown(scoring: ScoringResult): string {
    const parts: string[] = []
    const s = scoring.signals
    if (s.danmakuDensity > 0.1 || s.emotionScore > 0.1) {
      const avg = s.danmakuDensity * 0.25 + s.danmakuAcceleration * 0.15 + s.uniqueUserBurst * 0.25 + s.emotionScore * 0.15 + s.consensusScore * 0.10 + s.giftScore * 0.10
      const peak = Math.max(s.danmakuDensity, s.danmakuAcceleration, s.uniqueUserBurst, s.emotionScore, s.consensusScore, s.giftScore)
      parts.push(`${mt('label.scoreDanmaku')}${Math.round(Math.min(1, avg * 0.6 + peak * 0.4) * 100)}%`)
    }
    if (s.audioExcitement > 0.1 || s.audioSurge > 0.1 || s.voiceSurge > 0.1) {
      const avg = s.audioExcitement * 0.40 + s.audioSurge * 0.30 + s.voiceSurge * 0.30
      const peak = Math.max(s.audioExcitement, s.audioSurge, s.voiceSurge)
      parts.push(`${mt('label.scoreAudio')}${Math.round(Math.min(1, avg * 0.6 + peak * 0.4) * 100)}%`)
    }
    if (s.causalBonus > 0.05) {
      parts.push(`${mt('label.signalCausalBonus')}${Math.round(s.causalBonus * 100)}%`)
    }
    if (s.aiFrameScore > 0 || s.aiTextScore > 0) {
      parts.push(`${mt('label.scoreAiFrame')}${Math.round(s.aiFrameScore * 100)}%`)
      parts.push(`${mt('label.scoreAiText')}${Math.round(s.aiTextScore * 100)}%`)
    }
    return parts.length > 0 ? parts.join(' | ') : mt('label.noSignal')
  }

  /** Detect config changes and log them to processing logs */
  private detectConfigChanges(config: ReturnType<typeof getConfig>): void {
    const current: Record<string, any> = {
      burst_threshold: config.slice.burst_threshold,
      heating_threshold: config.slice.heating_threshold,
      min_duration: config.slice.min_duration,
      max_duration: config.slice.max_duration,
      pre_buffer: config.slice.pre_buffer,
      post_buffer: config.slice.post_buffer,
      danmaku_weight: config.slice.danmaku_weight,
      audio_weight: config.slice.audio_weight,
      ai_weight: config.slice.ai_weight,
      analysis_interval: config.live.analysis_interval,
    }

    const prev = this.prevConfigSnapshot
    if (Object.keys(prev).length === 0) {
      // First run — just save snapshot
      this.prevConfigSnapshot = current
      return
    }

    const labels: Record<string, string> = {
      burst_threshold: mt('label.configBurstThreshold'),
      heating_threshold: mt('label.configHeatingThreshold'),
      min_duration: mt('label.configMinDuration'),
      max_duration: mt('label.configMaxDuration'),
      pre_buffer: mt('label.configPreBuffer'),
      post_buffer: mt('label.configPostBuffer'),
      danmaku_weight: mt('label.configDanmakuWeight'),
      audio_weight: mt('label.configAudioWeight'),
      ai_weight: mt('label.configAiWeight'),
      analysis_interval: mt('label.configAnalysisInterval'),
    }

    const changes: string[] = []
    for (const key of Object.keys(current)) {
      if (prev[key] !== current[key]) {
        const label = labels[key] || key
        const isPercent = key.includes('threshold') || key.includes('weight')
        const fmt = (v: number) => isPercent ? `${Math.round(v * 100)}%` : `${v}s`
        changes.push(`${label}: ${fmt(prev[key])} → ${fmt(current[key])}`)
      }
    }

    if (changes.length > 0) {
      this.addLog('info', mt('monitor.configUpdated', { changes: changes.join(', ') }))
      this.flushLogs()
      logger.info(`Config changed during monitoring: ${changes.join(', ')}`)
    }

    this.prevConfigSnapshot = current
  }

  private handleBurst(event: BurstEvent): void {
    const jobId = `${this.taskId}_${Date.now()}`
    const status = getQueueStatus()

    // Snapshot danmaku NOW — recentDanmaku is a rolling buffer (200 max),
    // by the time a queued slice executes, relevant messages may be evicted.
    const burstDuration = event.endTime - event.startTime
    const burstMidMs = this.monitorStartedAt
      ? new Date(this.monitorStartedAt).getTime() + ((event.startTime + event.endTime) / 2) * 1000
      : Date.now()
    const windowMs = Math.max(60000, burstDuration * 2 * 1000)
    const burstDanmaku = this.recentDanmaku.filter(m =>
      m.timestamp >= burstMidMs - windowMs && m.timestamp <= burstMidMs + windowMs
    )
    const snapshotDanmaku = burstDanmaku.length >= 3 ? burstDanmaku : [...this.recentDanmaku]

    const queued = status.running >= status.maxConcurrent
    if (queued) {
      this.addLog('info', mt('monitor.sliceQueued', { peak: Math.round(event.peakScore * 100) }) +
        ` (${mt('label.queueStatus', { running: status.running, queued: status.queued + 1 })})`)
      this.flushLogs()
    }

    const queuedAt = Date.now()
    this.slicingActive++
    enqueueSlice({
      id: jobId,
      taskId: this.taskId,
      execute: () => this.doSlice(event, snapshotDanmaku, queued ? queuedAt : 0)
        .finally(() => { this.slicingActive = Math.max(0, this.slicingActive - 1) }),
    })
  }

  private async doSlice(event: BurstEvent, snapshotDanmaku: DanmakuMessage[], queuedAt: number): Promise<void> {
    const config = getConfig()

    // Log queue wait time if this job was queued
    if (queuedAt > 0) {
      const waitSec = ((Date.now() - queuedAt) / 1000).toFixed(1)
      this.addLog('info', mt('monitor.sliceDequeued', { wait: waitSec }))
    }

    // Use the continuous recording file
    const recPath = this.recorder?.recordingPath || ''
    if (!recPath || !existsSync(recPath)) {
      const reason = !recPath ? '录制器未启动或路径为空' : `文件不存在: ${recPath}`
      this.addLog('warn', `${mt('monitor.recordNotFound')} (${reason})`)
      logger.warn(`Recording file check failed: recPath="${recPath}", exists=${recPath ? existsSync(recPath) : false}`)
      this.flushLogs()
      return
    }

    const fileSize = existsSync(recPath) ? `${(statSync(recPath).size / 1024 / 1024).toFixed(1)}MB` : '0'
    const elapsed = this.recorder?.recordingElapsed?.toFixed(0) || '?'
    const burstDuration = event.endTime - event.startTime
    this.addLog('info', mt('monitor.slicing', {
      start: this.formatTime(event.startTime),
      end: this.formatTime(event.endTime),
    }) + ` (${Math.round(burstDuration)}s) ${Math.round(event.peakScore * 100)}% (${elapsed}s, ${fileSize})`)
    this.flushLogs()

    const finalBurstDanmaku = snapshotDanmaku

    if (isAiConfigured()) {
      const whisperHint = isWhisperConfigured() ? mt('monitor.whisperHint') : ''
      this.addLog('info', mt('monitor.aiAnalyzing', { hint: whisperHint }))
      this.flushLogs()
    }

    const sliceStart = Date.now()

    // Get task info for context
    const task = getTask(this.taskId)

    try {
      const result = await cutSlice(
        this.taskId, recPath, event,
        config.storage.output_dir,
        {
          preBuffer: config.slice.pre_buffer,
          postBuffer: config.slice.post_buffer,
          burstDanmaku: finalBurstDanmaku,
          liveTitle: task?.title || '',
          recordingElapsed: this.recorder?.recordingElapsed || 0,
        },
      )

      const sliceDuration = ((Date.now() - sliceStart) / 1000).toFixed(1)

      if (result) {
        this.sliceCount++
        const clipLen = (result.endTime - result.startTime).toFixed(0)
        this.addLog('info', mt('monitor.sliceComplete', {
          num: this.sliceCount,
          title: result.title,
          duration: clipLen,
          cover: result.coverPath ? mt('monitor.coverYes') : mt('monitor.coverNo'),
          desc: result.description ? mt('monitor.coverYes') : mt('monitor.coverNo'),
          tags: result.tags?.length ? String(result.tags.length) : '0',
        }))
        // Log AI review result
        if (result.aiApproved === true) {
          this.addLog('info', mt('monitor.aiApproved', { reason: result.aiReviewReason || '' }))
        } else if (result.aiApproved === false) {
          this.addLog('warn', mt('monitor.aiRejected', { reason: result.aiReviewReason || '' }))
        } else if (result.aiReviewReason) {
          // AI was attempted but failed (aiApproved=null with reason)
          this.addLog('warn', mt('monitor.aiReviewFailed', { reason: result.aiReviewReason }))
        } else if (!isAiConfigured()) {
          this.addLog('info', mt('monitor.aiNotConfigured'))
        }
        this.flushLogs()
        this.emit('slice', result)

        // Push notification with more detail
        const taskInfo = getTask(this.taskId)
        pushNotification({
          type: 'slice',
          title: mt('notify.sliceComplete', { title: result.title }),
          body: `${taskInfo?.video_meta?.title || taskInfo?.title || ''} #${this.sliceCount} ` +
            `(${this.formatTime(result.startTime)}~${this.formatTime(result.endTime)}, ${clipLen}s) ` +
            `${sliceDuration}s`,
          taskId: this.taskId,
          sliceId: result.sliceId,
        })

        // Auto-publish if enabled and score exceeds threshold
        // Only auto-publish if AI approved (or AI not configured)
        if (result.aiApproved !== false) {
          await this.tryAutoPublish(result, event.peakScore)
        } else {
          this.addLog('info', `AI审核未通过，跳过自动发布 — ${result.aiReviewReason}`)
        }
      } else {
        const nowFileSize = existsSync(recPath) ? `${(statSync(recPath).size / 1024 / 1024).toFixed(1)}MB` : 'N/A'
        this.addLog('warn', mt('monitor.sliceFailed', { duration: sliceDuration, message: `${elapsed}s, ${nowFileSize}` }))
        this.flushLogs()
      }
    } catch (e: any) {
      const sliceDuration = ((Date.now() - sliceStart) / 1000).toFixed(1)
      this.addLog('warn', mt('monitor.sliceError', { duration: sliceDuration, message: e.message || e }))
      this.flushLogs()
      logger.error(`handleBurst exception: ${e.stack || e.message || e}`)
    }
  }

  private async tryAutoPublish(result: { sliceId: string; slicePath: string; coverPath: string; title: string; description: string; tags: string[] }, peakScore: number): Promise<void> {
    const config = getConfig()
    if (!config.publish?.auto_publish) return
    if (!config.publish.default_platforms?.length) return

    const threshold = config.publish.auto_publish_threshold ?? config.slice.burst_threshold
    if (peakScore < threshold) {
      this.addLog('info', mt('monitor.autoPublishSkip', { peak: Math.round(peakScore * 100), threshold: Math.round(threshold * 100) }))
      return
    }

    for (const platformName of config.publish.default_platforms) {
      try {
        const publisher = registry.getPublisher(platformName)
        if (!publisher) {
          this.addLog('warn', mt('monitor.publisherNotFound', { platform: platformName }))
          continue
        }

        // Use AI-generated description and tags, fall back to config defaults
        const autoDesc = result.description
          || config.publish.default_description
          || `${getTask(this.taskId)?.title || ''} — ${result.title}`
        const autoTags = result.tags?.length
          ? result.tags
          : (config.publish.default_tags?.length ? config.publish.default_tags : ['直播切片', '精彩时刻'])

        const videoSize = existsSync(result.slicePath)
          ? `${(statSync(result.slicePath).size / 1024 / 1024).toFixed(1)}MB`
          : '?'
        this.addLog('info', mt('monitor.autoPublishing', { platform: publisher.label, size: videoSize, tags: autoTags.join(', ') }))
        this.flushLogs()
        const pubStart = Date.now()
        const pubResult = await publisher.publish({
          videoPath: result.slicePath,
          title: result.title,
          description: autoDesc,
          tags: autoTags,
          coverPath: result.coverPath || undefined,
        })
        const pubDuration = ((Date.now() - pubStart) / 1000).toFixed(1)

        if (pubResult.success) {
          this.addLog('info', mt('monitor.publishSuccess', { platform: publisher.label, url: pubResult.publishUrl ? ' ' + pubResult.publishUrl : '' }))
          pushNotification({
            type: 'publish',
            title: mt('notify.autoPublishSuccess', { title: result.title }),
            body: mt('notify.publishedTo', { platform: publisher.label }) + (pubResult.publishUrl ? '\n' + pubResult.publishUrl : ''),
            taskId: this.taskId,
            sliceId: result.sliceId,
          })
        } else {
          this.addLog('warn', mt('monitor.publishFailed', { platform: publisher.label, duration: pubDuration, error: pubResult.error }))
          pushNotification({
            type: 'error',
            title: mt('notify.autoPublishFailed', { title: result.title }),
            body: `${publisher.label}: ${pubResult.error}`,
            taskId: this.taskId,
            sliceId: result.sliceId,
          })
        }
      } catch (e: any) {
        this.addLog('warn', mt('monitor.publishError', { platform: platformName, message: e.message }))
      }
    }
    this.flushLogs()
  }

  /** Refresh live cover image from platform API */
  private async refreshCover(): Promise<void> {
    try {
      const platformPlugin = registry.getPlatform(this.platform)
      if (!platformPlugin) return
      const liveInfo = await platformPlugin.getLiveInfo(this.url)
      if (liveInfo.coverUrl) {
        updateTask(this.taskId, { cover_url: liveInfo.coverUrl })
      }
      // Also update title if it changed
      if (liveInfo.title) {
        updateTask(this.taskId, { title: liveInfo.title })
      }
    } catch {
      // Silently ignore — cover refresh is best-effort
    }
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  private cleanup(): void {
    this.running = false
    if (this.analyzeTimer) {
      clearInterval(this.analyzeTimer)
      this.analyzeTimer = null
    }
    // Disconnect danmaku
    const danmaku = registry.getDanmaku(this.platform)
    if (danmaku?.isConnected) {
      danmaku.disconnect().catch(() => {})
    }
  }
}

// Active monitors registry
const activeMonitors = new Map<string, LiveMonitor>()

export function startMonitor(taskId: string, url: string, platform: string): LiveMonitor {
  if (activeMonitors.has(taskId)) {
    throw new Error(`Monitor already running for task ${taskId}`)
  }

  const monitor = new LiveMonitor(taskId, url, platform)
  activeMonitors.set(taskId, monitor)

  monitor.start().finally(() => {
    activeMonitors.delete(taskId)
  })

  return monitor
}

export function stopMonitor(taskId: string): void {
  const monitor = activeMonitors.get(taskId)
  if (monitor) {
    monitor.stop()
    activeMonitors.delete(taskId)
  }
}

export function getActiveMonitor(taskId: string): LiveMonitor | undefined {
  return activeMonitors.get(taskId)
}

export function getActiveTaskIds(): string[] {
  return Array.from(activeMonitors.keys())
}
