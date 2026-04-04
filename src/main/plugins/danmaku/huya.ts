import WebSocket from 'ws'
import type { DanmakuCollector, DanmakuMessage, DanmakuCallback } from './types'
import type { PluginMetadata } from '../types/metadata'
import { getLogger } from '../../utils/logger'

const logger = getLogger('danmaku.huya')

export const HUYA_DANMAKU_METADATA = {
  label: '虎牙弹幕',
  label_en: 'Huya Danmaku',
  version: '3.0.0',
}

export const huyaDanmakuMetadata: PluginMetadata = {
  id: 'huya-danmaku',
  type: 'danmaku',
  name: 'huya',
  platform: 'huya',
  label: HUYA_DANMAKU_METADATA.label,
  label_en: HUYA_DANMAKU_METADATA.label_en,
  version: HUYA_DANMAKU_METADATA.version,
  description: 'Danmaku collector for Huya live streams',
  enabled: true,
}

// ======================= Tars Encoding =======================

function writeTag(tag: number, type: number): Buffer {
  if (tag < 15) return Buffer.from([((tag << 4) | type) & 0xff])
  return Buffer.from([0xf0 | type, tag & 0xff])
}

function tarsWriteInt32(tag: number, val: number): Buffer {
  if (val === 0) return writeTag(tag, 12)
  if (val >= -128 && val <= 127) return Buffer.concat([writeTag(tag, 0), Buffer.from([val & 0xff])])
  if (val >= -32768 && val <= 32767) { const b = Buffer.alloc(2); b.writeInt16BE(val); return Buffer.concat([writeTag(tag, 1), b]) }
  const b = Buffer.alloc(4); b.writeInt32BE(val); return Buffer.concat([writeTag(tag, 2), b])
}

function tarsWriteInt64(tag: number, val: string | number): Buffer {
  const n = BigInt(val)
  if (n === 0n) return writeTag(tag, 12)
  if (n >= -128n && n <= 127n) return Buffer.concat([writeTag(tag, 0), Buffer.from([Number(n) & 0xff])])
  if (n >= -32768n && n <= 32767n) { const b = Buffer.alloc(2); b.writeInt16BE(Number(n)); return Buffer.concat([writeTag(tag, 1), b]) }
  if (n >= -2147483648n && n <= 2147483647n) { const b = Buffer.alloc(4); b.writeInt32BE(Number(n)); return Buffer.concat([writeTag(tag, 2), b]) }
  const b = Buffer.alloc(8); b.writeBigInt64BE(n); return Buffer.concat([writeTag(tag, 3), b])
}

function tarsWriteString(tag: number, str: string): Buffer {
  const buf = Buffer.from(str, 'utf-8')
  if (buf.length < 256) return Buffer.concat([writeTag(tag, 6), Buffer.from([buf.length]), buf])
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(buf.length)
  return Buffer.concat([writeTag(tag, 7), lenBuf, buf])
}

function tarsWriteBytes(tag: number, data: Buffer): Buffer {
  // SimpleList: tag(type13) + element_head(type0) + tars_encoded_length + raw_bytes
  return Buffer.concat([writeTag(tag, 13), Buffer.from([0x00]), tarsWriteInt32(0, data.length), data])
}

// ======================= Tars Decoding =======================

function tarsReadHead(buf: Buffer, offset: number): { tag: number; type: number; offset: number } | null {
  if (offset >= buf.length) return null
  const b = buf[offset]
  const type = b & 0x0f
  let tag = (b >> 4) & 0x0f
  let newOffset = offset + 1
  if (tag === 15) { if (newOffset >= buf.length) return null; tag = buf[newOffset]; newOffset++ }
  return { tag, type, offset: newOffset }
}

function tarsReadInt32(buf: Buffer, offset: number, type: number): [number, number] {
  if (type === 12) return [0, offset]
  if (type === 0) return [buf.readInt8(offset), offset + 1]
  if (type === 1) return [buf.readInt16BE(offset), offset + 2]
  if (type === 2) return [buf.readInt32BE(offset), offset + 4]
  return [0, tarsSkipField(buf, offset, type)]
}

function tarsReadString(buf: Buffer, offset: number, type: number): [string, number] {
  if (type === 6) { if (offset >= buf.length) return ['', buf.length]; const len = buf[offset]; return [buf.slice(offset + 1, offset + 1 + len).toString('utf-8'), offset + 1 + len] }
  if (type === 7) { if (offset + 4 > buf.length) return ['', buf.length]; const len = buf.readUInt32BE(offset); return [buf.slice(offset + 4, offset + 4 + len).toString('utf-8'), offset + 4 + len] }
  return ['', tarsSkipField(buf, offset, type)]
}

function tarsReadBytes(buf: Buffer, offset: number, type: number): [Buffer, number] {
  if (type === 13) {
    offset++ // skip sub-head
    const h = tarsReadHead(buf, offset)
    if (!h) return [Buffer.alloc(0), buf.length]
    const [len, off] = tarsReadInt32(buf, h.offset, h.type)
    if (off + len > buf.length) return [Buffer.alloc(0), buf.length]
    return [buf.slice(off, off + len), off + len]
  }
  return [Buffer.alloc(0), tarsSkipField(buf, offset, type)]
}

function tarsSkipField(buf: Buffer, offset: number, type: number): number {
  switch (type) {
    case 0: return offset + 1
    case 1: return offset + 2
    case 2: return offset + 4
    case 3: return offset + 8
    case 4: return offset + 4
    case 5: return offset + 8
    case 6: return offset >= buf.length ? buf.length : offset + 1 + buf[offset]
    case 7: return offset + 4 > buf.length ? buf.length : offset + 4 + buf.readUInt32BE(offset)
    case 8: case 9: return buf.length
    case 10: {
      let o = offset
      while (o < buf.length) { const h = tarsReadHead(buf, o); if (!h || h.type === 11) return h ? h.offset : buf.length; o = tarsSkipField(buf, h.offset, h.type) }
      return o
    }
    case 11: return offset
    case 12: return offset
    case 13: {
      if (offset >= buf.length) return buf.length
      offset++
      const h = tarsReadHead(buf, offset)
      if (!h) return buf.length
      const [l, off] = tarsReadInt32(buf, h.offset, h.type)
      return off + l
    }
    default: return buf.length
  }
}

// Extract field from Tars struct by tag
function tarsGetField(buf: Buffer, targetTag: number): { type: number; offset: number } | null {
  let offset = 0
  while (offset < buf.length) {
    const h = tarsReadHead(buf, offset)
    if (!h || h.type === 11) return null
    if (h.tag === targetTag) return { type: h.type, offset: h.offset }
    offset = tarsSkipField(buf, h.offset, h.type)
  }
  return null
}

// ======================= Protocol Messages =======================

function buildVerifyCookieReq(channelId: string, subChannelId: string): Buffer {
  const body = Buffer.concat([
    tarsWriteInt64(0, 0),
    tarsWriteString(1, 'webh5&1.0.0&websocket'),
    tarsWriteString(2, ''),
    tarsWriteString(3, ''),
    tarsWriteInt32(4, 1),  // bAutoRegisterUid = 1
    tarsWriteString(5, ''),
  ])
  return Buffer.concat([
    tarsWriteInt32(0, 10),  // iCmdType = VerifyCookieReq
    tarsWriteBytes(1, body),
    tarsWriteInt64(2, 0),
    tarsWriteString(3, ''),
  ])
}

function buildRegisterReq(channelId: string, subChannelId: string): Buffer {
  const userInfo = Buffer.concat([
    tarsWriteInt64(0, 0),
    tarsWriteInt32(1, 1),  // bAnonymous = true
    tarsWriteString(2, ''),
    tarsWriteString(3, ''),
    tarsWriteInt64(4, channelId),
    tarsWriteInt64(5, subChannelId),
    tarsWriteInt64(6, 0),
    tarsWriteInt64(7, 0),
    tarsWriteString(8, ''),
    tarsWriteString(9, 'webh5&1.0.0&websocket'),
  ])
  return Buffer.concat([
    tarsWriteInt32(0, 1),   // iCmdType = RegisterReq
    tarsWriteBytes(1, userInfo),
    tarsWriteInt64(2, 0),
    tarsWriteString(3, ''),
  ])
}

function buildHeartbeat(): Buffer {
  return Buffer.concat([
    tarsWriteInt32(0, 5),
    tarsWriteBytes(1, Buffer.alloc(0)),
    tarsWriteInt64(2, 0),
    tarsWriteString(3, ''),
  ])
}

// ======================= Room Info =======================

function fetchRoomInfo(slug: string): Promise<{ channelId: string; subChannelId: string }> {
  return new Promise((resolve, reject) => {
    const https = require('https')
    const zlib = require('zlib')
    https.get(`https://www.huya.com/${slug}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Encoding': 'gzip, deflate',
      },
    }, (res: any) => {
      let stream = res
      if (res.headers['content-encoding'] === 'gzip') stream = res.pipe(zlib.createGunzip())
      else if (res.headers['content-encoding'] === 'deflate') stream = res.pipe(zlib.createInflate())

      let html = ''
      stream.on('data', (chunk: string) => html += chunk)
      stream.on('end', () => {
        const chMatch = html.match(/"lChannelId"\s*:\s*"?(\d+)/)
        const subMatch = html.match(/"lSubChannelId"\s*:\s*"?(\d+)/)
        resolve({
          channelId: chMatch?.[1] || '0',
          subChannelId: subMatch?.[1] || '0',
        })
      })
      stream.on('error', reject)
    }).on('error', reject)
  })
}

// ======================= Collector =======================

export class HuyaDanmaku implements DanmakuCollector {
  readonly platform = 'huya'
  readonly label = HUYA_DANMAKU_METADATA.label
  readonly label_en = HUYA_DANMAKU_METADATA.label_en
  private callbacks: DanmakuCallback[] = []
  private _isConnected = false
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private seenKeys = new Set<string>()
  private seenCleanupTimer: ReturnType<typeof setInterval> | null = null

  get isConnected(): boolean { return this._isConnected }

  async connect(roomId: string): Promise<void> {
    logger.info(`Starting Huya danmaku for room ${roomId}`)

    // Extract slug from URL if needed
    let roomSlug = roomId
    if (/^https?:\/\//.test(roomId)) {
      const m = /huya\.com\/(\w+)/.exec(roomId)
      if (m) roomSlug = m[1]
    }

    // Fetch room channel IDs
    const roomInfo = await fetchRoomInfo(roomSlug)
    logger.info(`[Huya] Room ${roomSlug}: channelId=${roomInfo.channelId}, subChannelId=${roomInfo.subChannelId}`)

    if (roomInfo.channelId === '0') {
      throw new Error(`Cannot get Huya room info for ${roomSlug}`)
    }

    const ws = new WebSocket('wss://cdnws.api.huya.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Origin': 'https://www.huya.com',
      },
    })

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.terminate()
        reject(new Error('Huya WebSocket connection timeout'))
      }, 10000)

      ws.on('open', () => {
        clearTimeout(timeout)
        logger.info('[Huya] WebSocket connected')

        // Step 1: VerifyCookie (auto-register anonymous user)
        ws.send(buildVerifyCookieReq(roomInfo.channelId, roomInfo.subChannelId))
        // Step 2: Register for room
        ws.send(buildRegisterReq(roomInfo.channelId, roomInfo.subChannelId))
        logger.info('[Huya] Sent VerifyCookie + Register')

        // Heartbeat every 30s
        this.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(buildHeartbeat())
        }, 30000)

        this.seenCleanupTimer = setInterval(() => this.seenKeys.clear(), 60000)
        this._isConnected = true
        this.ws = ws
        resolve()
      })

      ws.on('message', (data: Buffer) => {
        try {
          this.handleMessage(Buffer.from(data))
        } catch (e: any) {
          logger.debug(`[Huya] Message parse error: ${e.message}`)
        }
      })

      ws.on('error', (err: any) => {
        clearTimeout(timeout)
        reject(new Error(`Huya WebSocket error: ${err.message}`))
      })

      ws.on('close', () => {
        this._isConnected = false
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
        logger.info('[Huya] WebSocket closed')
      })
    })
  }

  private handleMessage(buf: Buffer): void {
    // Parse WebSocketCommand: iCmdType(tag0), vData(tag1)
    const cmdField = tarsGetField(buf, 0)
    if (!cmdField) return
    const [iCmdType] = tarsReadInt32(buf, cmdField.offset, cmdField.type)

    const dataField = tarsGetField(buf, 1)
    if (!dataField) return
    const [vData] = tarsReadBytes(buf, dataField.offset, dataField.type)

    if (iCmdType === 7 && vData.length > 0) {
      // Push message — may contain multiple sub-messages
      this.parsePushMessages(vData)
    }
  }

  private parsePushMessages(vData: Buffer): void {
    // WSPushMessage: ePushType(0), iUri(1), sMsg(2)
    // A single vData may contain one push message.
    // But the message body (sMsg at tag2) can contain multiple Tars structs.
    const uriField = tarsGetField(vData, 1)
    const msgField = tarsGetField(vData, 2)
    if (!uriField || !msgField) return

    const [iUri] = tarsReadInt32(vData, uriField.offset, uriField.type)
    const [sMsg] = tarsReadBytes(vData, msgField.offset, msgField.type)
    if (sMsg.length === 0) return

    if (iUri === 1400) {
      // Chat message — tag3 contains the text
      this.parseChatMessage(sMsg)
    } else if (iUri === 6501) {
      // Gift/donation — tag6 has sender, tag20 has gift name
      this.parseGiftMessage(sMsg)
    }
  }

  private parseChatMessage(msg: Buffer): void {
    // Chat messages have the text at tag3 and sender info in a nested struct
    const textField = tarsGetField(msg, 3)
    if (!textField) return
    const [text] = tarsReadString(msg, textField.offset, textField.type)
    if (!text) return

    // Sender name: usually in a struct at tag0, with nick at tag2 inside
    let userName = ''
    const senderField = tarsGetField(msg, 0)
    if (senderField && senderField.type === 10) {
      // It's a struct — find nick (tag2) inside
      const nickField = tarsGetField(msg.slice(senderField.offset), 2)
      if (nickField) {
        const [nick] = tarsReadString(msg.slice(senderField.offset), nickField.offset, nickField.type)
        userName = nick
      }
    }

    this.emit(text, userName, 'chat', '')
  }

  private parseGiftMessage(msg: Buffer): void {
    // Gift: tag6 = sender nick, tag20 = gift name, tag5 = streamer
    const giftField = tarsGetField(msg, 20)
    const senderField = tarsGetField(msg, 6)

    let giftName = ''
    let userName = ''

    if (giftField) [giftName] = tarsReadString(msg, giftField.offset, giftField.type)
    if (senderField) [userName] = tarsReadString(msg, senderField.offset, senderField.type)

    if (giftName) {
      this.emit(giftName, userName, 'gift', giftName)
    }
  }

  private emit(text: string, userName: string, type: 'chat' | 'gift', giftName: string): void {
    const key = `${type}_${userName}_${text}`
    if (this.seenKeys.has(key)) return
    this.seenKeys.add(key)
    if (this.seenKeys.size > 5000) this.seenKeys.clear()

    const msg: DanmakuMessage = { text, userName, timestamp: Date.now(), type, giftName }
    for (const cb of this.callbacks) {
      try { cb(msg) } catch (e) { logger.error(`Callback error: ${e}`) }
    }
  }

  async disconnect(): Promise<void> {
    this._isConnected = false
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.seenCleanupTimer) { clearInterval(this.seenCleanupTimer); this.seenCleanupTimer = null }
    if (this.ws) { this.ws.close(); this.ws = null }
    this.seenKeys.clear()
    logger.info('Huya danmaku disconnected')
  }

  onMessage(cb: DanmakuCallback): void {
    this.callbacks.push(cb)
  }
}
