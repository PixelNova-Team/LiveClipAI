/**
 * Volcengine (火山引擎) ASR provider — 音视频字幕生成 API.
 * Same speech engine as CapCut/剪映, returns word-level timestamps.
 *
 * API docs: https://www.volcengine.com/docs/6561/80909
 *
 * Uses the Caption API (async submit → query result):
 *   Submit: POST https://openspeech.bytedance.com/api/v1/vc/submit?appid={appid}&language=zh-CN
 *   Query:  GET  https://openspeech.bytedance.com/api/v1/vc/query?appid={appid}&id={id}
 *
 * Auth: Authorization: Bearer;{access_token}  (note: semicolon, not space)
 */

import { readFileSync } from 'fs'
import { getLogger } from '../utils/logger'
import axios from 'axios'
import type { AsrProvider, AsrSegment } from './types'

const logger = getLogger('asr:volcengine')

const VOLCENGINE_BASE = 'https://openspeech.bytedance.com/api/v1/vc'

export class VolcengineProvider implements AsrProvider {
  readonly name = 'volcengine' as const
  readonly label = '火山引擎 ASR (剪映同款)'
  private appId: string
  private accessToken: string

  constructor(config: { app_id: string; access_token: string }) {
    this.appId = config.app_id
    this.accessToken = config.access_token
  }

  isReady(): boolean {
    return !!(this.appId && this.accessToken)
  }

  async transcribe(audioPath: string, language?: string): Promise<AsrSegment[]> {
    logger.info(`Transcribing ${audioPath} via Volcengine Caption API`)

    // Detect content type from extension
    const ext = audioPath.toLowerCase()
    const contentType = ext.endsWith('.mp3') ? 'audio/mpeg'
      : ext.endsWith('.ogg') ? 'audio/ogg'
      : ext.endsWith('.flac') ? 'audio/flac'
      : ext.endsWith('.mp4') ? 'video/mp4'
      : 'audio/wav'

    // Step 1: Submit audio
    const audioData = readFileSync(audioPath)
    const lang = language || 'zh-CN'
    const jobId = await this.submitAudio(audioData, contentType, lang)
    logger.info(`Caption job submitted: ${jobId}`)

    // Step 2: Poll for result
    return await this.pollResult(jobId)
  }

  private async submitAudio(audioData: Buffer, contentType: string, language: string): Promise<string> {
    logger.info(`Submitting ${(audioData.length / 1024).toFixed(0)}KB audio (${contentType}, lang=${language})`)

    // Build submit URL with required query parameters
    const submitUrl = `${VOLCENGINE_BASE}/submit?appid=${this.appId}&language=${language}&use_itn=True&use_punc=True&max_lines=1&words_per_line=15`

    let resp: any
    try {
      resp = await axios.post(submitUrl, audioData, {
        headers: {
          'Authorization': `Bearer;${this.accessToken}`,
          'Content-Type': contentType,
        },
        timeout: 60000,
        maxBodyLength: 500 * 1024 * 1024,
      })
    } catch (e: any) {
      const status = e?.response?.status
      const respBody = e?.response?.data
      logger.error(`Volcengine submit error: HTTP ${status}, body=${JSON.stringify(respBody).slice(0, 500)}`)
      if (status === 403) {
        throw new Error(
          `火山引擎认证失败 (HTTP 403)。请检查：\n` +
          `1. Access Token 是否正确\n` +
          `2. 是否已在火山引擎控制台开通"音视频字幕生成"服务`
        )
      }
      if (status === 400) {
        const msg = respBody?.message || JSON.stringify(respBody).slice(0, 200)
        throw new Error(
          `火山引擎请求格式错误 (HTTP 400): ${msg}\n` +
          `请检查 App ID 是否正确`
        )
      }
      throw new Error(`Volcengine submit failed (HTTP ${status || 'unknown'}): ${e.message}`)
    }

    const data = resp.data
    logger.info(`Submit response: ${JSON.stringify(data).slice(0, 300)}`)

    // Response: { id: "xxx", code: "0", message: "Success" }
    // Note: code may be string "0", not number 0
    const jobId = data?.id || data?.job_id
    if (!jobId) {
      if (data?.message) {
        throw new Error(`Volcengine submit error: ${data.message}`)
      }
      throw new Error(`Volcengine submit: no job ID in response: ${JSON.stringify(data).slice(0, 300)}`)
    }

    return jobId
  }

  private async pollResult(jobId: string, maxWaitMs: number = 120000): Promise<AsrSegment[]> {
    const startTime = Date.now()
    let pollInterval = 1000

    // Query URL: GET with appid and id as query params
    // blocking=0 for non-blocking poll
    const queryUrl = `${VOLCENGINE_BASE}/query?appid=${this.appId}&id=${jobId}&blocking=0`

    while (Date.now() - startTime < maxWaitMs) {
      await sleep(pollInterval)
      pollInterval = Math.min(pollInterval * 1.5, 5000)

      let resp: any
      try {
        resp = await axios.get(queryUrl, {
          headers: {
            'Authorization': `Bearer;${this.accessToken}`,
          },
          timeout: 15000,
        })
      } catch (e: any) {
        logger.warn(`Poll error: ${e.message}`)
        continue
      }

      const data = resp.data
      logger.debug(`Poll ${jobId}: ${JSON.stringify(data).slice(0, 300)}`)

      // Check completion: code === 0 or code === "0"
      // eslint-disable-next-line eqeqeq
      if (data?.code == 0) {
        logger.info(`Job ${jobId} completed`)
        return this.parseResult(data)
      }

      // Check for explicit error (negative code)
      const code = Number(data?.code)
      if (!isNaN(code) && code < 0) {
        throw new Error(`Volcengine job failed: code=${data.code}, message=${data.message || ''}`)
      }

      // Still processing — keep polling
    }

    throw new Error(`Volcengine job ${jobId} timed out after ${maxWaitMs}ms`)
  }

  private parseResult(json: any): AsrSegment[] {
    const segments: AsrSegment[] = []

    try {
      // Response structure: { utterances: [{ text, start_time, end_time, words: [...] }] }
      const utterances = json?.utterances || []

      for (const utt of utterances) {
        const seg: AsrSegment = {
          start: (utt.start_time ?? 0) / 1000,
          end: (utt.end_time ?? 0) / 1000,
          text: utt.text || '',
        }

        if (utt.words?.length) {
          seg.words = utt.words.map((w: any) => ({
            start: (w.start_time ?? 0) / 1000,
            end: (w.end_time ?? 0) / 1000,
            text: w.text || w.word || '',
          }))
        }

        if (seg.text.trim()) segments.push(seg)
      }

      if (segments.length === 0) {
        const text = json?.text || ''
        if (text) segments.push({ start: 0, end: 0, text })
      }
    } catch (e: any) {
      logger.error(`Parse error: ${e.message}`)
      logger.debug(`Raw response: ${JSON.stringify(json).slice(0, 1000)}`)
    }

    logger.info(`Volcengine: parsed ${segments.length} segments`)
    return segments
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
