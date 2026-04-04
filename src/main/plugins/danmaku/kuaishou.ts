import { app, BrowserWindow, session } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DanmakuCollector, DanmakuMessage, DanmakuCallback } from './types'
import type { PluginMetadata } from '../types/metadata'
import { getLogger } from '../../utils/logger'

const logger = getLogger('danmaku.kuaishou')

export const KUAISHOU_DANMAKU_METADATA = {
  label: '快手弹幕',
  label_en: 'Kuaishou Danmaku',
  version: '1.0.0',
}

export const kuaishouDanmakuMetadata: PluginMetadata = {
  id: 'kuaishou-danmaku',
  type: 'danmaku',
  name: 'kuaishou',
  platform: 'kuaishou',
  label: KUAISHOU_DANMAKU_METADATA.label,
  label_en: KUAISHOU_DANMAKU_METADATA.label_en,
  version: KUAISHOU_DANMAKU_METADATA.version,
  description: 'Danmaku collector for Kuaishou live streams',
  enabled: true,
}

export class KuaishouDanmaku implements DanmakuCollector {
  readonly platform = 'kuaishou'
  readonly label = KUAISHOU_DANMAKU_METADATA.label
  readonly label_en = KUAISHOU_DANMAKU_METADATA.label_en
  private callbacks: DanmakuCallback[] = []
  private _isConnected = false
  private win: BrowserWindow | null = null
  private reloadTimer: ReturnType<typeof setInterval> | null = null

  get isConnected(): boolean { return this._isConnected }

  async connect(roomId: string): Promise<void> {
    logger.info(`Starting Kuaishou danmaku for room ${roomId}`)

    try {
      const preloadPath = join(app.getPath('userData'), 'kuaishou-danmaku-preload.js')
      writeFileSync(preloadPath, this.getPreloadScript())

      // Use a FRESH session for danmaku — NOT the persist session.
      // The persist session (persist:platform-kuaishou) accumulates cookies/state
      // that causes Kuaishou to redirect to homepage instead of the live room.
      // A clean session loads the room correctly with SSR chat content.
      // Kuaishou's public live page shows danmaku without login.
      const danmakuSession = session.fromPartition(`danmaku-kuaishou-${Date.now()}`)

      // Use direct connection to avoid proxy (Clash) SSL handshake failures.
      try {
        await danmakuSession.setProxy({ proxyRules: 'direct://' })
      } catch { /* ignore */ }

      // IMPORTANT: Window must be visible (show:true) for Kuaishou's SPA to initialize chat.
      // Hidden (show:false) or minimized windows get rendering suspended by Chromium.
      // Solution: show:true + opacity:0 — Chromium keeps rendering but user sees nothing.
      this.win = new BrowserWindow({
        width: 800,
        height: 600,
        show: true,
        title: '快手弹幕采集',
        skipTaskbar: true,
        webPreferences: {
          preload: preloadPath,
          nodeIntegration: false,
          contextIsolation: false,
          sandbox: false,
          session: danmakuSession,
          backgroundThrottling: false,
        },
      })
      this.win.setOpacity(0)
      // Move off-screen as extra insurance — opacity:0 handles visibility,
      // off-screen prevents accidental mouse interaction
      this.win.setPosition(-9999, -9999)

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
            for (const cb of this.callbacks) {
              try { cb(msg) } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        } else if (message.startsWith('__DANMAKU_STATUS__:')) {
          logger.info(`Kuaishou danmaku status: ${message.slice('__DANMAKU_STATUS__:'.length)}`)
        }
      })

      // Log page load failures for debugging
      this.win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        logger.warn(`Kuaishou page did-fail-load: code=${errorCode} desc="${errorDescription}" url=${validatedURL?.substring(0, 100)}`)
      })

      const liveUrl = `https://live.kuaishou.com/u/${roomId}`
      this._isConnected = true

      // Kuaishou limits non-logged-in viewing to ~30 seconds, then freezes the page.
      // Solution: reload the page every 25 seconds to get a fresh 30-second window.
      // Each reload fetches new SSR chat content. The preload's dedup set (seenTexts)
      // is reset on each reload, but the main process dedup (recentMsgSet in callbacks)
      // prevents duplicate messages from reaching the scoring engine.
      // However, we CANNOT rely on preload dedup across reloads since preload re-runs.
      // So we track seen messages HERE in the main process.
      const seenInMain = new Set<string>()
      const origConsoleHandler = this.win.webContents.listenerCount('console-message') > 0

      // Wrap the console-message handler to dedup across reloads
      this.win.webContents.removeAllListeners('console-message')
      this.win.webContents.on('console-message', (_event, _level, message) => {
        if (message.startsWith('__DANMAKU__:')) {
          try {
            const data = JSON.parse(message.slice('__DANMAKU__:'.length))
            const dedupKey = `${data.userName || ''}|${data.content || ''}`
            if (seenInMain.has(dedupKey)) return
            seenInMain.add(dedupKey)
            // Keep set bounded
            if (seenInMain.size > 500) {
              const iter = seenInMain.values()
              for (let i = 0; i < 100; i++) seenInMain.delete(iter.next().value)
            }
            const msg: DanmakuMessage = {
              text: data.content,
              userName: data.userName || '',
              timestamp: Date.now(),
              type: data.type || 'chat',
              giftName: data.giftName || '',
            }
            for (const cb of this.callbacks) {
              try { cb(msg) } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        } else if (message.startsWith('__DANMAKU_STATUS__:')) {
          logger.info(`Kuaishou danmaku status: ${message.slice('__DANMAKU_STATUS__:'.length)}`)
        }
      })

      // Initial page load
      this.win.loadURL(liveUrl)
        .then(() => logger.info('Kuaishou danmaku page loaded'))
        .catch((e: any) => logger.warn(`Kuaishou danmaku page load failed: ${e.message}`))

      // Reload every 25 seconds to bypass the 30-second non-login limit.
      // Each reload creates a fresh page with new SSR chat content.
      this.reloadTimer = setInterval(() => {
        if (!this.win || this.win.isDestroyed() || !this._isConnected) {
          if (this.reloadTimer) { clearInterval(this.reloadTimer); this.reloadTimer = null }
          return
        }
        logger.info('Kuaishou danmaku: reloading page for fresh content')
        this.win.loadURL(liveUrl)
          .catch((e: any) => logger.warn(`Kuaishou danmaku reload failed: ${e.message}`))
      }, 25000)
    } catch (e: any) {
      logger.error(`Kuaishou danmaku connect failed: ${e.message}`)
      this._isConnected = false
    }
  }

  private getPreloadScript(): string {
    return `
(function() {
  if (window.__danmakuInterceptorInstalled) return;
  window.__danmakuInterceptorInstalled = true;
  console.log('__DANMAKU_STATUS__:kuaishou_preload_start');

  // Force page to think it's visible — Kuaishou's JS checks visibility
  // before establishing WebSocket connections for live chat
  Object.defineProperty(document, 'hidden', { get: function() { return false; } });
  Object.defineProperty(document, 'visibilityState', { get: function() { return 'visible'; } });
  document.addEventListener('visibilitychange', function(e) { e.stopImmediatePropagation(); }, true);

  var msgTotal = 0;
  var wsMessageCount = 0;
  var giftPatterns = /送出|礼物|火箭|穿云箭|啤酒|棒棒糖|么么哒|比心|打赏|赠送|飞机|火焰/;
  var systemPatterns = /没有更多评论|欢迎来到直播间|系统消息|快手禁止|未成年|理性消费|违反社区|直播规范|仅自己可见/;
  // Dedup: track recent messages to avoid DOM + WS double-counting
  var recentMsgSet = new Set();
  var recentMsgQueue = [];

  function emitDanmaku(content, userName, type) {
    if (!content || content.length < 1) return;
    if (systemPatterns.test(content)) return;
    // Deduplicate
    var key = (userName || '') + '|' + content;
    if (recentMsgSet.has(key)) return;
    recentMsgSet.add(key);
    recentMsgQueue.push(key);
    if (recentMsgQueue.length > 100) {
      recentMsgSet.delete(recentMsgQueue.shift());
    }
    msgTotal++;
    var isGift = type === 'gift' || giftPatterns.test(content);
    console.log('__DANMAKU__:' + JSON.stringify({
      content: content,
      userName: userName || '',
      type: isGift ? 'gift' : (type || 'chat'),
      giftName: isGift ? content : '',
    }));
    if (msgTotal % 20 === 0) {
      console.log('__DANMAKU_STATUS__:total_' + msgTotal);
    }
  }

  // ─── Protobuf helpers (for WebSocket binary parsing) ───
  function readVarint(data, pos) {
    var result = 0, shift = 0;
    while (pos < data.length) {
      var b = data[pos]; pos++;
      result = (result | ((b & 0x7F) << shift)) >>> 0;
      if ((b & 0x80) === 0) return [result, pos];
      shift += 7;
      if (shift > 35) {
        while (pos < data.length && (data[pos] & 0x80)) pos++;
        pos++;
        return [0, pos];
      }
    }
    return [result, pos];
  }

  function parseProtoFields(data) {
    var fields = new Map(); var pos = 0;
    while (pos < data.length) {
      var startPos = pos;
      var r = readVarint(data, pos); var tag = r[0]; pos = r[1];
      var fn = tag >>> 3, wt = tag & 7;
      if (fn === 0 || pos > data.length) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        var r2 = readVarint(data, pos); pos = r2[1];
        fields.get(fn).push([wt, r2[0]]);
      } else if (wt === 2) {
        var r3 = readVarint(data, pos); pos = r3[1];
        var len = r3[0];
        if (pos + len > data.length) break;
        fields.get(fn).push([wt, data.subarray(pos, pos + len)]);
        pos += len;
      } else if (wt === 1) {
        if (pos + 8 > data.length) break;
        fields.get(fn).push([wt, data.subarray(pos, pos + 8)]); pos += 8;
      } else if (wt === 5) {
        if (pos + 4 > data.length) break;
        fields.get(fn).push([wt, data.subarray(pos, pos + 4)]); pos += 4;
      } else { break; }
      if (pos <= startPos) break;
    }
    return fields;
  }

  function getProtoBytes(fields, fn) {
    var entries = fields.get(fn);
    if (!entries) return null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i][0] === 2) return entries[i][1];
    }
    return null;
  }

  function getProtoString(fields, fn) {
    var raw = getProtoBytes(fields, fn);
    if (!raw) return '';
    try { return new TextDecoder().decode(raw); } catch(e) { return ''; }
  }

  function getAllProtoBytes(fields, fn) {
    var result = [];
    var entries = fields.get(fn);
    if (!entries) return result;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i][0] === 2) result.push(entries[i][1]);
    }
    return result;
  }

  // Extract UTF-8 strings from binary data (fallback for unknown protobuf)
  function extractStringsFromBinary(bytes) {
    var strings = [];
    var i = 0;
    while (i < bytes.length) {
      // Look for length-delimited string fields (wire type 2)
      // Try to find sequences of valid UTF-8 that look like text
      if (bytes[i] >= 0x20 && bytes[i] < 0x7f) {
        // ASCII sequence
        var start = i;
        while (i < bytes.length && bytes[i] >= 0x20 && bytes[i] < 0x7f) i++;
        if (i - start >= 2) {
          strings.push(new TextDecoder().decode(bytes.subarray(start, i)));
        }
      } else if ((bytes[i] & 0xE0) === 0xC0 || (bytes[i] & 0xF0) === 0xE0 || (bytes[i] & 0xF8) === 0xF0) {
        // Multi-byte UTF-8 start
        var start = i;
        try {
          // Try decoding a chunk
          var end = Math.min(i + 200, bytes.length);
          var chunk = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(start, end));
          if (chunk.length >= 1) {
            // Find how many bytes were consumed for meaningful text
            var meaningful = chunk.match(/[\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff\\w\\s\\u3000-\\u303f\\uff00-\\uffef!-~]{1,100}/g);
            if (meaningful) {
              for (var j = 0; j < meaningful.length; j++) {
                if (meaningful[j].length >= 2) strings.push(meaningful[j]);
              }
            }
          }
        } catch(e) {}
        i++;
      } else {
        i++;
      }
    }
    return strings;
  }

  // ─── Method 1: WebSocket interception ───
  var OrigWS = window.WebSocket;
  var wsCount = 0;

  window.WebSocket = new Proxy(OrigWS, {
    construct: function(target, args) {
      var url = args[0] || '';
      wsCount++;
      var currentWs = wsCount;
      var ws = new target(url, args[1]);

      if (typeof url === 'string') {
        console.log('__DANMAKU_STATUS__:ws_connect_' + currentWs + '_' + url.substring(0, 150));

        ws.addEventListener('open', function() {
          console.log('__DANMAKU_STATUS__:ws_open_' + currentWs);
        });
        ws.addEventListener('close', function(e) {
          console.log('__DANMAKU_STATUS__:ws_close_' + currentWs + '_code=' + e.code);
        });
        ws.addEventListener('error', function() {
          console.log('__DANMAKU_STATUS__:ws_error_' + currentWs);
        });

        ws.addEventListener('message', function(event) {
          wsMessageCount++;
          try {
            // Text messages
            if (typeof event.data === 'string' && event.data.length > 2) {
              if (wsMessageCount <= 3) {
                console.log('__DANMAKU_STATUS__:ws_text_msg_' + event.data.substring(0, 200));
              }
              try {
                var json = JSON.parse(event.data);
                if (json.type === 'chat' || json.type === 'comment') {
                  emitDanmaku(json.content || json.msg || json.text, json.userName || json.user || json.nick, 'chat');
                } else if (json.type === 'gift') {
                  emitDanmaku(json.giftName || json.content, json.userName || json.user, 'gift');
                }
              } catch(e) {}
            }

            // Binary messages — parse protobuf structure
            if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
              var processBuffer = function(buf) {
                var bytes = new Uint8Array(buf);
                if (bytes.length < 4) return;

                if (wsMessageCount <= 5 || wsMessageCount % 100 === 0) {
                  console.log('__DANMAKU_STATUS__:ws_bin_' + wsMessageCount + '_size=' + bytes.length);
                }

                // Try structured protobuf parsing first
                try {
                  var frame = parseProtoFields(bytes);
                  var frameKeys = Array.from(frame.keys()).sort(function(a,b){return a-b;});

                  if (wsMessageCount <= 3) {
                    console.log('__DANMAKU_STATUS__:ws_proto_keys=[' + frameKeys.join(',') + ']');
                  }

                  // Kuaishou WebSocket uses a protobuf envelope.
                  // Try to find message lists in common field numbers.
                  var processed = false;
                  for (var fn = 1; fn <= 8; fn++) {
                    var entries = getAllProtoBytes(frame, fn);
                    for (var ei = 0; ei < entries.length; ei++) {
                      var entry = entries[ei];
                      if (entry.length < 5) continue;
                      try {
                        var subFields = parseProtoFields(entry);
                        // Look for a string field that could be username or content
                        var possibleTexts = [];
                        for (var sf = 1; sf <= 10; sf++) {
                          var s = getProtoString(subFields, sf);
                          if (s && s.length >= 1 && s.length <= 100) {
                            possibleTexts.push({field: sf, text: s});
                          }
                        }
                        if (possibleTexts.length >= 2) {
                          // Heuristic: shorter text is likely username, longer is content
                          possibleTexts.sort(function(a,b) { return a.text.length - b.text.length; });
                          var userName = possibleTexts[0].text;
                          var content = possibleTexts[possibleTexts.length - 1].text;
                          if (content.length >= 1 && content !== userName) {
                            emitDanmaku(content, userName, 'chat');
                            processed = true;
                          }
                        }
                      } catch(e) {}
                    }
                  }

                  // Fallback: extract readable strings from binary
                  if (!processed) {
                    var strings = extractStringsFromBinary(bytes);
                    // Log first few for debugging
                    if (wsMessageCount <= 5 && strings.length > 0) {
                      console.log('__DANMAKU_STATUS__:ws_strings=' + strings.slice(0, 5).join('|'));
                    }
                  }
                } catch(e) {
                  if (wsMessageCount <= 5) {
                    console.log('__DANMAKU_STATUS__:ws_parse_err_' + (e.message || e));
                  }
                }
              };

              if (event.data instanceof Blob) {
                event.data.arrayBuffer().then(processBuffer).catch(function(){});
              } else {
                processBuffer(event.data);
              }
            }
          } catch(e) { /* ignore */ }
        });
      }
      return ws;
    },
    get: function(target, prop) { return target[prop]; }
  });

  // ─── Method 2: Fetch/XHR interception ───
  var origFetch = window.fetch;
  window.fetch = function() {
    var fetchUrl = arguments[0];
    if (typeof fetchUrl === 'string') {
      if (fetchUrl.indexOf('comment') >= 0 || fetchUrl.indexOf('chat') >= 0 || fetchUrl.indexOf('message') >= 0 || fetchUrl.indexOf('barrage') >= 0) {
        console.log('__DANMAKU_STATUS__:fetch_' + fetchUrl.substring(0, 120));
      }
    }
    return origFetch.apply(this, arguments).then(function(resp) {
      try {
        var url = resp.url || '';
        if (url.indexOf('comment') >= 0 || url.indexOf('chat') >= 0 || url.indexOf('message') >= 0 || url.indexOf('barrage') >= 0) {
          resp.clone().json().then(function(data) {
            var comments = data.comments || data.data?.comments || data.data?.list || data.list || [];
            if (Array.isArray(comments)) {
              for (var i = 0; i < comments.length; i++) {
                var c = comments[i];
                var content = c.content || c.text || c.msg || c.comment || '';
                var user = c.userName || c.user_name || c.nickname || c.nick || '';
                if (content) emitDanmaku(content, user, 'chat');
              }
            }
          }).catch(function(){});
        }
      } catch(e) {}
      return resp;
    });
  };

  // ─── Method 3: DOM observation (primary method for Kuaishou) ───
  // Kuaishou renders chat in a virtualized list inside chat-history.
  // Username and content are in SEPARATE child elements (not "user：content" text).
  // We must use CSS selectors to find child elements rather than colon-splitting.
  var mutationCount = 0;
  var lastLogTime = 0;
  var domDebugDone = false;

  function extractFromElement(el) {
    var text = el.textContent ? el.textContent.trim() : '';
    if (!text || text.length < 1) return;

    // Strategy 1: Find username and content via CSS class selectors
    // Kuaishou uses various class patterns for chat items
    var nameEl = el.querySelector('[class*="nickname"]')
      || el.querySelector('[class*="user-name"]')
      || el.querySelector('[class*="userName"]')
      || el.querySelector('[class*="name"]')
      || el.querySelector('[class*="author"]');
    var textEl = el.querySelector('[class*="content"]')
      || el.querySelector('[class*="message"]')
      || el.querySelector('[class*="comment-text"]')
      || el.querySelector('[class*="chat-text"]')
      || el.querySelector('[class*="msg"]');

    if (nameEl && textEl) {
      var content = textEl.textContent ? textEl.textContent.trim() : '';
      var userName = nameEl.textContent ? nameEl.textContent.trim() : '';
      if (content) {
        emitDanmaku(content, userName, 'chat');
        return;
      }
    }

    // Strategy 2: Check for colon-separated text (：or :)
    var idx = text.indexOf('\\uff1a');
    if (idx < 0 || idx > 30) idx = text.indexOf(':');
    if (idx > 0 && idx <= 30) {
      var userName = text.substring(0, idx).trim();
      var content = text.substring(idx + 1).trim();
      if (content && content.length >= 1) {
        emitDanmaku(content, userName, 'chat');
        return;
      }
    }

    // Strategy 3: If element has 2-3 child spans (typical chat item: [name] [content])
    var children = el.children;
    if (children && children.length >= 2 && children.length <= 4) {
      var texts = [];
      for (var i = 0; i < children.length && i < 4; i++) {
        var ct = children[i].textContent ? children[i].textContent.trim() : '';
        if (ct && ct.length >= 1 && ct.length <= 50) texts.push(ct);
      }
      if (texts.length === 2 || texts.length === 3) {
        var userName = texts[0];
        var content = texts[texts.length - 1];
        // Only emit if username is short (< 20 chars) and content is reasonable length
        if (userName.length <= 20 && content.length >= 1 && content.length <= 100 &&
            content !== userName && !/^\\d{1,2}:\\d{2}/.test(content) &&
            !/万位订阅者/.test(content)) {
          emitDanmaku(content, userName, 'chat');
          return;
        }
      }
    }

    // Strategy 4: If it's a short, standalone text (gift message etc), emit as-is
    if (text.length >= 2 && text.length <= 50 && giftPatterns.test(text)) {
      emitDanmaku(text, '', 'gift');
    }
  }

  // Check if an element is inside the chat area (not navigation/sidebar)
  function isInChatArea(el) {
    var node = el;
    var depth = 0;
    while (node && depth < 15) {
      var cls = typeof node.className === 'string' ? node.className : '';
      if (cls.indexOf('chat-history') >= 0 || cls.indexOf('chat-list') >= 0 ||
          cls.indexOf('comment-list') >= 0 || cls.indexOf('virt-list') >= 0) {
        return true;
      }
      // Definitely NOT in chat area
      if (cls.indexOf('container-tab') >= 0 || cls.indexOf('container-auchor') >= 0 ||
          cls.indexOf('hot-list') >= 0 || cls.indexOf('slick-') >= 0 ||
          cls.indexOf('sidebar') >= 0 || cls.indexOf('header') >= 0 ||
          cls.indexOf('navigation') >= 0) {
        return false;
      }
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  function handleBodyMutation(mutations) {
    for (var m = 0; m < mutations.length; m++) {
      var added = mutations[m].addedNodes;
      for (var n = 0; n < added.length; n++) {
        if (added[n].nodeType !== 1) continue;
        var el = added[n];
        var cls = el.className || '';

        // Debug: log first few added elements with their classes
        if (!domDebugDone && mutationCount < 50) {
          var text = el.textContent ? el.textContent.trim() : '';
          if (text.length >= 2 && text.length <= 200 && cls) {
            console.log('__DANMAKU_STATUS__:dom_node_cls=' + (typeof cls === 'string' ? cls.substring(0, 80) : '') + '_text=' + text.substring(0, 60));
          }
        }

        // Only extract from elements inside the chat area
        if (isInChatArea(el)) {
          extractFromElement(el);
          if (el.children && el.children.length > 0 && el.children.length <= 20) {
            for (var c = 0; c < el.children.length; c++) {
              extractFromElement(el.children[c]);
            }
          }
        }
      }
    }
    mutationCount++;
    if (mutationCount === 50) domDebugDone = true;

    var now = Date.now();
    if (now - lastLogTime > 10000) {
      lastLogTime = now;
      console.log('__DANMAKU_STATUS__:mutations_' + mutationCount + '_msgs_' + msgTotal + '_ws_' + wsMessageCount);
    }
  }

  // Start body observer and also try targeted chat-history observer
  function startBodyObserver() {
    if (!document.body) {
      setTimeout(startBodyObserver, 500);
      return;
    }
    var observer = new MutationObserver(handleBodyMutation);
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('__DANMAKU_STATUS__:body_observer_started');
  }
  startBodyObserver();

  // ─── Method 4: Periodic DOM polling (primary for Kuaishou) ───
  // Kuaishou's chat is server-side rendered (SSR) and may update via SPA virtual DOM.
  // MutationObserver alone is insufficient because:
  // 1. SSR content is already in the DOM when observer starts
  // 2. SPA might update content in-place without adding new nodes
  // 3. The WebSocket for live updates often doesn't connect in BrowserWindow context
  // Solution: periodically scan the chat container for ALL items, track which we've seen.
  var seenTexts = new Set();
  var chatPollStarted = false;
  var pollCount = 0;
  var lastChatSnapshot = '';

  function scanChatContainer() {
    // Find the chat container
    var container = document.querySelector('[class*="chat-history"]')
      || document.querySelector('[class*="chat-list"]')
      || document.querySelector('[class*="comment-list"]');
    if (!container) return;

    if (!chatPollStarted) {
      chatPollStarted = true;
      console.log('__DANMAKU_STATUS__:chat_poll_started_children=' + container.children.length);
    }

    // Get ALL text content and check if it changed
    var currentSnapshot = container.textContent || '';
    if (currentSnapshot === lastChatSnapshot) return;
    lastChatSnapshot = currentSnapshot;

    // Scan all leaf-level elements that might be chat items
    // Kuaishou chat items have the format "username：content" in their combined text
    var items = container.querySelectorAll('[class*="comment"], [class*="chat-item"], [class*="message-item"], [class*="fold-message"]');

    // If no specific items found, scan direct children or all divs
    if (items.length === 0) {
      // Look for elements that contain the ：colon pattern
      var allEls = container.querySelectorAll('div, span, li, p');
      var candidates = [];
      for (var i = 0; i < allEls.length; i++) {
        var t = allEls[i].textContent || '';
        // Must contain ： and be a reasonable chat-message length
        if (t.length >= 3 && t.length <= 200 && t.indexOf('\\uff1a') > 0 && t.indexOf('\\uff1a') <= 30) {
          // Check it's a leaf (doesn't contain other candidates)
          var isLeaf = true;
          for (var j = 0; j < candidates.length; j++) {
            if (allEls[i].contains(candidates[j]) || candidates[j].contains(allEls[i])) {
              isLeaf = false;
              break;
            }
          }
          if (isLeaf) candidates.push(allEls[i]);
        }
      }
      items = candidates;
    }

    var newCount = 0;
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var text = (el.textContent || '').trim();
      if (!text || text.length < 3) continue;

      // Skip if already seen
      if (seenTexts.has(text)) continue;
      seenTexts.add(text);
      // Keep set bounded
      if (seenTexts.size > 500) {
        var it = seenTexts.values();
        for (var d = 0; d < 100; d++) seenTexts.delete(it.next().value);
      }

      // Extract username and content from the text
      extractFromElement(el);
      newCount++;
    }

    // Also try scanning by splitting the full text by the ： pattern
    // This handles cases where individual items don't have separate DOM nodes
    if (newCount === 0 && currentSnapshot.indexOf('\\uff1a') > 0) {
      // Split text by looking for username：content patterns
      var parts = currentSnapshot.split(/(?=[\\u4e00-\\u9fff\\w]{1,20}\\uff1a)/);
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim();
        if (!part || part.length < 3) continue;
        var colonIdx = part.indexOf('\\uff1a');
        if (colonIdx <= 0 || colonIdx > 30) continue;

        var userName = part.substring(0, colonIdx).trim();
        var content = part.substring(colonIdx + 1).trim();
        if (!content || content.length < 1) continue;

        var key = userName + '|' + content;
        if (seenTexts.has(key)) continue;
        seenTexts.add(key);
        emitDanmaku(content, userName, 'chat');
        newCount++;
      }
    }

    pollCount++;
    if (pollCount <= 5 || newCount > 0 || pollCount % 30 === 0) {
      console.log('__DANMAKU_STATUS__:chat_poll_' + pollCount + '_new=' + newCount + '_total=' + msgTotal + '_seen=' + seenTexts.size);
    }
  }

  // Auto-dismiss login modal
  var loginModalDismissed = false;
  function tryDismissLoginModal() {
    if (loginModalDismissed) return;
    var modal = document.querySelector('[class*="user-modal"][class*="login-alert"]')
      || document.querySelector('[class*="login-modal"]');
    if (modal) {
      var closeBtn = modal.querySelector('[class*="close"]')
        || modal.querySelector('[class*="icon-close"]')
        || modal.querySelector('button[class*="close"]');
      if (closeBtn) {
        closeBtn.click();
        loginModalDismissed = true;
        console.log('__DANMAKU_STATUS__:login_modal_dismissed_via_close');
      } else {
        modal.remove();
        var overlay = document.querySelector('[class*="modal-mask"]')
          || document.querySelector('[class*="overlay"]');
        if (overlay) overlay.remove();
        loginModalDismissed = true;
        console.log('__DANMAKU_STATUS__:login_modal_removed_from_dom');
      }
    }
  }

  // Poll chat every 3 seconds (fast enough for scoring, not too aggressive)
  setInterval(function() {
    tryDismissLoginModal();
    scanChatContainer();
  }, 3000);
  // Also do an initial scan after page likely finished rendering
  setTimeout(scanChatContainer, 5000);

  console.log('__DANMAKU_STATUS__:kuaishou_preload_installed');
})();
`
  }

  async disconnect(): Promise<void> {
    this._isConnected = false
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer)
      this.reloadTimer = null
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.close()
      this.win = null
    }
    logger.info('Kuaishou danmaku disconnected')
  }

  onMessage(cb: DanmakuCallback): void {
    this.callbacks.push(cb)
  }
}
