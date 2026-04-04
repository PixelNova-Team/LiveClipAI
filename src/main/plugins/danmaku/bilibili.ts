import WebSocket from 'ws'
import { inflateSync } from 'zlib'
import axios from 'axios'
import type { DanmakuCollector, DanmakuMessage, DanmakuCallback } from './types'
import type { PluginMetadata } from '../types/metadata'
import { getLogger } from '../../utils/logger'
import { loadCookies, cookiesToString } from '../../utils/cookies'
import { mt } from '../../i18n'

const logger = getLogger('danmaku.bilibili')

// Metadata for plugin discovery
export const BILIBILI_DANMAKU_METADATA = {
  label: 'B站弹幕',
  label_en: 'Bilibili Danmaku',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const bilibiliDanmakuMetadata: PluginMetadata = {
  id: 'bilibili-danmaku',
  type: 'danmaku',
  name: 'bilibili',
  platform: 'bilibili',
  label: BILIBILI_DANMAKU_METADATA.label,
  label_en: BILIBILI_DANMAKU_METADATA.label_en,
  version: BILIBILI_DANMAKU_METADATA.version,
  description: 'Danmaku collector for Bilibili live streams',
  enabled: true,
}

// Use v1 API — the xlive/web-room endpoint requires wbi signature and returns -352
const DANMU_INFO_API = 'https://api.live.bilibili.com/room/v1/Danmu/getConf'

function encodePacket(body: string | Buffer, op: number): Buffer {
  const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body
  const headerLen = 16
  const totalLen = headerLen + bodyBuf.length
  const header = Buffer.alloc(headerLen)
  header.writeUInt32BE(totalLen, 0)
  header.writeUInt16BE(headerLen, 4)
  header.writeUInt16BE(1, 6)  // protocol version
  header.writeUInt32BE(op, 8)
  header.writeUInt32BE(1, 12) // sequence
  return Buffer.concat([header, bodyBuf])
}

function decodePackets(data: Buffer): Array<{ op: number; body: Buffer }> {
  const results: Array<{ op: number; body: Buffer }> = []
  let offset = 0
  while (offset + 16 <= data.length) {
    const totalLen = data.readUInt32BE(offset)
    const headerLen = data.readUInt16BE(offset + 4)
    const protover = data.readUInt16BE(offset + 6)
    const op = data.readUInt32BE(offset + 8)
    let body = data.subarray(offset + headerLen, offset + totalLen)

    if (protover === 2 && body.length > 0) {
      try {
        body = inflateSync(body)
        results.push(...decodePackets(body))
        offset += totalLen
        continue
      } catch { /* not compressed */ }
    }

    results.push({ op, body })
    offset += totalLen
  }
  return results
}

export class BilibiliDanmaku implements DanmakuCollector {
  readonly platform = 'bilibili'
  readonly label = BILIBILI_DANMAKU_METADATA.label
  readonly label_en = BILIBILI_DANMAKU_METADATA.label_en
  private callbacks: DanmakuCallback[] = []
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _isConnected = false

  get isConnected(): boolean { return this._isConnected }

  async connect(roomId: string): Promise<void> {
    // Clean up previous connection if reused
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this._isConnected = false
    // Don't clear callbacks here — they are registered via onMessage() BEFORE connect()

    logger.info(`Starting Bilibili danmaku for room ${roomId}`)

    // Use cookies if available (improves token quality and connection stability)
    const cookies = loadCookies('bilibili')
    const cookieStr = cookiesToString(cookies, 'bilibili.com')
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://live.bilibili.com/',
    }
    if (cookieStr) {
      headers['Cookie'] = cookieStr
      logger.info('Using bilibili cookies for danmaku auth')
    }

    // Extract uid from cookies for authenticated danmaku
    let uid = 0
    const uidCookie = cookies.find(c => c.name === 'DedeUserID')
    if (uidCookie?.value) {
      uid = parseInt(uidCookie.value) || 0
      logger.info(`Bilibili danmaku auth uid: ${uid}`)
    }

    // Fetch WS token and host via v1 API (doesn't require wbi signature)
    const resp = await axios.get(DANMU_INFO_API, {
      params: { room_id: roomId, platform: 'pc', player: 'web' },
      headers,
      timeout: 10000,
    })
    if (resp.data?.code !== 0) {
      logger.warn(`Danmu getConf failed: code=${resp.data?.code}, msg=${resp.data?.message}`)
    }
    const info = resp.data?.data
    const token = info?.token || ''
    // v1 API uses 'host_server_list' instead of 'host_list'
    const hostList = info?.host_server_list || info?.host_list || []
    const host = hostList.length > 0
      ? `wss://${hostList[0].host}:${hostList[0].wss_port}/sub`
      : 'wss://broadcastlv.chat.bilibili.com:443/sub'

    logger.info(`Bilibili danmaku WS host: ${host}, token: ${token ? token.slice(0, 8) + '...' : '(empty)'}`)

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(host)
      const timeout = setTimeout(() => { ws.close(); reject(new Error(mt('error.danmakuTimeout', { seconds: 10 }))) }, 10000)
      let authResolved = false

      ws.on('open', () => {
        // Auth packet — use real uid if cookies are available
        const auth = JSON.stringify({
          uid,
          roomid: parseInt(roomId),
          protover: 2,
          platform: 'web',
          type: 2,
          key: token,
        })
        ws.send(encodePacket(auth, 7))
        logger.info(`Bilibili danmaku auth packet sent (uid=${uid})`)
        // Don't resolve yet — wait for auth response (op=8)
      })

      ws.on('message', (raw: Buffer) => {
        const packets = decodePackets(raw)
        for (const { op, body } of packets) {
          // Auth response (op=8): server confirms connection
          if (op === 8 && !authResolved) {
            authResolved = true
            clearTimeout(timeout)
            this._isConnected = true
            this.ws = ws
            // Start heartbeat after auth success
            this.heartbeatTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(encodePacket('', 2))
              }
            }, 30000)
            logger.info('Bilibili danmaku auth confirmed, connected')
            resolve()
            continue
          }

          if (op !== 5) continue // Only notification packets
          try {
            const json = JSON.parse(body.toString('utf-8'))
            let msg: DanmakuMessage | null = null

            if (json.cmd === 'DANMU_MSG' && json.info) {
              msg = {
                text: json.info[1] || '',
                userName: json.info[2]?.[1] || '',
                timestamp: Date.now(),
                type: 'chat',
                giftName: '',
              }
            } else if (json.cmd === 'SEND_GIFT' && json.data) {
              const d = json.data
              msg = {
                text: d.giftName || mt('label.sentGift'),
                userName: d.uname || '',
                timestamp: Date.now(),
                type: 'gift',
                giftName: d.giftName || '',
              }
            } else if (json.cmd === 'SUPER_CHAT_MESSAGE' && json.data) {
              const d = json.data
              msg = {
                text: d.message || '',
                userName: d.user_info?.uname || '',
                timestamp: Date.now(),
                type: 'superchat',
                giftName: 'SuperChat',
              }
            } else if (json.cmd === 'COMBO_SEND' && json.data) {
              const d = json.data
              msg = {
                text: d.gift_name || mt('label.sentGift'),
                userName: d.uname || '',
                timestamp: Date.now(),
                type: 'gift',
                giftName: d.gift_name || '',
              }
            }

            if (msg) {
              for (const cb of this.callbacks) {
                try { cb(msg) } catch { /* ignore */ }
              }
            }
          } catch { /* ignore parse errors */ }
        }
      })

      ws.on('error', (err) => {
        logger.warn('Bilibili WS error:', err)
        if (!authResolved) {
          authResolved = true
          clearTimeout(timeout)
          reject(err)
        }
      })

      ws.on('close', () => {
        this._isConnected = false
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
        if (!authResolved) {
          authResolved = true
          clearTimeout(timeout)
          reject(new Error(mt('error.danmakuClosed', { platform: mt('platform.bilibili') })))
        }
      })
    })
  }

  async disconnect(): Promise<void> {
    this._isConnected = false
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.ws) { this.ws.close(); this.ws = null }
    logger.info('Bilibili danmaku disconnected')
  }

  onMessage(cb: DanmakuCallback): void {
    // Replace all callbacks (prevents accumulation across reconnects)
    this.callbacks = [cb]
  }
}
