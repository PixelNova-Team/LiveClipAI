/**
 * Alibaba DashScope Paraformer ASR provider.
 * Flow: upload audio to DashScope OSS → submit transcription task → poll → result.
 * Returns sentence + word level timestamps.
 *
 * API docs: https://help.aliyun.com/zh/model-studio/recording-file-recognition
 */

import { readFileSync } from 'fs'
import { basename } from 'path'
import axios from 'axios'
import FormData from 'form-data'
import { getLogger } from '../utils/logger'
import { httpPost, httpGet } from '../utils/http'
import type { AsrProvider, AsrSegment } from './types'

const logger = getLogger('asr:paraformer')

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1'

export class ParaformerProvider implements AsrProvider {
  readonly name = 'paraformer' as const
  readonly label = 'Paraformer (DashScope)'
  private apiKey: string
  private model: string

  constructor(config: { api_key: string; model?: string }) {
    this.apiKey = config.api_key
    this.model = config.model || 'paraformer-v2'
  }

  isReady(): boolean {
    return !!this.apiKey
  }

  async transcribe(audioPath: string, language?: string): Promise<AsrSegment[]> {
    logger.info(`Transcribing ${audioPath} with model=${this.model}`)

    // Step 1: Upload local file to DashScope OSS
    const ossUrl = await this.uploadToOss(audioPath)
    logger.info(`Uploaded to OSS: ${ossUrl}`)

    // Step 2: Submit transcription task
    const taskId = await this.submitTask(ossUrl, language)
    logger.info(`Task submitted: ${taskId}`)

    // Step 3: Poll for result
    return await this.pollResult(taskId)
  }

  /**
   * Upload a local audio file to DashScope's OSS storage.
   * Returns an oss:// URL that can be used in file_urls.
   */
  private async uploadToOss(audioPath: string): Promise<string> {
    const authHeaders = { 'Authorization': `Bearer ${this.apiKey}` }

    // Get upload policy
    const policy = await httpGet<any>(`${DASHSCOPE_BASE}/uploads`, {
      headers: authHeaders,
      params: { action: 'getPolicy', model: this.model },
      timeout: 15000,
    })

    if (!policy?.data?.upload_host) {
      throw new Error(`DashScope upload policy failed: ${JSON.stringify(policy).slice(0, 300)}`)
    }

    const {
      upload_host,
      upload_dir,
      oss_access_key_id,
      policy: ossPolicy,
      signature,
      x_oss_object_acl,
      x_oss_forbid_overwrite,
    } = policy.data

    // Upload to OSS via multipart form
    const filename = basename(audioPath)
    const key = `${upload_dir}/${filename}`
    const audioData = readFileSync(audioPath)

    const form = new FormData()
    form.append('OSSAccessKeyId', oss_access_key_id)
    form.append('policy', ossPolicy)
    form.append('Signature', signature)
    form.append('key', key)
    form.append('x-oss-object-acl', x_oss_object_acl || 'private')
    form.append('x-oss-forbid-overwrite', x_oss_forbid_overwrite || 'false')
    form.append('success_action_status', '200')
    form.append('file', audioData, { filename })

    const resp = await axios.post(upload_host, form, {
      headers: form.getHeaders(),
      timeout: 60000,
    })

    if (resp.status !== 200) {
      throw new Error(`OSS upload failed: status=${resp.status}`)
    }

    return `oss://${key}`
  }

  private async submitTask(fileUrl: string, language?: string): Promise<string> {
    const url = `${DASHSCOPE_BASE}/services/audio/asr/transcription`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'X-DashScope-Async': 'enable',
    }

    // Enable OSS URL resolution for oss:// URLs
    if (fileUrl.startsWith('oss://')) {
      headers['X-DashScope-OssResourceResolve'] = 'enable'
    }

    const json = await httpPost<any>(url, {
      model: this.model,
      input: { file_urls: [fileUrl] },
      parameters: {
        language_hints: language ? [language] : ['zh', 'en'],
      },
    }, { headers, timeout: 30000 })

    if (json.code) {
      throw new Error(`Paraformer submit failed: ${json.message || json.code}`)
    }

    const taskId = json.output?.task_id
    if (!taskId) {
      throw new Error(`Paraformer submit: no task_id — ${JSON.stringify(json).slice(0, 300)}`)
    }
    return taskId
  }

  private async pollResult(taskId: string, maxWaitMs: number = 120000): Promise<AsrSegment[]> {
    const url = `${DASHSCOPE_BASE}/tasks/${taskId}`
    const headers = { 'Authorization': `Bearer ${this.apiKey}` }
    const startTime = Date.now()
    let pollInterval = 1000

    while (Date.now() - startTime < maxWaitMs) {
      await sleep(pollInterval)
      pollInterval = Math.min(pollInterval * 1.5, 5000)

      const json = await httpGet<any>(url, { headers, timeout: 15000 })
      const status = json.output?.task_status

      if (status === 'SUCCEEDED') {
        logger.info(`Task ${taskId} completed`)
        return this.parseResult(json)
      } else if (status === 'FAILED') {
        throw new Error(`Paraformer task failed: ${json.output?.message || 'unknown'}`)
      }

      logger.debug(`Task ${taskId} status: ${status}`)
    }

    throw new Error(`Paraformer task ${taskId} timed out after ${maxWaitMs}ms`)
  }

  private async parseResult(json: any): Promise<AsrSegment[]> {
    const segments: AsrSegment[] = []

    try {
      const results = json.output?.results
      if (!results?.length) {
        logger.warn('Paraformer: no results in response')
        return []
      }

      for (const fileResult of results) {
        let transcription = fileResult.transcription

        // Fetch result from URL if needed
        if (!transcription && fileResult.transcription_url) {
          logger.info('Paraformer: fetching transcription_url...')
          try {
            transcription = await httpGet(fileResult.transcription_url, { timeout: 15000 })
          } catch (e: any) {
            logger.error(`Failed to fetch transcription_url: ${e.message}`)
            continue
          }
        }

        if (!transcription) continue

        const trans = typeof transcription === 'string' ? JSON.parse(transcription) : transcription

        const transcripts = trans.transcripts || [trans]
        for (const t of transcripts) {
          const sentences = t.sentences || []
          for (const sent of sentences) {
            const seg: AsrSegment = {
              start: (sent.begin_time ?? sent.start ?? 0) / 1000,
              end: (sent.end_time ?? sent.end ?? 0) / 1000,
              text: sent.text || '',
            }

            if (sent.words?.length) {
              seg.words = sent.words.map((w: any) => ({
                start: (w.begin_time ?? w.start ?? 0) / 1000,
                end: (w.end_time ?? w.end ?? 0) / 1000,
                text: w.text || w.word || '',
              }))
            }

            if (seg.text.trim()) segments.push(seg)
          }

          if (sentences.length === 0 && t.text) {
            segments.push({ start: 0, end: 0, text: t.text })
          }
        }
      }
    } catch (e: any) {
      logger.error(`Paraformer parse error: ${e.message}`)
      logger.debug(`Raw: ${JSON.stringify(json).slice(0, 1000)}`)
    }

    logger.info(`Paraformer: parsed ${segments.length} segments`)
    return segments
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
