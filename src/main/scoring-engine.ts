import type { DanmakuMessage } from './plugins/danmaku/types'
import type { AudioFeatures } from './audio-analyzer'
import { getLogger } from './utils/logger'

const logger = getLogger('scoring-engine')

export interface SignalScores {
  danmakuDensity: number
  danmakuAcceleration: number
  uniqueUserBurst: number
  emotionScore: number
  consensusScore: number
  giftScore: number
  audioExcitement: number
  audioSurge: number
  voiceSurge: number
  causalBonus: number
  aiFrameScore: number
  aiTextScore: number
}

export interface ScoringResult {
  totalScore: number
  signals: SignalScores
  resonanceBonus: number
}

export interface ScoringWeights {
  danmaku: number  // weight for all danmaku signals combined
  audio: number    // weight for audio signals combined
  ai: number       // weight for AI signals combined
}

export class ScoringEngine {
  private prevDanmakuRate = 0
  private audioRmsHistory: number[] = []
  private recentMessages: DanmakuMessage[] = []
  private giftTimestamps: number[] = []
  private lastAiFrameScore = 0
  private lastAiTextScore = 0
  private aiScoreAge = 0
  private weights: ScoringWeights = { danmaku: 0.55, audio: 0.30, ai: 0.15 }

  // Adaptive baseline for danmaku density normalization
  private rateHistory: number[] = []
  private baselineRate = 0
  private baselineInitialized = false
  private feedCount = 0
  /** Have we ever received any danmaku? Baseline only starts after first danmaku arrives. */
  private hasEverReceivedDanmaku = false

  // Adaptive baseline for unique user rate
  private baselineUniqueRate = 0
  private baselineUniqueInitialized = false

  // Adaptive baseline for gift density normalization
  private baselineGiftRate = 0
  private baselineGiftInitialized = false

  // Voice surge detection
  private voiceEnergyHistory: number[] = []

  // Temporal causal detection: audio spike → danmaku spike (1-3s delay)
  // Keeps recent (timestamp, audioSurge, voiceSurge, danmakuDensity) for correlation
  private signalHistory: Array<{ ts: number; audio: number; voice: number; danmaku: number }> = []

  setWeights(w: ScoringWeights): void {
    this.weights = { ...w }
  }

  setCustomKeywords(_keywords: string[] | Record<string, number> | undefined): void {
    // No-op: keyword-based detection removed in favor of statistical emotion analysis.
    // Kept for API compatibility with config system.
  }

  feedDanmaku(msg: DanmakuMessage): void {
    this.recentMessages.push(msg)
    const cutoff = Date.now() - 60000
    this.recentMessages = this.recentMessages.filter(m => m.timestamp > cutoff)

    if (msg.type === 'gift' || msg.type === 'superchat') {
      this.giftTimestamps.push(msg.timestamp)
      this.giftTimestamps = this.giftTimestamps.filter(t => t > cutoff)
      logger.debug(`[ScoringEngine] Gift: ${msg.userName} sent ${msg.giftName}`)
    } else if (msg.type === 'chat') {
      logger.debug(`[ScoringEngine] Chat: ${msg.userName}: ${msg.text}`)
    }
  }

  computeScores(
    danmakuTimestamps: number[],
    audioFeatures: AudioFeatures | null,
    analysisInterval: number,
    aiScores?: { frameScore: number; textScore: number },
  ): ScoringResult {
    const now = Date.now()
    const windowMs = analysisInterval * 1000

    // --- 1. Danmaku density (ADAPTIVE) ---
    const recentCount = danmakuTimestamps.filter(t => t > now - windowMs).length
    const currentRate = recentCount / analysisInterval

    // Only start building baseline after we've actually received danmaku.
    // Without this, the baseline gets established at 0 during the "waiting for danmaku"
    // phase, and then ANY danmaku arrival triggers a false spike.
    if (recentCount > 0 || this.hasEverReceivedDanmaku) {
      this.hasEverReceivedDanmaku = true
      this.feedCount++
    }

    this.rateHistory.push(currentRate)
    const maxSamples = Math.max(60, Math.ceil(300 / analysisInterval))
    if (this.rateHistory.length > maxSamples) this.rateHistory.shift()

    if (this.hasEverReceivedDanmaku) {
      const alpha = this.baselineInitialized ? 0.05 : 0.4
      if (!this.baselineInitialized && this.feedCount === 1) {
        this.baselineRate = currentRate
      } else {
        this.baselineRate = this.baselineRate * (1 - alpha) + currentRate * alpha
      }
      if (this.feedCount >= 5) this.baselineInitialized = true
    }

    let danmakuDensity: number
    if (this.baselineRate < 0.5) {
      danmakuDensity = Math.min(1, currentRate / 3)
    } else {
      const spikeRatio = currentRate / this.baselineRate
      danmakuDensity = Math.min(1, Math.max(0, (spikeRatio - 1) / 3))
      if (currentRate > 0.5 && danmakuDensity < 0.1) danmakuDensity = 0.1
    }

    // --- 2. Danmaku acceleration (rate of change) ---
    let danmakuAcceleration = 0
    if (this.prevDanmakuRate > 0.5) {
      const ratio = currentRate / this.prevDanmakuRate
      danmakuAcceleration = Math.min(1, Math.max(0, (ratio - 1) / 2))
    } else if (currentRate > 1) {
      danmakuAcceleration = Math.min(1, currentRate / 3)
    }
    this.prevDanmakuRate = currentRate

    if (this.feedCount <= 10 || this.feedCount % 30 === 0) {
      logger.info(`[ScoringEngine-Danmaku] feedCount=${this.feedCount} rate=${currentRate.toFixed(1)}/s baseline=${this.baselineRate.toFixed(1)}/s density=${danmakuDensity.toFixed(3)} hasEverReceived=${this.hasEverReceivedDanmaku}`)
    }

    // --- 3. Unique user burst (ADAPTIVE) ---
    // Counts distinct users in the window. A spike in unique users = many people
    // reacting simultaneously, much stronger signal than one person spamming.
    const windowMessages = this.recentMessages.filter(m => m.timestamp > now - windowMs && m.type === 'chat')
    const uniqueUsers = new Set(windowMessages.map(m => m.userName)).size
    const uniqueRate = uniqueUsers / analysisInterval

    const uAlpha = this.baselineUniqueInitialized ? 0.05 : 0.3
    if (!this.baselineUniqueInitialized && this.feedCount === 1) {
      this.baselineUniqueRate = uniqueRate
    } else {
      this.baselineUniqueRate = this.baselineUniqueRate * (1 - uAlpha) + uniqueRate * uAlpha
    }
    if (this.feedCount >= 5) this.baselineUniqueInitialized = true

    let uniqueUserBurst: number
    if (this.baselineUniqueRate < 0.3) {
      uniqueUserBurst = Math.min(1, uniqueRate / 2)
    } else {
      const uSpike = uniqueRate / this.baselineUniqueRate
      uniqueUserBurst = Math.min(1, Math.max(0, (uSpike - 1) / 3))
    }

    // --- 4. Emotion score (statistical, no keyword table) ---
    // Detects excitement from message SHAPE, not content:
    // - Short messages (≤4 chars): people type fast when excited
    // - Character repetition ("哈哈哈哈", "啊啊啊"): strong emotion
    // - Punctuation density ("！！！", "???"): emotional expression
    // - Pure symbols/numbers ("666", "??", "!!"): rapid reactions
    const recentTexts = windowMessages.map(m => m.text)
    let shortMsgCount = 0
    let charRepeatCount = 0
    let punctDenseCount = 0
    let pureSymbolCount = 0

    for (const text of recentTexts) {
      const len = text.length
      // Short burst messages
      if (len <= 4) shortMsgCount++
      // Character repetition: "哈哈哈", "啊啊啊啊", "666666"
      if (len >= 2 && hasRepeatingChars(text)) charRepeatCount++
      // Punctuation-heavy messages
      const punctCount = (text.match(/[！？!?。，、…~～]/g) || []).length
      if (punctCount >= 2 || (len > 0 && punctCount / len >= 0.3)) punctDenseCount++
      // Pure symbols/numbers (no meaningful text, just raw reaction)
      if (/^[\d\s\p{P}\p{S}]+$/u.test(text)) pureSymbolCount++
    }

    const emotionScore = recentTexts.length > 0
      ? Math.min(1,
          (shortMsgCount / recentTexts.length) * 0.3 +
          (charRepeatCount / recentTexts.length) * 0.3 +
          (punctDenseCount / recentTexts.length) * 0.2 +
          (pureSymbolCount / recentTexts.length) * 0.2
        )
      : 0

    // --- 5. Consensus score ---
    // Measures how many different users send very similar messages in the window.
    // Many people independently typing the same thing = consensus moment.
    // Weighted by unique users to distinguish from single-user spam.
    const textByUser = new Map<string, Set<string>>() // text → set of users
    for (const msg of windowMessages) {
      const normalized = msg.text.trim().slice(0, 10) // normalize: first 10 chars
      if (!textByUser.has(normalized)) textByUser.set(normalized, new Set())
      textByUser.get(normalized)!.add(msg.userName)
    }
    let maxConsensusUsers = 0
    for (const users of textByUser.values()) {
      if (users.size > maxConsensusUsers) maxConsensusUsers = users.size
    }
    // Consensus: how many unique users said the same thing, relative to total unique users
    const consensusScore = uniqueUsers >= 3
      ? Math.min(1, (maxConsensusUsers / uniqueUsers) * 1.5)
      : 0

    // --- 6. Gift density (ADAPTIVE) ---
    const recentGiftCount = this.giftTimestamps.filter(t => t > now - windowMs).length
    const giftRate = recentGiftCount / analysisInterval

    const giftAlpha = this.baselineGiftInitialized ? 0.05 : 0.2
    if (!this.baselineGiftInitialized && this.giftTimestamps.length > 0 && this.baselineGiftRate === 0) {
      this.baselineGiftRate = giftRate
    } else {
      this.baselineGiftRate = this.baselineGiftRate * (1 - giftAlpha) + giftRate * giftAlpha
    }
    if (this.feedCount >= 15) this.baselineGiftInitialized = true

    let giftScore: number
    if (this.baselineGiftRate < 0.3) {
      giftScore = Math.min(1, giftRate / 2)
    } else {
      const giftSpikeRatio = giftRate / this.baselineGiftRate
      giftScore = Math.min(1, Math.max(0, (giftSpikeRatio - 1) / 3))
      if (giftRate > 0.3 && giftScore < 0.1) giftScore = 0.1
    }

    // --- 7. Audio excitement ---
    // Use adaptive normalization: compare current RMS to rolling average.
    // Raw RMS is typically 0.02-0.1 for speech, so absolute thresholds are unreliable.
    let audioExcitement = 0
    if (audioFeatures) {
      const avgRms = this.audioRmsHistory.length >= 2
        ? this.audioRmsHistory.slice(0, -1).reduce((a, b) => a + b, 0) / (this.audioRmsHistory.length - 1)
        : audioFeatures.loudness
      // Relative excitement: how much louder than average
      const relativeExcitement = avgRms > 0.005
        ? Math.min(1, Math.max(0, (audioFeatures.loudness / avgRms - 1) / 1.0))
        : Math.min(1, audioFeatures.loudness / 0.1)
      // Absolute excitement: loud enough on its own
      const absoluteExcitement = Math.min(1, audioFeatures.loudness * 4 + audioFeatures.spectralCentroid * 0.5)
      // Blend: relative is more reliable, but absolute prevents false negatives in quiet streams
      audioExcitement = Math.max(relativeExcitement, absoluteExcitement * 0.6)
    }

    // --- 8. Audio surge ---
    let audioSurge = 0
    if (audioFeatures) {
      const currentLoud = audioFeatures.loudness
      this.audioRmsHistory.push(currentLoud)
      if (this.audioRmsHistory.length > 20) this.audioRmsHistory.shift()
      if (this.audioRmsHistory.length >= 2) {
        const history = this.audioRmsHistory.slice(0, -1)
        const avg = history.reduce((a, b) => a + b, 0) / history.length
        if (avg > 0.001) {
          audioSurge = Math.min(1, Math.max(0, (currentLoud / avg - 1) / 0.5))
        } else if (currentLoud > 0.01) {
          audioSurge = Math.min(1, currentLoud / 0.1)
        }
      }
      logger.debug(`Audio: rms=${audioFeatures.rms.toFixed(4)} loud=${currentLoud.toFixed(4)} surge=${audioSurge.toFixed(3)}`)
    }

    // --- 8b. Voice surge (streamer shouting/laughing detection) ---
    // Tracks voice-band energy (300-3000Hz) over time.
    // A sudden spike in voice energy relative to rolling average = streamer excitement.
    let voiceSurge = 0
    if (audioFeatures) {
      const ve = audioFeatures.voiceEnergy ?? 0
      this.voiceEnergyHistory.push(ve)
      if (this.voiceEnergyHistory.length > 20) this.voiceEnergyHistory.shift()
      if (this.voiceEnergyHistory.length >= 3) {
        const history = this.voiceEnergyHistory.slice(0, -1)
        const avg = history.reduce((a, b) => a + b, 0) / history.length
        if (avg > 0.01) {
          voiceSurge = Math.min(1, Math.max(0, (ve / avg - 1) / 0.8))
        } else if (ve > 0.05) {
          voiceSurge = Math.min(1, ve / 0.3)
        }
      }
      // Weight by voiceRatio: if mostly game/music audio, voice surge is less meaningful
      const voiceRatio = audioFeatures.voiceRatio ?? 0
      voiceSurge *= Math.min(1, voiceRatio * 2)
      logger.debug(`Voice: energy=${ve.toFixed(4)} ratio=${voiceRatio.toFixed(3)} surge=${voiceSurge.toFixed(3)}`)
    }

    // --- 8c. Temporal causal bonus ---
    // Audio/voice spike → danmaku spike with 1-3s delay = confirmed burst.
    // The idea: streamer does something exciting (audio spikes first),
    // then viewers react in danmaku 1-3 seconds later.
    let causalBonus = 0
    const nowSec = Date.now() / 1000
    this.signalHistory.push({
      ts: nowSec,
      audio: audioSurge,
      voice: voiceSurge,
      danmaku: danmakuDensity,
    })
    // Keep last 30 seconds of signal history
    const historyCutoff = nowSec - 30
    while (this.signalHistory.length > 0 && this.signalHistory[0].ts < historyCutoff) {
      this.signalHistory.shift()
    }
    if (this.signalHistory.length >= 3 && danmakuDensity > 0.3) {
      // Look back 1-3 seconds for an audio/voice spike
      const lookbackMin = nowSec - 3
      const lookbackMax = nowSec - 1
      let maxPastAudio = 0
      let maxPastVoice = 0
      for (const entry of this.signalHistory) {
        if (entry.ts >= lookbackMin && entry.ts <= lookbackMax) {
          if (entry.audio > maxPastAudio) maxPastAudio = entry.audio
          if (entry.voice > maxPastVoice) maxPastVoice = entry.voice
        }
      }
      // Causal bonus: audio/voice spiked recently AND danmaku is spiking now
      const pastPeak = Math.max(maxPastAudio, maxPastVoice)
      if (pastPeak > 0.3) {
        causalBonus = Math.min(0.3, pastPeak * danmakuDensity)
        logger.debug(`Causal bonus: pastPeak=${pastPeak.toFixed(3)} × danmaku=${danmakuDensity.toFixed(3)} → ${causalBonus.toFixed(3)}`)
      }
    }

    // --- 9/10. AI scores with caching ---
    const aiFrameScore = aiScores?.frameScore ?? this.lastAiFrameScore
    const aiTextScore = aiScores?.textScore ?? this.lastAiTextScore
    if (aiScores) {
      this.lastAiFrameScore = aiScores.frameScore
      this.lastAiTextScore = aiScores.textScore
      this.aiScoreAge = 0
    } else {
      this.aiScoreAge++
      if (this.aiScoreAge > 5) {
        this.lastAiFrameScore = 0
        this.lastAiTextScore = 0
      }
    }

    const signals: SignalScores = {
      danmakuDensity, danmakuAcceleration, uniqueUserBurst, emotionScore,
      consensusScore, giftScore, audioExcitement, audioSurge,
      voiceSurge, causalBonus, aiFrameScore, aiTextScore,
    }

    // --- Dynamic weight redistribution ---
    const hasDanmaku = danmakuTimestamps.length > 0
    const hasAi = aiFrameScore > 0 || aiTextScore > 0
    const hasAudio = audioFeatures !== null

    let dW = this.weights.danmaku
    let aW = this.weights.audio
    let aiW = this.weights.ai

    if (!hasDanmaku && !hasAi && !hasAudio) {
      dW = 0; aW = 0; aiW = 0
    } else {
      if (!hasDanmaku) {
        const redistribute = dW; dW = 0
        const remaining = aW + aiW
        if (remaining > 0) { aW += redistribute * (aW / remaining); aiW += redistribute * (aiW / remaining) }
      }
      if (!hasAi) {
        const redistribute = aiW; aiW = 0
        const remaining = dW + aW
        if (remaining > 0) { dW += redistribute * (dW / remaining); aW += redistribute * (aW / remaining) }
      }
      if (!hasAudio) {
        const redistribute = aW; aW = 0
        const remaining = dW + aiW
        if (remaining > 0) { dW += redistribute * (dW / remaining); aiW += redistribute * (aiW / remaining) }
      }
    }

    // Sub-weights within each signal group
    // Use "peak-boosted average": weighted average + 50% of max sub-signal.
    // This prevents the common case where one strong signal gets diluted by many zero signals.

    // Danmaku: density 25%, acceleration 15%, unique users 25%, emotion 15%, consensus 10%, gift 10%
    let danmakuGroup = 0
    if (hasDanmaku) {
      const avg = danmakuDensity * 0.25 + danmakuAcceleration * 0.15 + uniqueUserBurst * 0.25 +
        emotionScore * 0.15 + consensusScore * 0.10 + giftScore * 0.10
      const peak = Math.max(danmakuDensity, danmakuAcceleration, uniqueUserBurst, emotionScore, consensusScore, giftScore)
      danmakuGroup = Math.min(1, avg * 0.6 + peak * 0.4)
    }
    // Audio group: excitement 40%, surge 30%, voice surge 30%
    let audioGroup = 0
    if (hasAudio) {
      const avg = audioExcitement * 0.40 + audioSurge * 0.30 + voiceSurge * 0.30
      const peak = Math.max(audioExcitement, audioSurge, voiceSurge)
      audioGroup = Math.min(1, avg * 0.6 + peak * 0.4)
    }
    // AI group: frame 50%, text 50%
    let aiGroup = 0
    if (hasAi) {
      const avg = aiFrameScore * 0.50 + aiTextScore * 0.50
      const peak = Math.max(aiFrameScore, aiTextScore)
      aiGroup = Math.min(1, avg * 0.6 + peak * 0.4)
    }

    const baseScore = danmakuGroup * dW + audioGroup * aW + aiGroup * aiW

    // Cross-signal resonance: audio spike + danmaku spike together = high confidence
    const highGroups = [danmakuGroup, audioGroup, aiGroup].filter(s => s > 0.4).length
    const crossResonance = highGroups >= 2 ? Math.min(0.15, (highGroups - 1) * 0.10) : 0
    // Causal bonus adds on top of cross-resonance (capped at 0.3 total bonus)
    const resonanceBonus = Math.min(0.3, crossResonance + causalBonus)

    const totalScore = Math.min(1, baseScore + resonanceBonus)

    // Periodic detailed score breakdown for debugging
    if (this.feedCount <= 10 || this.feedCount % 10 === 0 || totalScore > 0.15) {
      logger.debug(
        `Score: total=${totalScore.toFixed(3)} = ` +
        `danmaku(${danmakuGroup.toFixed(3)}×${dW.toFixed(2)}) + audio(${audioGroup.toFixed(3)}×${aW.toFixed(2)}) + ai(${aiGroup.toFixed(3)}×${aiW.toFixed(2)}) + resonance(${resonanceBonus.toFixed(3)}) | ` +
        `subs: density=${danmakuDensity.toFixed(3)} accel=${danmakuAcceleration.toFixed(3)} unique=${uniqueUserBurst.toFixed(3)} emotion=${emotionScore.toFixed(3)} | ` +
        `audioEx=${audioExcitement.toFixed(3)} audioSurge=${audioSurge.toFixed(3)} voiceSurge=${voiceSurge.toFixed(3)}`
      )
    }

    return { totalScore, signals, resonanceBonus }
  }

  getGiftCount(): number {
    return this.giftTimestamps.length
  }

  getGiftCountInWindow(intervalSeconds: number): number {
    const cutoff = Date.now() - intervalSeconds * 1000
    return this.giftTimestamps.filter(t => t > cutoff).length
  }

  reset(): void {
    this.prevDanmakuRate = 0
    this.audioRmsHistory = []
    this.recentMessages = []
    this.giftTimestamps = []
    this.lastAiFrameScore = 0
    this.lastAiTextScore = 0
    this.aiScoreAge = 0
    this.rateHistory = []
    this.baselineRate = 0
    this.baselineInitialized = false
    this.feedCount = 0
    this.hasEverReceivedDanmaku = false
    this.baselineUniqueRate = 0
    this.baselineUniqueInitialized = false
    this.baselineGiftRate = 0
    this.baselineGiftInitialized = false
    this.voiceEnergyHistory = []
    this.signalHistory = []
  }

  getBaselineRate(): number {
    return this.baselineRate
  }

  isWarmedUp(): boolean {
    // Warmed up when danmaku baseline is established,
    // OR when we have enough audio history to run audio-only analysis.
    // This allows degraded audio-only detection when danmaku is unavailable.
    return this.baselineInitialized || this.audioRmsHistory.length >= 5
  }

  getFeedCount(): number {
    return this.feedCount
  }
}

/**
 * Check if a string has repeating characters (e.g. "哈哈哈", "666", "aaa").
 * Returns true if >50% of the string is a single repeated character or pattern.
 */
function hasRepeatingChars(text: string): boolean {
  if (text.length < 2) return false
  // Single char repeat: "哈哈哈", "666"
  const firstChar = text[0]
  if (text.split('').every(c => c === firstChar)) return true
  // Two-char pattern repeat: "哈哈哈哈" (ha repeating), "6666"
  if (text.length >= 4) {
    const pat2 = text.slice(0, 2)
    const repeated = pat2.repeat(Math.ceil(text.length / 2)).slice(0, text.length)
    if (repeated === text) return true
  }
  // >50% same character
  const charCounts = new Map<string, number>()
  for (const c of text) charCounts.set(c, (charCounts.get(c) || 0) + 1)
  for (const count of charCounts.values()) {
    if (count / text.length >= 0.5) return true
  }
  return false
}
