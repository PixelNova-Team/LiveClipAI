import { writeFileSync } from 'fs'
import type { TranscriptSegment } from './ai-client'
import { getLogger } from './utils/logger'

const logger = getLogger('subtitle')

/**
 * Format seconds to SRT timestamp: HH:MM:SS,mmm
 */
function toSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec - Math.floor(sec)) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

/**
 * Generate SRT subtitle file from transcript segments (fallback).
 */
export function generateSrt(segments: TranscriptSegment[], outputPath: string): void {
  const events = splitSegments(segments, 9)
  const trimmed = trimOverlaps(events)

  const lines = trimmed.map((e, i) =>
    `${i + 1}\n${toSrtTime(e.start)} --> ${toSrtTime(e.end)}\n${e.text}\n`
  )
  writeFileSync(outputPath, lines.join('\n'), 'utf-8')
  logger.info(`SRT subtitle generated: ${outputPath} (${trimmed.length} entries)`)
}

/**
 * Format seconds to ASS timestamp: H:MM:SS.CC (centiseconds)
 */
function toAssTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const cs = Math.floor((s - Math.floor(s)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export interface AssOptions {
  /** Video width (default 1920) */
  width?: number
  /** Video height (default 1080) */
  height?: number
}

/**
 * Generate ASS subtitle file with adaptive styling.
 * Uses video resolution to calculate font sizes that look correct
 * in both portrait and landscape orientations.
 */
export function generateAss(
  segments: TranscriptSegment[],
  outputPath: string,
  options?: AssOptions,
): void {
  const w = options?.width || 1920
  const h = options?.height || 1080
  const isPortrait = h > w

  // Adaptive font sizing:
  // - Landscape (1920x1080): fontSize ~72, outline 4, marginV 60
  // - Portrait (1080x1920): fontSize ~56 (narrower, so smaller font), marginV 120
  let fontSize: number
  let outline: number
  let shadow: number
  let marginV: number
  let marginLR: number

  if (isPortrait) {
    fontSize = Math.round(w * 0.052)  // ~56 for 1080w
    outline = Math.max(2, Math.round(fontSize / 16))
    shadow = Math.max(1, Math.round(fontSize / 28))
    marginV = Math.round(h * 0.06)    // ~115 for 1920h
    marginLR = Math.round(w * 0.04)   // ~43 for 1080w
  } else {
    fontSize = Math.round(h * 0.067)  // ~72 for 1080h
    outline = Math.max(2, Math.round(fontSize / 16))
    shadow = Math.max(1, Math.round(fontSize / 28))
    marginV = Math.round(h * 0.055)   // ~60 for 1080h
    marginLR = Math.round(w * 0.025)  // ~48 for 1920w
  }

  // Clamp to reasonable range
  fontSize = Math.max(36, Math.min(120, fontSize))
  outline = Math.max(2, Math.min(6, outline))

  // Split long segments for display
  const maxChars = isPortrait ? 7 : 12
  const events = splitSegments(segments, maxChars)
  const trimmed = trimOverlaps(events)

  logger.info(`ASS style: ${w}x${h} ${isPortrait ? 'portrait' : 'landscape'}, fontSize=${fontSize}, outline=${outline}, marginV=${marginV}, chars/line=${maxChars}, segments=${trimmed.length}`)

  const header = `[Script Info]
Title: LiveClipAI Subtitle
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,PingFang SC,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,${outline},${shadow},2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const lines = trimmed.map(e =>
    `Dialogue: 0,${toAssTime(e.start)},${toAssTime(e.end)},Default,,0,0,0,,${escapeAss(e.text)}`
  )

  const content = header + '\n' + lines.join('\n') + '\n'
  writeFileSync(outputPath, content, 'utf-8')
  logger.info(`ASS subtitle generated: ${outputPath} (${lines.length} lines)`)
  // Log first and last few entries for debugging
  if (lines.length > 0) {
    const preview = lines.slice(0, 3).concat(lines.length > 3 ? ['...', ...lines.slice(-2)] : [])
    logger.info(`ASS preview:\n${preview.join('\n')}`)
  }
}

/**
 * Align transcript segments to actual speech boundaries detected by VAD.
 * This fixes the common problem where whisper timestamps drift from actual audio:
 * - Subtitle appears 0.5~1s before speech starts
 * - Subtitle lingers during silence after speech ends
 *
 * Algorithm:
 * 1. For each whisper segment, find the overlapping speech region(s)
 * 2. Snap segment start to the nearest speech-start boundary
 * 3. Snap segment end to the nearest speech-end boundary
 * 4. Ensure minimum duration and no overlap between segments
 */
export function alignToSpeech(
  segments: TranscriptSegment[],
  speechRegions: Array<{ start: number; end: number }>,
): TranscriptSegment[] {
  if (speechRegions.length === 0 || segments.length === 0) return segments

  const aligned: TranscriptSegment[] = []
  let dropped = 0

  for (const seg of segments) {
    // Find the speech region(s) that overlap with this segment
    const overlapping = speechRegions.filter(
      r => r.end > seg.start - 0.5 && r.start < seg.end + 0.5
    )

    if (overlapping.length === 0) {
      // No speech detected near this segment — this is almost certainly
      // a whisper hallucination during silence/music/game sounds. Drop it.
      dropped++
      continue
    }

    // Find the best-matching speech region (most overlap)
    let bestRegion = overlapping[0]
    let bestOverlap = 0
    for (const r of overlapping) {
      const overlapStart = Math.max(seg.start, r.start)
      const overlapEnd = Math.min(seg.end, r.end)
      const overlap = Math.max(0, overlapEnd - overlapStart)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestRegion = r
      }
    }

    // Snap start: use the later of (speech start, segment start - tolerance)
    // This prevents subtitle from appearing during silence before speech
    let newStart = seg.start
    if (bestRegion.start > seg.start - 0.15 && bestRegion.start < seg.start + 0.8) {
      // Speech starts near segment start — snap to speech start
      newStart = bestRegion.start
    }

    // Snap end: use the earlier of (speech end, segment end + tolerance)
    // This prevents subtitle from lingering during silence after speech
    let newEnd = seg.end
    if (bestRegion.end > seg.end - 0.8 && bestRegion.end < seg.end + 0.15) {
      // Speech ends near segment end — snap to speech end
      newEnd = bestRegion.end
    }

    // For segments that start in silence and speech starts later,
    // delay the subtitle to match speech onset
    if (newStart < bestRegion.start && bestRegion.start - newStart > 0.2) {
      newStart = bestRegion.start
    }

    // For segments that end after speech, trim to speech end
    if (newEnd > bestRegion.end && newEnd - bestRegion.end > 0.2) {
      newEnd = bestRegion.end
    }

    // Ensure minimum duration
    if (newEnd - newStart < 0.3) {
      newEnd = newStart + Math.max(0.3, seg.end - seg.start)
    }

    aligned.push({ start: newStart, end: newEnd, text: seg.text })
  }

  if (dropped > 0) {
    logger.info(`alignToSpeech: dropped ${dropped}/${segments.length} segments (no matching speech region, likely hallucinations)`)
  }

  // Final pass: fix any overlaps introduced by alignment
  return trimOverlaps(aligned)
}

/**
 * Trim overlaps and ensure minimum display duration between segments.
 */
function trimOverlaps(events: TranscriptSegment[]): TranscriptSegment[] {
  const result: TranscriptSegment[] = []

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    let end = e.end

    if (i < events.length - 1) {
      const gap = events[i + 1].start - e.end
      if (gap < 0) {
        // Overlapping — trim this one to prevent overlap
        end = events[i + 1].start - 0.02
      }
      // If gap > 0.3s, subtitle naturally disappears during silence
    }

    // Ensure minimum display duration
    if (end - e.start < 0.25) {
      end = e.start + 0.25
    }

    result.push({ start: e.start, end, text: e.text })
  }

  return result
}

/**
 * Split long transcript segments into shorter display lines.
 * Each display event is at most maxChars characters, with proportionally split timing.
 */
function splitSegments(segments: TranscriptSegment[], maxChars: number): TranscriptSegment[] {
  const result: TranscriptSegment[] = []

  for (const seg of segments) {
    const text = seg.text.trim()
    if (!text) continue

    if (text.length <= maxChars) {
      result.push(seg)
      continue
    }

    // Split at punctuation or at maxChars boundary
    const chunks = splitTextAtBoundary(text, maxChars)
    const totalLen = text.length
    const segDuration = seg.end - seg.start

    let charOffset = 0
    for (const chunk of chunks) {
      const ratio = chunk.length / totalLen
      const chunkStart = seg.start + (charOffset / totalLen) * segDuration
      const chunkEnd = chunkStart + ratio * segDuration
      result.push({ start: chunkStart, end: chunkEnd, text: chunk })
      charOffset += chunk.length
    }
  }

  return result
}

function splitTextAtBoundary(text: string, maxLen: number): string[] {
  const result: string[] = []
  let remaining = text

  while (remaining.length > maxLen) {
    // Try to break at punctuation near maxLen
    let breakAt = -1
    const punct = /[，。？！、,!?；;：:]/
    for (let i = maxLen; i >= maxLen - 5 && i >= 1; i--) {
      if (punct.test(remaining[i - 1])) {
        breakAt = i
        break
      }
    }
    if (breakAt < 0) breakAt = maxLen

    result.push(remaining.slice(0, breakAt).trim())
    remaining = remaining.slice(breakAt).trim()
  }

  if (remaining) result.push(remaining)
  return result
}

function escapeAss(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
}
