import WebSocket from 'ws'
import type { DanmakuCollector, DanmakuMessage, DanmakuCallback } from './types'
import type { PluginMetadata } from '../types/metadata'
import { getLogger } from '../../utils/logger'
import { mt } from '../../i18n'

const logger = getLogger('danmaku.douyu')

// Metadata for plugin discovery
export const DOUYU_DANMAKU_METADATA = {
  label: '斗鱼弹幕',
  label_en: 'Douyu Danmaku',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const douyuDanmakuMetadata: PluginMetadata = {
  id: 'douyu-danmaku',
  type: 'danmaku',
  name: 'douyu',
  platform: 'douyu',
  label: DOUYU_DANMAKU_METADATA.label,
  label_en: DOUYU_DANMAKU_METADATA.label_en,
  version: DOUYU_DANMAKU_METADATA.version,
  description: 'Danmaku collector for Douyu live streams',
  enabled: true,
}

const WS_URLS = [
  'wss://danmuproxy.douyu.com:8501/',
  'wss://danmuproxy.douyu.com:8502/',
  'wss://openbarrage.douyutv.com:443/',
]

// STT (Serialized Text Transport) protocol helpers
function sttEncode(data: Record<string, string>): Buffer {
  const body = Object.entries(data).map(([k, v]) => `${k}@=${v}`).join('/') + '/\0'
  const bodyBuf = Buffer.from(body, 'utf-8')
  const len = bodyBuf.length + 8
  const header = Buffer.alloc(12)
  header.writeUInt32LE(len, 0)
  header.writeUInt32LE(len, 4)
  header.writeUInt16LE(689, 8)  // msg type
  header.writeUInt8(0, 10)
  header.writeUInt8(0, 11)
  return Buffer.concat([header, bodyBuf])
}

function sttDecode(data: Buffer): Record<string, string> {
  const text = data.toString('utf-8').replace(/\0/g, '')
  const result: Record<string, string> = {}
  for (const pair of text.split('/')) {
    const [key, value] = pair.split('@=')
    if (key && value !== undefined) {
      result[key] = value.replace(/@A/g, '@').replace(/@S/g, '/')
    }
  }
  return result
}

export class DouyuDanmaku implements DanmakuCollector {
  readonly platform = 'douyu'
  readonly label = DOUYU_DANMAKU_METADATA.label
  readonly label_en = DOUYU_DANMAKU_METADATA.label_en
  private callbacks: DanmakuCallback[] = []
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _isConnected = false
  private seenIds = new Set<string>()
  private seenCleanupTimer: ReturnType<typeof setInterval> | null = null

  get isConnected(): boolean { return this._isConnected }

  async connect(roomId: string): Promise<void> {
    logger.info(`Starting Douyu danmaku for room ${roomId}`)

    for (const wsUrl of WS_URLS) {
      try {
        await this.connectToWs(wsUrl, roomId)
        return
      } catch (e) {
        logger.warn(`Failed to connect to ${wsUrl}:`, e)
      }
    }
    logger.error('Failed to connect to any Douyu danmaku server')
  }

  private connectToWs(url: string, roomId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')) }, 10000)

      ws.on('open', () => {
        clearTimeout(timeout)
        ws.send(sttEncode({ type: 'loginreq', room_id: roomId }))
        ws.send(sttEncode({ type: 'joingroup', rid: roomId, gid: '-9999' }))

        this.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(sttEncode({ type: 'mrkl' }))
          }
        }, 45000)

        // Periodically clear old dedup entries to prevent memory growth
        this.seenCleanupTimer = setInterval(() => {
          this.seenIds.clear()
        }, 60000)

        this._isConnected = true
        this.ws = ws
        logger.info(`Douyu danmaku connected to ${url}`)
        resolve()
      })

      ws.on('message', (data: Buffer) => {
        try {
          // May contain multiple messages
          let offset = 0
          while (offset + 12 < data.length) {
            const msgLen = data.readUInt32LE(offset) - 8
            if (msgLen <= 0 || offset + 12 + msgLen > data.length) break
            const body = data.subarray(offset + 12, offset + 12 + msgLen)
            const parsed = sttDecode(body)
            if (parsed.type === 'chatmsg' && parsed.txt) {
              // Deduplicate: gid=-9999 joins all groups, same message arrives from multiple groups
              const dedupKey = parsed.cid || `${parsed.uid || parsed.nn}_${parsed.txt}`
              if (this.seenIds.has(dedupKey)) continue
              this.seenIds.add(dedupKey)

              const msg: DanmakuMessage = {
                text: parsed.txt,
                userName: parsed.nn || '',
                timestamp: Date.now(),
                type: 'chat',
                giftName: '',
              }
              for (const cb of this.callbacks) {
                try { cb(msg) } catch { /* ignore */ }
              }
            } else if (parsed.type === 'dgb') {
              const giftName = parsed.gn || ''
              const msg: DanmakuMessage = {
                text: giftName || mt('label.sentGift'),
                userName: parsed.nn || '',
                timestamp: Date.now(),
                type: 'gift',
                giftName,
              }
              for (const cb of this.callbacks) {
                try { cb(msg) } catch { /* ignore */ }
              }
            }
            offset += 12 + msgLen
          }
        } catch { /* ignore parse errors */ }
      })

      ws.on('error', (err) => {
        logger.warn('Douyu WS error:', err)
        clearTimeout(timeout)
        reject(err)
      })

      ws.on('close', () => {
        this._isConnected = false
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      })
    })
  }

  async disconnect(): Promise<void> {
    this._isConnected = false
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.seenCleanupTimer) { clearInterval(this.seenCleanupTimer); this.seenCleanupTimer = null }
    if (this.ws) { this.ws.close(); this.ws = null }
    this.seenIds.clear()
    logger.info('Douyu danmaku disconnected')
  }

  onMessage(cb: DanmakuCallback): void {
    this.callbacks.push(cb)
  }
}
