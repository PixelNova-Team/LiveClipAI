import axios from 'axios'
import { readFileSync, statSync, existsSync } from 'fs'
import { basename } from 'path'
import { session } from 'electron'
import type { PublisherPlugin, PublishOptions, PublishResult } from './types'
import type { PluginMetadata } from '../types/metadata'
import { loadCookies, saveCookies, cookiesToString } from '../../utils/cookies'
import { getLogger } from '../../utils/logger'
import { mt } from '../../i18n'

const logger = getLogger('publisher.bilibili')

// Metadata for plugin discovery
export const BILIBILI_PUBLISHER_METADATA = {
  label: 'B站',
  label_en: 'Bilibili',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const bilibiliPublisherMetadata: PluginMetadata = {
  id: 'publisher-bilibili',
  type: 'publisher',
  name: 'bilibili',
  platform: 'bilibili',
  label: BILIBILI_PUBLISHER_METADATA.label,
  label_en: BILIBILI_PUBLISHER_METADATA.label_en,
  version: BILIBILI_PUBLISHER_METADATA.version,
  description: 'Video publisher plugin for Bilibili',
  enabled: true,
}

function getCsrf(cookieStr: string): string {
  const m = /bili_jct=([^;]+)/.exec(cookieStr)
  return m ? m[1] : ''
}

export const bilibiliPublisher: PublisherPlugin = {
  name: 'bilibili',
  label: BILIBILI_PUBLISHER_METADATA.label,
  label_en: BILIBILI_PUBLISHER_METADATA.label_en,

  getLoginUrl(): string {
    return 'https://member.bilibili.com/platform/home'
  },

  async publish(opts: PublishOptions): Promise<PublishResult> {
    let cookies = loadCookies('bilibili')
    // If cookie file is empty, try to export from persistent session (login flow saves there)
    if (!cookies.length) {
      try {
        const ses = session.fromPartition('persist:platform-bilibili')
        const sesCookies = await ses.cookies.get({})
        if (sesCookies.length > 0) {
          cookies = sesCookies.map(c => ({
            name: c.name, value: c.value, domain: c.domain || '',
            path: c.path || '/', httpOnly: c.httpOnly, secure: c.secure,
            expirationDate: c.expirationDate,
          }))
          saveCookies('bilibili', cookies)
          logger.info(`Exported ${cookies.length} cookies from persistent session to file`)
        }
      } catch { /* ignore */ }
    }
    if (!cookies.length) return { success: false, error: mt('error.notLoggedIn', { platform: mt('platform.bilibili') }) }

    const cookieStr = cookiesToString(cookies)
    const csrf = getCsrf(cookieStr)
    if (!csrf) return { success: false, error: mt('error.csrfMissing', { platform: mt('platform.bilibili') }) }

    if (!existsSync(opts.videoPath)) {
      return { success: false, error: mt('error.videoNotFound', { path: opts.videoPath }) }
    }

    try {
      const fileSize = statSync(opts.videoPath).size
      const fileName = basename(opts.videoPath)
      const commonHeaders = { Cookie: cookieStr, Referer: 'https://member.bilibili.com/' }

      // 1. Pre-upload
      logger.info(`Bilibili pre-upload: ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`)
      const preResp = await axios.get('https://member.bilibili.com/preupload', {
        params: {
          name: fileName,
          size: fileSize,
          r: 'upos',
          profile: 'ugcupos/bup',
          ssl: '0',
          version: '2.14.0.0',
          build: '2140000',
          os: 'upos',
          upcdn: 'bldsa',
        },
        headers: commonHeaders,
        timeout: 15000,
      })

      const { upos_uri, auth, biz_id } = preResp.data
      const chunkSize = preResp.data.chunk_size || 4 * 1024 * 1024
      logger.info(`Bilibili preupload: upos_uri=${upos_uri}, auth=${auth?.slice(0, 30)}..., biz_id=${biz_id}, endpoint=${preResp.data.endpoint}`)
      if (!upos_uri || !auth) {
        return { success: false, error: mt('error.preuploadFailed', { platform: mt('platform.bilibili'), detail: JSON.stringify(preResp.data).slice(0, 300) }) }
      }

      let endpoint = preResp.data.endpoint || '//upos-cs-upcdnbldsa.bilivideo.com'
      // Ensure endpoint has proper protocol prefix
      if (endpoint.startsWith('//')) endpoint = `https:${endpoint}`
      else if (!endpoint.startsWith('http')) endpoint = `https://${endpoint}`
      // Remove trailing slash
      endpoint = endpoint.replace(/\/+$/, '')
      const uploadBase = `${endpoint}/${upos_uri.replace('upos://', '')}`

      // 2. Init upload session
      logger.info(`Bilibili init upload: ${uploadBase}`)
      const initResp = await axios.post(`${uploadBase}?uploads&output=json`, undefined, {
        headers: {
          'X-Upos-Auth': auth,
        },
        timeout: 15000,
      })
      logger.info(`Bilibili init upload response: ${JSON.stringify(initResp.data).slice(0, 200)}`)
      const uploadId = initResp.data.upload_id
      if (!uploadId) {
        return { success: false, error: mt('error.initUploadFailed', { platform: mt('platform.bilibili'), detail: JSON.stringify(initResp.data).slice(0, 200) }) }
      }

      // 3. Upload chunks
      const totalChunks = Math.ceil(fileSize / chunkSize)
      logger.info(`Bilibili uploading ${totalChunks} chunk(s)...`)

      const fileData = readFileSync(opts.videoPath)
      const eTags: string[] = []

      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize
        const end = Math.min(start + chunkSize, fileSize)
        const chunk = fileData.subarray(start, end)

        const params = new URLSearchParams({
          partNumber: String(i + 1),
          uploadId,
          chunk: String(i),
          chunks: String(totalChunks),
          size: String(end - start),
          start: String(start),
          end: String(end),
          total: String(fileSize),
        })

        const resp = await axios.put(`${uploadBase}?${params}`, chunk, {
          headers: { 'X-Upos-Auth': auth, 'Content-Type': 'application/octet-stream' },
          timeout: 300000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        })
        eTags.push(resp.headers['etag'] || `etag${i}`)

        if (totalChunks > 1) logger.info(`  chunk ${i + 1}/${totalChunks}`)
      }

      // 4. Complete upload
      logger.info('Bilibili completing upload...')
      const completeParams = new URLSearchParams({
        output: 'json',
        name: fileName,
        profile: 'ugcupos/bup',
        uploadId,
        biz_id: String(biz_id),
      })
      await axios.post(
        `${uploadBase}?${completeParams}`,
        { parts: eTags.map((tag, i) => ({ partNumber: i + 1, eTag: tag })) },
        { headers: { 'X-Upos-Auth': auth, 'Content-Type': 'application/json' }, timeout: 30000 },
      )

      // 5. Upload cover if provided
      let coverUrl = ''
      if (opts.coverPath && existsSync(opts.coverPath)) {
        try {
          coverUrl = await uploadCover(opts.coverPath, cookieStr, csrf)
          logger.info('Bilibili cover uploaded')
        } catch (e: any) {
          logger.warn(`Cover upload failed: ${e.message}`)
        }
      }

      // 6. Submit video
      const videoFilename = upos_uri.replace(/^upos:\/\/[^/]+\//, '').replace(/\.[^.]+$/, '')
      logger.info(`Bilibili submitting: "${opts.title}", filename=${videoFilename}, csrf=${csrf.slice(0, 8)}...`)

      // B站 CSRF 校验要求 csrf 同时出现在 query string 中（不能只放 JSON body）
      const submitResp = await axios.post(
        `https://member.bilibili.com/x/vu/web/add/v3?csrf=${csrf}`,
        {
          csrf,
          videos: [{ filename: videoFilename, title: 'P1', desc: '' }],
          title: opts.title.slice(0, 80),
          desc: opts.description || '',
          tag: (opts.tags?.length ? opts.tags.join(',') : '直播切片,精彩时刻').slice(0, 200),
          tid: 27,  // 综合 (variety) — safe default for live clips
          copyright: 1,
          source: '',
          cover: coverUrl,
          no_reprint: 0,
          dynamic: '',
        },
        { headers: { ...commonHeaders, 'Content-Type': 'application/json' }, timeout: 30000 },
      )

      if (submitResp.data.code === 0) {
        const bvid = submitResp.data.data?.bvid || ''
        const url = bvid ? `https://www.bilibili.com/video/${bvid}` : undefined
        logger.info(`Bilibili publish success: ${url || 'submitted'}`)
        return { success: true, publishUrl: url }
      }

      return { success: false, error: mt('error.submitFailed', { platform: mt('platform.bilibili'), code: submitResp.data.code, message: submitResp.data.message }) }
    } catch (e: any) {
      // Extract detailed error info — response may be XML (from object storage) or JSON
      let msg = e.message
      if (e.response?.data) {
        const respData = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)
        msg = `${e.response.status} ${respData.slice(0, 300)}`
      }
      logger.error(`Bilibili publish error: ${msg}`)
      return { success: false, error: mt('error.publishError', { platform: mt('platform.bilibili'), message: msg }) }
    }
  },
}

async function uploadCover(coverPath: string, cookieStr: string, csrf: string): Promise<string> {
  const FormData = (await import('form-data')).default
  const form = new FormData()
  form.append('file', readFileSync(coverPath), { filename: basename(coverPath) })
  form.append('csrf', csrf)

  const resp = await axios.post('https://member.bilibili.com/x/vu/web/cover/up', form, {
    headers: { ...form.getHeaders(), Cookie: cookieStr },
    timeout: 30000,
  })

  if (resp.data.code === 0 && resp.data.data?.url) return resp.data.data.url
  throw new Error(resp.data.message || 'unknown')
}
