import { app, BrowserWindow, session } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DanmakuCollector, DanmakuMessage, DanmakuCallback } from './types'
import type { PluginMetadata } from '../types/metadata'
import { getLogger } from '../../utils/logger'
import { loadCookies } from '../../utils/cookies'

const logger = getLogger('danmaku.douyin')

// Metadata for plugin discovery
export const DOUYIN_DANMAKU_METADATA = {
  label: '抖音弹幕',
  label_en: 'Douyin Danmaku',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const douyinDanmakuMetadata: PluginMetadata = {
  id: 'douyin-danmaku',
  type: 'danmaku',
  name: 'douyin',
  platform: 'douyin',
  label: DOUYIN_DANMAKU_METADATA.label,
  label_en: DOUYIN_DANMAKU_METADATA.label_en,
  version: DOUYIN_DANMAKU_METADATA.version,
  description: 'Danmaku collector for Douyin live streams',
  enabled: true,
}

/**
 * Douyin danmaku collector using hidden BrowserWindow with preload script.
 *
 * Uses a preload script (contextIsolation=false) to hook WebSocket BEFORE
 * any page JavaScript runs, ensuring reliable interception of Douyin's
 * WebSocket-based danmaku stream.
 */
export class DouyinDanmaku implements DanmakuCollector {
  readonly platform = 'douyin'
  readonly label = DOUYIN_DANMAKU_METADATA.label
  readonly label_en = DOUYIN_DANMAKU_METADATA.label_en
  private callbacks: DanmakuCallback[] = []
  private _isConnected = false
  private _hasReceivedMessages = false
  private win: BrowserWindow | null = null
  private webRid = ''

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(roomId: string): Promise<void> {
    logger.info(`Starting Douyin danmaku for room ${roomId}`)
    this.webRid = roomId

    try {
      // Write interceptor as preload script — runs before ANY page JS
      const preloadPath = join(app.getPath('userData'), 'douyin-danmaku-preload.js')
      writeFileSync(preloadPath, this.getPreloadScript())
      logger.info(`Preload script written to ${preloadPath}`)

      this.win = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: {
          preload: preloadPath,
          nodeIntegration: false,
          contextIsolation: false,
          sandbox: false,
        },
      })

      // Listen for console messages from preload script
      this.win.webContents.on('console-message', (_event, _level, message) => {
        if (message.startsWith('__DANMAKU__:')) {
          try {
            const data = JSON.parse(message.slice('__DANMAKU__:'.length))
            const msg: DanmakuMessage = {
              text: data.content,
              userName: data.userName || '',
              timestamp: Date.now(),
              type: data.type || 'chat',
              giftName: data.giftName || '',
            }
            if (!this._hasReceivedMessages) {
              this._hasReceivedMessages = true
              logger.info('Douyin danmaku: first message received, connection confirmed')
            }
            for (const cb of this.callbacks) {
              try { cb(msg) } catch { /* ignore callback errors */ }
            }
          } catch (e: any) {
            logger.warn(`Failed to parse danmaku message: ${e.message}`)
          }
        } else if (message.startsWith('__DANMAKU_STATUS__:')) {
          const status = message.slice('__DANMAKU_STATUS__:'.length)
          logger.info(`Douyin danmaku status: ${status}`)
        } else if (message.startsWith('__DANMAKU_ERROR__:')) {
          const error = message.slice('__DANMAKU_ERROR__:'.length)
          logger.warn(`Douyin danmaku error: ${error}`)
        }
      })

      // Load saved cookies into the BrowserWindow session before navigating
      const savedCookies = loadCookies('douyin')
      if (savedCookies.length > 0) {
        const ses = this.win.webContents.session
        let loaded = 0
        for (const c of savedCookies) {
          try {
            await ses.cookies.set({
              url: `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || '/',
              httpOnly: c.httpOnly,
              secure: c.secure,
              expirationDate: c.expirationDate,
            })
            loaded++
          } catch { /* skip invalid cookies */ }
        }
        logger.info(`Loaded ${loaded}/${savedCookies.length} saved cookies into danmaku session`)
      } else {
        logger.warn('No saved Douyin cookies found — danmaku may not work without login')
      }

      // Load the live room page
      const liveUrl = `https://live.douyin.com/${roomId}`
      logger.info(`Loading Douyin live page: ${liveUrl}`)
      await this.win.loadURL(liveUrl)
      this._isConnected = true

      // Log page info for debugging
      const pageTitle = this.win.webContents.getTitle()
      const pageUrl = this.win.webContents.getURL()
      logger.info(`Douyin danmaku BrowserWindow loaded: title="${pageTitle}" url=${pageUrl}`)

      // Check if page redirected (login wall etc)
      if (!pageUrl.includes('live.douyin.com')) {
        logger.warn(`Douyin page redirected to: ${pageUrl} — may need login cookies`)
      }

    } catch (e: any) {
      logger.error(`Failed to create danmaku BrowserWindow: ${e.message}`)
      this._isConnected = false
    }
  }

  private getPreloadScript(): string {
    return `
// Douyin danmaku preload — runs before page scripts (contextIsolation=false)
(function() {
  if (window.__danmakuInterceptorInstalled) return;
  window.__danmakuInterceptorInstalled = true;

  console.log('__DANMAKU_STATUS__:preload_start_' + Date.now());

  const OrigWS = window.WebSocket;
  let wsCount = 0;
  let msgCount = 0;

  // Use Proxy to perfectly mimic native WebSocket constructor
  window.WebSocket = new Proxy(OrigWS, {
    construct(target, args) {
      const url = args[0] || '';
      wsCount++;
      console.log('__DANMAKU_STATUS__:ws_new_#' + wsCount + '_' + (typeof url === 'string' ? url.substring(0, 200) : 'non-string'));

      const ws = new target(...args);

      // Listen on ALL WebSocket connections for danmaku data
      if (typeof url === 'string' && (url.includes('webcast') || url.includes('live') || url.includes('im/'))) {
        console.log('__DANMAKU_STATUS__:ws_hooking_#' + wsCount);

        ws.addEventListener('message', function(event) {
          msgCount++;
          if (msgCount <= 3 || msgCount % 50 === 0) {
            const dataType = event.data instanceof ArrayBuffer ? 'arraybuffer'
              : event.data instanceof Blob ? 'blob'
              : typeof event.data;
            const size = event.data instanceof ArrayBuffer ? event.data.byteLength
              : event.data instanceof Blob ? event.data.size
              : (event.data?.length || 0);
            console.log('__DANMAKU_STATUS__:ws_msg_#' + msgCount + '_type=' + dataType + '_size=' + size);
          }
          try {
            handleWSMessage(event.data);
          } catch(e) {
            console.log('__DANMAKU_ERROR__:ws_handler_' + (e.message || e));
          }
        });

        ws.addEventListener('open', function() {
          console.log('__DANMAKU_STATUS__:ws_open_#' + wsCount);
        });
        ws.addEventListener('close', function(e) {
          console.log('__DANMAKU_STATUS__:ws_close_#' + wsCount + '_code=' + e.code);
        });
        ws.addEventListener('error', function() {
          console.log('__DANMAKU_ERROR__:ws_error_#' + wsCount);
        });
      }

      return ws;
    },
    get(target, prop) {
      return target[prop];
    }
  });

  // Protobuf helpers — support large varints (BigInt-safe)
  function readVarint(data, pos) {
    let result = 0, shift = 0;
    while (pos < data.length) {
      const b = data[pos]; pos++;
      result = (result | ((b & 0x7F) << shift)) >>> 0;
      if ((b & 0x80) === 0) return [result, pos];
      shift += 7;
      if (shift > 35) { // skip overly large varints
        while (pos < data.length && (data[pos] & 0x80)) pos++;
        pos++;
        return [0, pos];
      }
    }
    return [result, pos];
  }

  function parseProtoFields(data) {
    const fields = new Map(); let pos = 0;
    while (pos < data.length) {
      const startPos = pos;
      const [tag, np] = readVarint(data, pos); pos = np;
      const fn = tag >>> 3, wt = tag & 7;
      if (fn === 0 || pos > data.length) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [v, np2] = readVarint(data, pos); pos = np2;
        fields.get(fn).push([wt, v]);
      } else if (wt === 2) {
        const [l, np2] = readVarint(data, pos); pos = np2;
        if (pos + l > data.length) break;
        fields.get(fn).push([wt, data.subarray(pos, pos + l)]);
        pos += l;
      } else if (wt === 1) {
        if (pos + 8 > data.length) break;
        fields.get(fn).push([wt, data.subarray(pos, pos + 8)]);
        pos += 8;
      } else if (wt === 5) {
        if (pos + 4 > data.length) break;
        fields.get(fn).push([wt, data.subarray(pos, pos + 4)]);
        pos += 4;
      } else {
        // Unknown wire type — stop parsing this level
        break;
      }
      if (pos <= startPos) break; // safety: no progress
    }
    return fields;
  }

  function getProtoBytes(fields, fn) {
    for (const [wt, val] of fields.get(fn) || []) {
      if (wt === 2) return val;
    }
    return null;
  }

  function getProtoString(fields, fn) {
    const raw = getProtoBytes(fields, fn);
    if (!raw) return '';
    try { return new TextDecoder().decode(raw); } catch { return ''; }
  }

  function getProtoVarint(fields, fn) {
    for (const [wt, val] of fields.get(fn) || []) {
      if (wt === 0) return val;
    }
    return 0;
  }

  function extractUser(fields, fieldNum) {
    fieldNum = fieldNum || 2;
    const userBytes = getProtoBytes(fields, fieldNum);
    if (!userBytes) return '';
    try {
      const userFields = parseProtoFields(userBytes);
      return getProtoString(userFields, 3) || getProtoString(userFields, 2) || '';
    } catch { return ''; }
  }

  let parsedTotal = 0;

  async function handleWSMessage(data) {
    let arrayBuf;
    if (data instanceof ArrayBuffer) {
      arrayBuf = data;
    } else if (data instanceof Blob) {
      arrayBuf = await data.arrayBuffer();
    } else {
      // Could be text (heartbeat response etc)
      return;
    }

    const buf = new Uint8Array(arrayBuf);
    if (buf.length < 4) return;

    const frame = parseProtoFields(buf);
    const frameKeys = Array.from(frame.keys()).sort((a,b)=>a-b);

    // Log frame structure for first few messages
    if (parsedTotal < 5) {
      console.log('__DANMAKU_STATUS__:frame_keys=[' + frameKeys.join(',') + ']_size=' + buf.length);
    }

    // Try multiple payload field numbers — Douyin versions may differ
    let payload = null;
    for (const fn of [3, 8, 2, 4]) {
      payload = getProtoBytes(frame, fn);
      if (payload && payload.length > 10) break;
      payload = null;
    }

    if (!payload) {
      if (parsedTotal < 5) {
        console.log('__DANMAKU_ERROR__:no_payload_fields=[' + frameKeys.join(',') + ']');
      }
      return;
    }

    // Check compression — try multiple field numbers for encoding header
    let enc = '';
    for (const fn of [5, 6, 4]) {
      enc = getProtoString(frame, fn);
      if (enc) break;
    }
    // Also detect gzip by magic bytes (1f 8b)
    const isGzipMagic = payload.length > 2 && payload[0] === 0x1f && payload[1] === 0x8b;
    if (enc === 'gzip' || isGzipMagic) {
      try {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(payload);
        writer.close();
        const reader = ds.readable.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLen = chunks.reduce((s, c) => s + c.length, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        payload = result;
      } catch (e) {
        console.log('__DANMAKU_ERROR__:gzip_fail_' + (e.message || e));
        return;
      }
    }

    const resp = parseProtoFields(payload);

    // Messages could be in field 1, 2, or 3
    let messages = [];
    for (const fn of [1, 2, 3]) {
      const entries = resp.get(fn) || [];
      const lenBytes = entries.filter(e => e[0] === 2 && e[1].length > 5);
      if (lenBytes.length > messages.length) messages = lenBytes;
    }

    if (messages.length === 0 && parsedTotal < 5) {
      const respKeys = Array.from(resp.keys()).sort((a,b)=>a-b);
      console.log('__DANMAKU_STATUS__:resp_keys=[' + respKeys.join(',') + ']_no_msgs');
    }

    let parsedCount = 0;

    for (const [wt, msgBytes] of messages) {
      if (wt !== 2) continue;
      try {
        const msgFields = parseProtoFields(msgBytes);
        const method = getProtoString(msgFields, 1);

        if (parsedTotal < 3 && method) {
          console.log('__DANMAKU_STATUS__:method=' + method);
        }

        // Find actual message payload (try field 2, 3)
        const msgPayload = getProtoBytes(msgFields, 2) || getProtoBytes(msgFields, 3);
        if (!msgPayload) continue;
        const payloadFields = parseProtoFields(msgPayload);

        if (method === 'WebcastChatMessage') {
          const content = getProtoString(payloadFields, 3);
          if (!content) continue;
          const userName = extractUser(payloadFields);
          console.log('__DANMAKU__:' + JSON.stringify({ content, userName, type: 'chat' }));
          parsedCount++;
        } else if (method === 'WebcastGiftMessage') {
          const userName = extractUser(payloadFields);
          let giftName = '';
          const giftBytes = getProtoBytes(payloadFields, 7) || getProtoBytes(payloadFields, 15);
          if (giftBytes) {
            const giftFields = parseProtoFields(giftBytes);
            giftName = getProtoString(giftFields, 1) || '';
          }
          const repeatCount = getProtoVarint(payloadFields, 17) || getProtoVarint(payloadFields, 8) || 1;
          const content = giftName
            ? '送出 ' + giftName + (repeatCount > 1 ? ' x' + repeatCount : '')
            : '送出礼物';
          console.log('__DANMAKU__:' + JSON.stringify({ content, userName, type: 'gift', giftName }));
          parsedCount++;
        } else if (method === 'WebcastSocialMessage') {
          const userName = extractUser(payloadFields);
          console.log('__DANMAKU__:' + JSON.stringify({ content: '关注了主播', userName, type: 'chat' }));
          parsedCount++;
        } else if (method === 'WebcastLikeMessage') {
          const userName = extractUser(payloadFields);
          const count = getProtoVarint(payloadFields, 3) || 1;
          const content = count > 1 ? '点赞 x' + count : '点赞';
          console.log('__DANMAKU__:' + JSON.stringify({ content, userName, type: 'chat' }));
          parsedCount++;
        } else if (method === 'WebcastFansclubMessage') {
          const userName = extractUser(payloadFields);
          console.log('__DANMAKU__:' + JSON.stringify({ content: '加入粉丝团', userName, type: 'chat' }));
          parsedCount++;
        } else if (method === 'WebcastMemberMessage') {
          const userName = extractUser(payloadFields);
          console.log('__DANMAKU__:' + JSON.stringify({ content: '进入直播间', userName, type: 'chat' }));
          parsedCount++;
        } else if (method && method.startsWith('Webcast')) {
          // Count unknown Webcast messages too for burst detection
          parsedCount++;
        }
      } catch (e) {
        console.log('__DANMAKU_ERROR__:msg_parse_' + (e.message || e));
      }
    }

    parsedTotal += parsedCount;
    if (parsedCount > 0) {
      console.log('__DANMAKU_STATUS__:batch=' + parsedCount + '_total=' + parsedTotal);
    }
  }

  // DOM MutationObserver fallback — try broader selectors
  let chatObserverStarted = false;
  function startChatObserver() {
    if (chatObserverStarted) return;
    // Try multiple possible chat container selectors
    const selectors = [
      '[class*="webcast-chatroom"]',
      '[class*="chat-room"]',
      '[class*="ChatRoom"]',
      '[class*="danmu"]',
      '[class*="comment-list"]',
      '[data-e2e="chat-room"]',
    ];
    let containers = [];
    for (const sel of selectors) {
      containers = document.querySelectorAll(sel);
      if (containers.length > 0) {
        console.log('__DANMAKU_STATUS__:dom_found_' + sel + '_count=' + containers.length);
        break;
      }
    }
    if (containers.length === 0) return;
    chatObserverStarted = true;
    console.log('__DANMAKU_STATUS__:dom_observer_started');

    const giftPatterns = /送出|送给|打赏|礼物|嘉年华|火箭|穿云箭|小心心|玫瑰|棒棒糖|啤酒/;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node;
          const text = el.textContent?.trim();
          if (!text || text.length < 2) continue;

          // Try to extract username and content
          const nameEl = el.querySelector('[class*="nickname"]')
            || el.querySelector('[class*="user-name"]')
            || el.querySelector('[class*="userName"]')
            || el.querySelector('[class*="author"]');
          const textEl = el.querySelector('[class*="content"]')
            || el.querySelector('[class*="message"]')
            || el.querySelector('[class*="text"]');

          let content = '', userName = '';
          if (nameEl && textEl) {
            content = textEl.textContent?.trim() || '';
            userName = nameEl.textContent?.trim() || '';
          } else if (text.includes('：')) {
            const idx = text.indexOf('：');
            userName = text.substring(0, idx).trim();
            content = text.substring(idx + 1).trim();
          } else if (text.includes(':')) {
            const idx = text.indexOf(':');
            userName = text.substring(0, idx).trim();
            content = text.substring(idx + 1).trim();
          }

          if (content && content.length > 0) {
            const isGift = giftPatterns.test(content);
            console.log('__DANMAKU__:' + JSON.stringify({
              content, userName,
              type: isGift ? 'gift' : 'chat',
              giftName: isGift ? content : '',
            }));
          }
        }
      }
    });

    for (const container of containers) {
      observer.observe(container, { childList: true, subtree: true });
    }
  }

  // Periodically try DOM observer as fallback
  let domAttempts = 0;
  const domInterval = setInterval(() => {
    if (!chatObserverStarted) {
      startChatObserver();
      if (domAttempts % 10 === 0) {
        console.log('__DANMAKU_STATUS__:dom_scan_attempt_' + domAttempts + '_wsCount=' + wsCount + '_msgCount=' + msgCount);
      }
    }
    domAttempts++;
    if (domAttempts > 60 || chatObserverStarted) clearInterval(domInterval);
  }, 2000);

  console.log('__DANMAKU_STATUS__:preload_installed_' + Date.now());
})();
`
  }

  async disconnect(): Promise<void> {
    this._isConnected = false
    if (this.win && !this.win.isDestroyed()) {
      this.win.close()
      this.win = null
    }
    logger.info('Douyin danmaku disconnected')
  }

  onMessage(cb: DanmakuCallback): void {
    this.callbacks.push(cb)
  }
}
