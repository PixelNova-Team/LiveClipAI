import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdirSync, existsSync, unlinkSync, copyFileSync } from 'fs'
import { sliceVideo, extractAudio, extractCover, overlayTextOnCover, hasSubtitlesFilter, getVideoResolution, detectSpeechSegments, extractTsSegment, burnSubtitles } from './ffmpeg'
import { renderCoverWithText } from './cover-renderer'
import { getDb } from './db'
import { getConfig } from './config'
import { generateSliceContent, selectBestCover, isAiConfigured, isWhisperConfigured, optimizeSliceBoundary } from './ai-client'
import { transcribeAudio as asrTranscribe, isAsrAvailable } from './asr'
import { generateAss, alignToSpeech } from './subtitle'
import type { SliceContext } from './ai-client'
import { getLogger } from './utils/logger'
import { pushNotification } from './notification-service'
import { mt } from './i18n'
import type { BurstEvent } from './burst-detector'
import type { DanmakuMessage } from './plugins/danmaku/types'

const logger = getLogger('slice-worker')

export interface SliceResult {
  sliceId: string
  taskId: string
  startTime: number
  endTime: number
  duration: number
  slicePath: string
  coverPath: string
  title: string
  description: string
  tags: string[]
  aiApproved: boolean | null
  aiReviewReason: string
}

export interface SliceOptions {
  preBuffer?: number
  postBuffer?: number
  headers?: Record<string, string>
  /** Danmaku messages collected during the burst window (for AI context) */
  burstDanmaku?: DanmakuMessage[]
  /** Live room title for AI context */
  liveTitle?: string
  /** How many seconds the recording has been running */
  recordingElapsed?: number
}

export async function cutSlice(
  taskId: string,
  segmentPath: string,
  burst: BurstEvent,
  outputDir: string,
  options: SliceOptions = {},
): Promise<SliceResult | null> {
  const { preBuffer = 5, postBuffer = 3, headers, burstDanmaku = [] } = options
  const sliceId = randomUUID()
  const sliceDir = join(outputDir, taskId)
  if (!existsSync(sliceDir)) mkdirSync(sliceDir, { recursive: true })

  const config = getConfig()
  const minDuration = config.slice.min_duration || 10
  const maxDuration = config.slice.max_duration || 120
  logger.info(`Slice config: minDuration=${minDuration}s, maxDuration=${maxDuration}s, recElapsed=${options.recordingElapsed || 'not provided'}s`)
  logger.info(`Burst event: ${burst.startTime.toFixed(1)}s ~ ${burst.endTime.toFixed(1)}s (${(burst.endTime - burst.startTime).toFixed(1)}s), peak=${burst.peakScore.toFixed(2)}`)

  // --- Determine slice boundaries ---
  let startTime: number
  let endTime: number

  // Try AI-driven boundary optimization for content completeness
  logger.info(`[Step 0/7] AI boundary optimization...`)
  const boundaryStart = Date.now()
  const aiBoundary = await optimizeSliceBoundary(
    burst,
    burstDanmaku.map(m => ({ text: m.text, userName: m.userName, timestamp: m.timestamp, type: m.type })),
    {
      minDuration,
      maxDuration,
      preBuffer,
      postBuffer,
      liveTitle: options.liveTitle || '',
      recordingElapsed: options.recordingElapsed || burst.endTime + 60,
    },
  )

  logger.info(`[Step 0/7] AI boundary done in ${((Date.now() - boundaryStart) / 1000).toFixed(1)}s`)
  if (aiBoundary) {
    startTime = aiBoundary.startOffset
    endTime = aiBoundary.endOffset
    logger.info(`Using AI-optimized boundaries: ${startTime.toFixed(1)}s ~ ${endTime.toFixed(1)}s — ${aiBoundary.reason}`)
  } else {
    // Fallback: use burst window + buffers with min/max enforcement
    startTime = Math.max(0, burst.startTime - preBuffer)
    endTime = burst.endTime + postBuffer
  }

  // Final min/max duration enforcement (applies to both AI and fallback paths)
  const recElapsed = (options.recordingElapsed != null && options.recordingElapsed > 0) ? options.recordingElapsed : endTime + 60
  let dur = endTime - startTime
  if (dur < minDuration) {
    const deficit = minDuration - dur
    startTime = Math.max(0, startTime - Math.floor(deficit / 2))
    endTime = startTime + minDuration
    if (endTime > recElapsed) {
      endTime = recElapsed
      startTime = Math.max(0, endTime - minDuration)
    }
    logger.info(`Duration ${dur.toFixed(1)}s < min ${minDuration}s, expanded to ${startTime.toFixed(1)}s ~ ${endTime.toFixed(1)}s`)
  }
  if (endTime - startTime > maxDuration) {
    // Keep centered on burst peak
    const center = (burst.startTime + burst.endTime) / 2
    startTime = Math.max(0, center - maxDuration / 2)
    endTime = startTime + maxDuration
    logger.info(`Duration exceeded max ${maxDuration}s, trimmed to ${startTime.toFixed(1)}s ~ ${endTime.toFixed(1)}s`)
  }
  const finalDuration = endTime - startTime
  if (finalDuration < minDuration) {
    logger.warn(
      `Final duration ${finalDuration.toFixed(1)}s is BELOW min_duration ${minDuration}s — ` +
      `recording only ${recElapsed.toFixed(1)}s available. Cannot produce ${minDuration}s slice from ${recElapsed.toFixed(1)}s recording.`
    )
  }
  logger.info(`Final slice boundaries: ${startTime.toFixed(1)}s ~ ${endTime.toFixed(1)}s (${finalDuration.toFixed(1)}s)`)

  const duration = endTime - startTime

  const shortId = sliceId.slice(0, 8)
  const slicePath = join(sliceDir, `slice_${shortId}.mp4`)

  // Declare outside try so finally can access them (let is block-scoped)
  const isLiveTs = segmentPath.endsWith('.ts')
  let sharedSegmentPath = segmentPath
  let adjustedStart = startTime
  let adjustedEnd = endTime

  try {
    const stepTimer = () => {
      const s = Date.now()
      return () => ((Date.now() - s) / 1000).toFixed(1) + 's'
    }

    // Pre-extract a shared temp segment from live .ts files so that
    // BOTH audio extraction and video slicing operate on the exact same data.
    // Without this, two separate extractTsSegment calls on a growing .ts file
    // can produce different keyframe-aligned content → audio/subtitle/video desync.
    if (isLiveTs) {
      const grabStart = Math.max(0, startTime - 10)
      const grabDuration = duration + 15
      sharedSegmentPath = join(sliceDir, `_shared_seg_${shortId}.mpegts`)
      logger.info(`Extracting shared segment: ${grabStart.toFixed(0)}s~${(grabStart + grabDuration).toFixed(0)}s via stream copy`)
      try {
        await extractTsSegment(segmentPath, sharedSegmentPath, grabStart, grabDuration)
        adjustedStart = startTime - grabStart
        adjustedEnd = adjustedStart + duration
        logger.info(`Shared segment ready, adjusted times: ${adjustedStart.toFixed(1)}s~${adjustedEnd.toFixed(1)}s`)
      } catch (e: any) {
        logger.warn(`Shared segment extraction failed, falling back to direct reads: ${e.message}`)
        sharedSegmentPath = segmentPath
        adjustedStart = startTime
        adjustedEnd = endTime
      }
    }

    // 1. Extract cover candidates from shared segment BEFORE any encoding
    //    Uses danmaku density peaks for frame selection (ChopperBot-inspired)
    logger.info(`[Step 1/7] Extracting cover candidates (from source, no subtitles)`)
    const t1 = stepTimer()
    const coverTimestampsRel = computeCoverTimestamps(duration, startTime, burstDanmaku)
    const coverTimestampsAbs = coverTimestampsRel.map(t => t + adjustedStart)
    const { coverPath: rawCoverPath, candidatePaths: coverCandidates } = await extractCoverCandidates(
      sharedSegmentPath, sliceDir, shortId, duration, coverTimestampsAbs,
    )
    logger.info(`[Step 1/7] Covers extracted in ${t1()}: ${coverCandidates.length} candidates`)

    // 2. Detect video resolution for adaptive subtitle sizing
    const videoRes = await getVideoResolution(sharedSegmentPath)
    if (videoRes) {
      logger.info(`Video resolution: ${videoRes.width}x${videoRes.height} (${videoRes.height > videoRes.width ? 'portrait' : 'landscape'})`)
    }

    // 3. First-pass: slice video WITHOUT subtitles
    //    We extract audio FROM this sliced MP4 for whisper, guaranteeing that
    //    whisper timestamps are perfectly aligned with the video's audio track.
    //    (Previously we extracted audio separately from the mpegts shared segment,
    //    which caused subtitle-audio desync because mpegts input seeking behaves
    //    differently for audio-only vs video+audio extraction.)
    const outputResolution = config.slice?.resolution || ''
    // Use a temp slice path if we might burn subtitles (ASR available + ffmpeg has libass)
    const needSubtitleBurn = (isAsrAvailable() || isWhisperConfigured()) && hasSubtitlesFilter()
    const tempSlicePath = needSubtitleBurn ? join(sliceDir, `_temp_slice_${shortId}.mp4`) : slicePath
    logger.info(`[Step 2/7] Slicing video (pass 1, no subtitles): ${adjustedStart.toFixed(1)}s ~ ${adjustedEnd.toFixed(1)}s (${duration.toFixed(1)}s)${outputResolution ? `, output=${outputResolution}` : ''}`)
    const t2 = stepTimer()
    await sliceVideo(sharedSegmentPath, tempSlicePath, adjustedStart, adjustedEnd, headers, undefined, videoRes, outputResolution)
    logger.info(`[Step 2/7] Video sliced in ${t2()}`)

    // 4. Extract audio FROM the sliced MP4, run ASR, generate subtitles
    //    ASR always runs if available (produces ASS file for external use),
    //    subtitle burn-in only happens if ffmpeg has libass.
    let subtitlePath = ''
    let transcriptText = ''  // ASR transcript for AI content generation
    const audioPath = join(sliceDir, `_audio_${shortId}.wav`)
    const asrAvailable = isAsrAvailable() || isWhisperConfigured()
    const canBurnSubtitles = hasSubtitlesFilter()
    try {
      if (!asrAvailable) {
        logger.info('ASR not configured, skipping subtitles (configure in Settings > ASR)')
      } else {
        if (!canBurnSubtitles) {
          logger.info('ffmpeg lacks subtitles filter (no libass) — will still generate ASS file but cannot burn into video')
        }

        // Extract audio from the sliced MP4 — timestamps match the video perfectly
        logger.info(`[Step 3/7] Extracting audio from sliced MP4 for ASR`)
        const t3 = stepTimer()
        await extractAudio(tempSlicePath, audioPath)

        if (existsSync(audioPath)) {
          const audioSize = (require('fs').statSync(audioPath).size / 1024).toFixed(0)
          logger.info(`[Step 3/7] Audio extracted in ${t3()}: ${audioSize}KB`)

          // 4a. Run VAD (voice activity detection) to find actual speech boundaries
          logger.info(`[Step 3/7] Running speech detection (VAD)...`)
          const t3v = stepTimer()
          let speechRegions: Array<{ start: number; end: number }> = []
          try {
            speechRegions = await detectSpeechSegments(audioPath)
            logger.info(`[Step 3/7] VAD completed in ${t3v()}: ${speechRegions.length} speech regions`)
          } catch (e: any) {
            logger.warn(`VAD failed, will use raw ASR timestamps: ${e.message}`)
          }

          // 4b. Run ASR for text recognition
          logger.info(`[Step 3/7] Sending to ASR...`)
          const t3b = stepTimer()
          let segments = await asrTranscribe(audioPath)
          logger.info(`[Step 3/7] ASR completed in ${t3b()}: ${segments.length} segments`)

          // 4c. Align ASR timestamps to actual speech boundaries
          if (segments.length > 0 && speechRegions.length > 0) {
            const speechTotal = speechRegions.reduce((sum, r) => sum + (r.end - r.start), 0)
            const speechRatio = speechTotal / duration
            if (speechRatio > 0.8) {
              logger.info(`[Step 3/7] Speech covers ${(speechRatio * 100).toFixed(0)}% of audio — background too loud for VAD, skipping alignment`)
            } else {
              const beforeCount = segments.length
              logger.info(`[Step 3/7] Aligning ${segments.length} segments to ${speechRegions.length} speech regions (speech ${(speechRatio * 100).toFixed(0)}% of audio)`)
              segments = alignToSpeech(segments, speechRegions)
              logger.info(`[Step 3/7] After alignment: ${segments.length}/${beforeCount} segments kept`)
            }
            if (segments.length > 0) {
              const first = segments[0]
              const last = segments[segments.length - 1]
              logger.info(`[Step 3/7] Subtitle range: ${first.start.toFixed(1)}s~${first.end.toFixed(1)}s "${first.text.slice(0, 20)}" ... ${last.start.toFixed(1)}s~${last.end.toFixed(1)}s "${last.text.slice(0, 20)}"`)
            }
          }

          // Collect transcript text for AI content generation (regardless of subtitle burn-in)
          if (segments.length > 0) {
            transcriptText = segments.map(s => s.text).join('')
            logger.info(`Transcript collected: ${transcriptText.length} chars from ${segments.length} segments`)
          }

          if (segments.length > 0) {
            // Always generate ASS subtitle file (usable externally even without burn-in)
            subtitlePath = join(sliceDir, `_sub_${shortId}.ass`)
            generateAss(segments, subtitlePath, {
              width: videoRes?.width,
              height: videoRes?.height,
            })
            logger.info(`[Step 3/7] ASS subtitle file generated: ${subtitlePath}`)

            // Burn subtitles into video if ffmpeg supports it
            if (canBurnSubtitles) {
              logger.info(`[Step 4/7] Burning subtitles into video (pass 2, audio copy)`)
              const t4 = stepTimer()
              await burnSubtitles(tempSlicePath, slicePath, subtitlePath)
              logger.info(`[Step 4/7] Subtitles burned in ${t4()}`)
            } else {
              logger.info('[Step 4/7] Skipping subtitle burn-in (no libass), ASS file saved for external use')
              if (tempSlicePath !== slicePath) {
                require('fs').renameSync(tempSlicePath, slicePath)
              }
            }
          } else {
            logger.info('No speech segments survived — skipping subtitle generation')
            if (tempSlicePath !== slicePath) {
              require('fs').renameSync(tempSlicePath, slicePath)
            }
          }
        } else {
          logger.warn('Audio extraction produced no output file')
          if (tempSlicePath !== slicePath) {
            require('fs').renameSync(tempSlicePath, slicePath)
          }
        }
      }
    } catch (e: any) {
      logger.error(`Subtitle generation failed: ${e.message}`)
      pushNotification({
        type: 'error',
        title: mt('notify.subtitleFailed'),
        body: e.message,
        taskId,
      })
      // Ensure we have a video even if subtitle step failed
      if (tempSlicePath !== slicePath && existsSync(tempSlicePath) && !existsSync(slicePath)) {
        require('fs').renameSync(tempSlicePath, slicePath)
      }
    } finally {
      try { if (existsSync(audioPath)) unlinkSync(audioPath) } catch { /* ignore */ }
      // Keep subtitle file for debug download — do NOT delete subtitlePath
      // Clean up temp slice if final exists
      try { if (tempSlicePath !== slicePath && existsSync(tempSlicePath)) unlinkSync(tempSlicePath) } catch { /* ignore */ }
    }

    // 4. Get task info for context
    logger.info(`[Step 4/7] Loading task info and building context`)
    const db = getDb()
    const task = db.prepare('SELECT title, platform, author, config_json FROM tasks WHERE task_id = ?').get(taskId) as
      { title: string; platform: string; author: string; config_json: string } | undefined

    // Build AI context from burst danmaku
    const danmakuTexts = burstDanmaku
      .filter(m => m.type === 'chat')
      .map(m => m.text)
    const giftNames = burstDanmaku
      .filter(m => m.type === 'gift' || m.type === 'superchat')
      .map(m => m.giftName || m.text)

    // 5. Generate title, description, and cover text via AI (with video frames for visual context)
    const sliceCtx: SliceContext = {
      platform: task?.platform || '',
      streamerName: task?.author || '',
      liveTitle: task?.title || '',
      danmakuTexts,
      giftNames,
      clipDuration: duration,
      peakScore: burst.peakScore,
      framePaths: coverCandidates.length > 0 ? coverCandidates : undefined,
      transcript: transcriptText || undefined,
    }

    // Use AI to select best cover frame
    let coverPath = rawCoverPath
    if (isAiConfigured() && coverCandidates.length > 1) {
      try {
        logger.info(`[Step 5/7] AI selecting best cover from ${coverCandidates.length} candidates`)
        const t5b = stepTimer()
        const bestIdx = await selectBestCover(coverCandidates, sliceCtx)
        logger.info(`[Step 5/7] AI cover selected in ${t5b()}: #${bestIdx + 1}`)
        const finalCoverPath = join(sliceDir, `cover_${shortId}.jpg`)
        if (coverCandidates[bestIdx] !== finalCoverPath) {
          copyFileSync(coverCandidates[bestIdx], finalCoverPath)
        }
        coverPath = finalCoverPath
      } catch (e: any) {
        logger.warn(`AI cover selection failed, using middle frame: ${e.message}`)
      }
    } else {
      logger.info(`[Step 5/7] Skipping AI cover selection (ai=${isAiConfigured()}, candidates=${coverCandidates.length})`)
    }

    // Clean up candidate files (keep the selected cover)
    for (const p of coverCandidates) {
      try { if (p !== coverPath) unlinkSync(p) } catch { /* ignore */ }
    }

    logger.info(`[Step 6/7] Generating title and description via AI`)
    const t6 = stepTimer()
    const content = await generateSliceContent(sliceCtx)
    const { title, description, coverText, candidateTitles, tags } = content
    logger.info(`[Step 6/7] Content generated in ${t6()}: "${title}"`)


    // 6. Save to DB
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM slices WHERE task_id = ?').get(taskId) as { cnt: number }
    const seqNum = (countRow?.cnt || 0) + 1

    const finalTitle = title || mt('label.defaultSliceTitle', { num: seqNum })
    const finalCoverText = coverText || finalTitle.slice(0, 15)

    // 7. Overlay cover text on cover image (B-site style hook text)
    logger.info(`[Step 7/7] Overlaying cover text: "${finalCoverText}"`)
    const t7 = stepTimer()
    if (coverPath && existsSync(coverPath) && finalCoverText) {
      const textCoverPath = join(sliceDir, `cover_text_${shortId}.jpg`)
      let overlaid = await overlayTextOnCover(coverPath, textCoverPath, finalCoverText, { videoResolution: videoRes })
      if (!overlaid) {
        // Fallback: use Electron offscreen renderer (no freetype dependency)
        logger.info('ffmpeg drawtext unavailable, using Electron renderer for cover text')
        overlaid = await renderCoverWithText(coverPath, textCoverPath, finalCoverText, { videoResolution: videoRes })
      }
      if (overlaid && existsSync(textCoverPath)) {
        try { unlinkSync(coverPath) } catch { /* ignore */ }
        coverPath = textCoverPath
      }
    }
    logger.info(`[Step 7/7] Cover overlay done in ${t7()}`)

    db.prepare(`
      INSERT INTO slices (slice_id, task_id, start_time, end_time, duration, slice_path, cover_path, peak_score, selected_title, cover_text, description, candidate_titles_json, tags_json, subtitle_path, ai_approved, ai_review_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sliceId, taskId, startTime, endTime, duration, slicePath,
      coverPath, burst.peakScore, finalTitle, finalCoverText, description,
      JSON.stringify(candidateTitles), JSON.stringify(tags || []),
      subtitlePath || '',
      content.aiApproved != null ? (content.aiApproved ? 1 : 0) : null,
      content.aiReviewReason || '',
    )

    logger.info(`Slice created: ${sliceId} "${finalTitle}" (${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s)`)

    return { sliceId, taskId, startTime, endTime, duration, slicePath, coverPath, title: finalTitle, description, tags, aiApproved: content.aiApproved, aiReviewReason: content.aiReviewReason }
  } catch (e: any) {
    const errMsg = e?.message || e?.stderr || String(e)
    logger.error(`Failed to cut slice: ${errMsg}`)
    return null
  } finally {
    // Clean up shared temp segment
    if (sharedSegmentPath !== segmentPath && existsSync(sharedSegmentPath)) {
      try { unlinkSync(sharedSegmentPath) } catch { /* ignore */ }
    }
  }
}

/**
 * Compute candidate frame timestamps using danmaku density peaks.
 * Falls back to evenly-spaced timestamps if no danmaku data.
 */
function computeCoverTimestamps(
  duration: number,
  startTime: number,
  burstDanmaku: DanmakuMessage[],
): number[] {
  const chatMessages = burstDanmaku.filter(m => m.type === 'chat' && m.timestamp > 0)

  if (chatMessages.length >= 5) {
    // Use danmaku density to find peak moments (ChopperBot approach)
    // Convert absolute timestamps to relative offsets within the slice
    const offsets = chatMessages
      .map(m => m.timestamp / 1000 - startTime)
      .filter(t => t >= 0 && t <= duration)
      .sort((a, b) => a - b)

    if (offsets.length >= 3) {
      // Sliding window density: find top 3 density peaks
      const windowSize = Math.max(2, duration * 0.15) // 15% of clip duration
      const densityPeaks: { time: number; density: number }[] = []

      for (let t = 0; t <= duration; t += 0.5) {
        const count = offsets.filter(o => o >= t && o < t + windowSize).length
        densityPeaks.push({ time: t + windowSize / 2, density: count })
      }

      // Sort by density descending, pick top peaks with spacing
      densityPeaks.sort((a, b) => b.density - a.density)
      const selected: number[] = []
      const minSpacing = duration * 0.15

      for (const peak of densityPeaks) {
        if (selected.length >= 3) break
        if (peak.time < 0.5 || peak.time > duration - 0.5) continue
        if (selected.every(s => Math.abs(s - peak.time) >= minSpacing)) {
          selected.push(peak.time)
        }
      }

      // Always add a near-start and near-end frame for variety
      const timestamps = [
        Math.min(1, duration * 0.1),
        ...selected.sort((a, b) => a - b),
        Math.max(0, duration - 1),
      ]

      // Deduplicate (within 1s)
      const deduped: number[] = []
      for (const t of timestamps) {
        if (deduped.every(d => Math.abs(d - t) > 1)) {
          deduped.push(t)
        }
      }
      return deduped.filter(t => t >= 0 && t <= duration)
    }
  }

  // Fallback: evenly spaced
  return [
    Math.min(1, duration * 0.1),
    duration * 0.25,
    duration * 0.5,
    duration * 0.75,
    Math.max(0, duration - 1),
  ].filter(t => t >= 0 && t <= duration)
}

/**
 * Extract candidate cover frames from the sliced video.
 * Returns both the default cover path and all candidate paths for AI selection.
 */
async function extractCoverCandidates(
  slicePath: string,
  sliceDir: string,
  shortId: string,
  duration: number,
  timestamps: number[],
): Promise<{ coverPath: string; candidatePaths: string[] }> {
  const finalCoverPath = join(sliceDir, `cover_${shortId}.jpg`)
  const candidatePaths: string[] = []

  if (timestamps.length > 1) {
    for (let i = 0; i < timestamps.length; i++) {
      const candidatePath = join(sliceDir, `_cover_candidate_${shortId}_${i}.jpg`)
      try {
        await extractCover(slicePath, candidatePath, timestamps[i])
        if (existsSync(candidatePath)) {
          candidatePaths.push(candidatePath)
        }
      } catch {
        // Skip failed extractions
      }
    }

    if (candidatePaths.length > 0) {
      // Default: use middle frame
      const midIdx = Math.floor(candidatePaths.length / 2)
      copyFileSync(candidatePaths[midIdx], finalCoverPath)
    }
  }

  if (!existsSync(finalCoverPath)) {
    // Fallback: extract single frame from middle of clip
    try {
      await extractCover(slicePath, finalCoverPath, Math.min(duration / 2, 3))
    } catch (e) {
      logger.warn(`Cover extraction failed: ${e}`)
    }
  }

  return {
    coverPath: existsSync(finalCoverPath) ? finalCoverPath : '',
    candidatePaths,
  }
}
