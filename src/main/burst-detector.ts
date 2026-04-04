import { EventEmitter } from 'events'
import { getLogger } from './utils/logger'

const logger = getLogger('burst-detector')

export type BurstState = 'idle' | 'heating' | 'burst'

export interface BurstEvent {
  startTime: number
  endTime: number
  peakScore: number
  avgScore: number
}

export interface BurstDetectorConfig {
  heatingThreshold: number    // score to enter heating state (default 0.35)
  burstThreshold: number      // score to confirm burst (default 0.6); also used as exit threshold
  minBurstDuration: number    // minimum burst duration in seconds (default 5)
  maxBurstDuration: number    // maximum burst duration — should be max_duration - pre_buffer - post_buffer
  heatingTimeout: number      // max heating time before falling back to idle (default 20)
}

const DEFAULT_CONFIG: BurstDetectorConfig = {
  heatingThreshold: 0.35,
  burstThreshold: 0.6,
  minBurstDuration: 5,
  maxBurstDuration: 120,
  heatingTimeout: 20,
}

export class BurstDetector extends EventEmitter {
  private state: BurstState = 'idle'
  private config: BurstDetectorConfig
  private burstStartTime = 0
  private heatingStartTime = 0
  /** Wall-clock time (Date.now()) when burst started — used for maxBurstDuration safety net */
  private burstStartWallTime = 0
  private scores: number[] = []
  private peakScore = 0
  private scoreHistory: number[] = []
  /** Consecutive cycles below burstThreshold — need 3 to confirm burst end */
  private belowCount = 0

  constructor(config?: Partial<BurstDetectorConfig>) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  getState(): BurstState {
    return this.state
  }

  getThreshold(): number {
    return this.config.burstThreshold
  }

  setThreshold(threshold: number): void {
    this.config.burstThreshold = threshold
  }

  updateConfig(partial: Partial<BurstDetectorConfig>): void {
    Object.assign(this.config, partial)
  }

  /**
   * Feed a new score (0-1) at the given timestamp (seconds offset).
   * Returns the current state after processing.
   *
   * State machine: idle → heating → burst → idle
   * - idle → heating: score >= effectiveHeatingThreshold
   * - heating → burst: score >= burstThreshold
   * - heating → idle: score < effectiveHeatingThreshold OR timeout
   * - burst → idle (emit slice): score < burstThreshold (after minBurstDuration) OR maxBurstDuration reached
   */
  feed(score: number, timestamp: number): BurstState {
    this.scoreHistory.push(score)
    if (this.scoreHistory.length > 60) this.scoreHistory.shift()

    // Effective heating threshold must never exceed burst threshold,
    // otherwise the system can never enter burst state.
    const effectiveHeating = Math.min(this.config.heatingThreshold, this.config.burstThreshold * 0.7)

    switch (this.state) {
      case 'idle':
        if (score >= effectiveHeating) {
          this.state = 'heating'
          this.heatingStartTime = timestamp
          this.scores = [score]
          this.peakScore = score
          logger.debug(`State: idle -> heating at ${timestamp}s (score=${score.toFixed(3)})`)
        }
        break

      case 'heating':
        this.scores.push(score)
        this.peakScore = Math.max(this.peakScore, score)

        if (score >= this.config.burstThreshold) {
          this.state = 'burst'
          this.burstStartTime = this.heatingStartTime
          this.burstStartWallTime = Date.now()
          logger.info(`State: heating -> burst at ${timestamp}s (score=${score.toFixed(3)})`)
        } else if (score < effectiveHeating) {
          this.state = 'idle'
          this.scores = []
          this.peakScore = 0
          logger.debug(`State: heating -> idle (score dropped)`)
        } else if (timestamp - this.heatingStartTime > this.config.heatingTimeout) {
          this.state = 'idle'
          this.scores = []
          this.peakScore = 0
          logger.debug(`State: heating -> idle (timeout)`)
        }
        break

      case 'burst':
        this.scores.push(score)
        this.peakScore = Math.max(this.peakScore, score)
        const burstDuration = timestamp - this.burstStartTime
        // Wall-clock duration is the safety net — works even if recording timestamp resets
        const wallDuration = (Date.now() - this.burstStartWallTime) / 1000

        if (score < this.config.burstThreshold) {
          this.belowCount++
        } else {
          this.belowCount = 0
        }

        if (this.belowCount >= 3 && burstDuration >= this.config.minBurstDuration) {
          // Score stayed below threshold for 3 consecutive cycles — confirmed end
          this.emitBurst(timestamp)
          logger.info(`State: burst -> idle at ${timestamp}s (duration=${burstDuration.toFixed(1)}s, wall=${wallDuration.toFixed(0)}s)`)
        } else if (burstDuration >= this.config.maxBurstDuration || wallDuration >= this.config.maxBurstDuration) {
          // Hit max duration — force slice
          this.emitBurst(timestamp)
          logger.info(`State: burst -> idle (max duration, burst=${burstDuration.toFixed(1)}s, wall=${wallDuration.toFixed(0)}s)`)
        }
        break
    }

    return this.state
  }

  private emitBurst(endTime: number): void {
    const avg = this.scores.length > 0
      ? this.scores.reduce((a, b) => a + b, 0) / this.scores.length
      : 0

    const event: BurstEvent = {
      startTime: this.burstStartTime,
      endTime,
      peakScore: this.peakScore,
      avgScore: avg,
    }

    // Reset to idle before emitting — handler may call feed() synchronously
    this.state = 'idle'
    this.scores = []
    this.peakScore = 0
    this.belowCount = 0
    this.burstStartWallTime = 0

    this.emit('burst', event)
    logger.info(
      `Burst detected: ${event.startTime.toFixed(1)}s - ${event.endTime.toFixed(1)}s ` +
      `(peak=${event.peakScore.toFixed(3)}, avg=${event.avgScore.toFixed(3)})`
    )
  }

  reset(): void {
    this.state = 'idle'
    this.scores = []
    this.peakScore = 0
    this.burstStartTime = 0
    this.burstStartWallTime = 0
    this.heatingStartTime = 0
    this.scoreHistory = []
    this.belowCount = 0
  }
}
