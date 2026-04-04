import { readFileSync } from 'fs'
import { extractAudio } from './ffmpeg'
import { getLogger } from './utils/logger'

const logger = getLogger('audio-analyzer')

export interface AudioFeatures {
  rms: number
  zeroCrossingRate: number
  spectralCentroid: number
  loudness: number
  /** Energy in the human voice band (300-3000Hz), normalized 0-1 */
  voiceEnergy: number
  /** Ratio of voice-band energy to total energy (high = mostly voice, low = mostly game/music) */
  voiceRatio: number
}

export interface ExcitementScore {
  score: number
  features: AudioFeatures
}

/**
 * Analyze audio excitement from a WAV/PCM file.
 * Uses raw PCM processing - no external audio lib needed.
 */
export async function analyzeExcitement(
  videoPath: string,
  startSec?: number,
  duration: number = 5
): Promise<ExcitementScore> {
  // Extract PCM audio via ffmpeg
  // Keep timeout short — analysis is non-blocking, so a timeout just delays the next result
  const tmpPath = videoPath + '.analysis.wav'
  const timeout = videoPath.endsWith('.ts') ? 15000 : 10000
  logger.debug(`[Audio] Starting analysis: videoPath=${videoPath}, startSec=${startSec}, duration=${duration}s, timeout=${timeout}ms`)
  try {
    await extractAudio(videoPath, tmpPath, startSec, duration, timeout)
    logger.debug(`[Audio] Extraction completed, tmpPath=${tmpPath}`)
  } catch (e) {
    logger.error(`[Audio] Extraction failed: ${e}`)
    return { score: 0, features: { rms: 0, zeroCrossingRate: 0, spectralCentroid: 0, loudness: 0, voiceEnergy: 0, voiceRatio: 0 } }
  }

  try {
    const wavData = readFileSync(tmpPath)
    logger.debug(`[Audio] WAV file read: size=${wavData.length} bytes`)

    if (wavData.length < 44) {
      logger.error(`[Audio] WAV file too small (${wavData.length} bytes, need at least 44 for header)`)
      return { score: 0, features: { rms: 0, zeroCrossingRate: 0, spectralCentroid: 0, loudness: 0, voiceEnergy: 0, voiceRatio: 0 } }
    }

    // Skip WAV header (44 bytes), read 16-bit PCM samples
    const sampleCount = (wavData.length - 44) / 2
    logger.debug(`[Audio] WAV format: ${sampleCount} PCM samples (${(sampleCount / 16000).toFixed(2)}s at 16kHz)`)

    const samples = new Int16Array(wavData.buffer, wavData.byteOffset + 44, sampleCount)
    const features = computeFeatures(samples, 16000)

    logger.info(`[Audio] Features computed: rms=${features.rms.toFixed(4)}, zcr=${features.zeroCrossingRate.toFixed(4)}, centroid=${features.spectralCentroid.toFixed(4)}, loudness=${features.loudness.toFixed(4)}, voiceEnergy=${features.voiceEnergy.toFixed(4)}, voiceRatio=${features.voiceRatio.toFixed(4)}`)

    // Weighted excitement score (0-1)
    const score = Math.min(1, (
      features.rms * 3.0 +
      features.zeroCrossingRate * 0.5 +
      features.spectralCentroid * 0.3 +
      features.loudness * 2.0
    ) / 4)

    logger.info(`[Audio] Excitement score: ${score.toFixed(4)}`)
    return { score, features }
  } catch (e) {
    logger.error(`[Audio] Analysis failed: ${e}`)
    return { score: 0, features: { rms: 0, zeroCrossingRate: 0, spectralCentroid: 0, loudness: 0, voiceEnergy: 0, voiceRatio: 0 } }
  } finally {
    try { require('fs').unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

function computeFeatures(samples: Int16Array, sampleRate: number): AudioFeatures {
  if (samples.length === 0) {
    return { rms: 0, zeroCrossingRate: 0, spectralCentroid: 0, loudness: 0, voiceEnergy: 0, voiceRatio: 0 }
  }

  // Normalize to -1..1
  const normalized = new Float64Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    normalized[i] = samples[i] / 32768.0
  }

  // RMS
  let sumSq = 0
  for (let i = 0; i < normalized.length; i++) {
    sumSq += normalized[i] * normalized[i]
  }
  const rms = Math.sqrt(sumSq / normalized.length)

  // Zero crossing rate
  let crossings = 0
  for (let i = 1; i < normalized.length; i++) {
    if ((normalized[i] >= 0) !== (normalized[i - 1] >= 0)) crossings++
  }
  const zeroCrossingRate = crossings / normalized.length

  // DFT on a window — compute magnitudes per frequency bin
  const windowSize = Math.min(2048, normalized.length)
  const window = normalized.slice(0, windowSize)
  const halfWindow = windowSize / 2
  const magnitudes = new Float64Array(halfWindow)

  for (let k = 0; k < halfWindow; k++) {
    let re = 0, im = 0
    for (let n = 0; n < windowSize; n++) {
      const angle = -2 * Math.PI * k * n / windowSize
      re += window[n] * Math.cos(angle)
      im += window[n] * Math.sin(angle)
    }
    magnitudes[k] = Math.sqrt(re * re + im * im)
  }

  // Spectral centroid
  let weightedSum = 0, magnitudeSum = 0
  for (let k = 0; k < halfWindow; k++) {
    const freq = k * sampleRate / windowSize
    weightedSum += freq * magnitudes[k]
    magnitudeSum += magnitudes[k]
  }
  const spectralCentroid = magnitudeSum > 0
    ? Math.min(1, (weightedSum / magnitudeSum) / (sampleRate / 2))
    : 0

  // Loudness (simplified LUFS-like)
  const loudness = Math.min(1, rms * 3)

  // Voice band energy: 300-3000Hz
  // At 16kHz sample rate, DFT bin k corresponds to frequency k * sampleRate / windowSize
  // 300Hz → bin 38.4, 3000Hz → bin 384
  const voiceLowBin = Math.ceil(300 * windowSize / sampleRate)
  const voiceHighBin = Math.min(halfWindow - 1, Math.floor(3000 * windowSize / sampleRate))

  let voiceBandEnergy = 0
  let totalEnergy = 0
  for (let k = 1; k < halfWindow; k++) {
    const energy = magnitudes[k] * magnitudes[k]
    totalEnergy += energy
    if (k >= voiceLowBin && k <= voiceHighBin) {
      voiceBandEnergy += energy
    }
  }

  const voiceEnergy = Math.min(1, Math.sqrt(voiceBandEnergy / halfWindow) * 5)
  const voiceRatio = totalEnergy > 0 ? voiceBandEnergy / totalEnergy : 0

  return { rms, zeroCrossingRate, spectralCentroid, loudness, voiceEnergy, voiceRatio }
}
