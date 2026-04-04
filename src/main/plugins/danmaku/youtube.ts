import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DanmakuCollector, DanmakuMessage, DanmakuCallback } from './types'
import type { PluginMetadata } from '../types/metadata'
import { loadCookies } from '../../utils/cookies'
import { getLogger } from '../../utils/logger'

const logger = getLogger('danmaku.youtube')

// Metadata for plugin discovery
export const YOUTUBE_DANMAKU_METADATA = {
  label: 'YouTube 直播',
  label_en: 'YouTube Danmaku',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const youtubeDanmakuMetadata: PluginMetadata = {
  id: 'youtube-danmaku',
  type: 'danmaku',
  name: 'youtube',
  platform: 'youtube',
  label: YOUTUBE_DANMAKU_METADATA.label,
  label_en: YOUTUBE_DANMAKU_METADATA.label_en,
  version: YOUTUBE_DANMAKU_METADATA.version,
  description: 'Danmaku collector for YouTube live streams',
  enabled: true,
}

export class YoutubeDanmaku implements DanmakuCollector {
  readonly platform = 'youtube'
  readonly label = YOUTUBE_DANMAKU_METADATA.label
  readonly label_en = YOUTUBE_DANMAKU_METADATA.label_en
  private callbacks: DanmakuCallback[] = []
  private _isConnected = false
  private win: BrowserWindow | null = null

  get isConnected(): boolean { return this._isConnected }

  async connect(roomId: string): Promise<void> {
    logger.info(`Starting YouTube danmaku for room/video ${roomId}`)

    try {
      const preloadPath = join(app.getPath('userData'), 'youtube-danmaku-preload.js')
      writeFileSync(preloadPath, this.getPreloadScript())

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
          logger.info(`YouTube danmaku status: ${message.slice('__DANMAKU_STATUS__:'.length)}`)
        }
      })

      // Load cookies
      const savedCookies = loadCookies('youtube')
      if (savedCookies.length > 0) {
        const ses = this.win.webContents.session
        let loaded = 0
        for (const c of savedCookies) {
          try {
            await ses.cookies.set({
              url: `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
              name: c.name, value: c.value, domain: c.domain,
              path: c.path || '/', httpOnly: c.httpOnly,
              secure: c.secure, expirationDate: c.expirationDate,
            })
            loaded++
          } catch { /* skip */ }
        }
        logger.info(`Loaded ${loaded} cookies into YouTube danmaku session`)
      }

      // YouTube live chat URL - try popout chat first, then fall back to video page
      const isVideoId = /^[a-zA-Z0-9_-]{11}$/.test(roomId)
      const liveUrl = isVideoId
        ? `https://www.youtube.com/live_chat?v=${roomId}&is_popout=1`
        : `https://www.youtube.com/watch?v=${roomId}`

      await this.win.loadURL(liveUrl)
      this._isConnected = true
      logger.info(`YouTube danmaku BrowserWindow loaded: ${liveUrl}`)
    } catch (e: any) {
      logger.error(`YouTube danmaku connect failed: ${e.message}`)
      this._isConnected = false
    }
  }

  private getPreloadScript(): string {
    return `
(function() {
  if (window.__danmakuInterceptorInstalled) return;
  window.__danmakuInterceptorInstalled = true;
  console.log('__DANMAKU_STATUS__:youtube_preload_start');

  let msgTotal = 0;

  // YouTube Live Chat uses custom <yt-live-chat-*> elements
  // We observe the chat container for new message items
  let observerStarted = false;
  const scPatterns = /Super Chat|Super Sticker|superchat/i;

  function startObserver() {
    if (observerStarted) return;

    const selectors = [
      '#items.yt-live-chat-item-list-renderer',
      'yt-live-chat-item-list-renderer #items',
      '#chat-messages',
      '[class*="chat-list"]',
      '#items',
    ];

    let container = null;
    for (const sel of selectors) {
      container = document.querySelector(sel);
      if (container) {
        console.log('__DANMAKU_STATUS__:dom_found_' + sel);
        break;
      }
    }
    if (!container) return;

    observerStarted = true;
    console.log('__DANMAKU_STATUS__:dom_observer_started');

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node;
          const tagName = el.tagName?.toLowerCase() || '';

          let content = '', userName = '', type = 'chat', giftName = '';

          if (tagName === 'yt-live-chat-text-message-renderer') {
            // Regular chat message
            const authorEl = el.querySelector('#author-name');
            const msgEl = el.querySelector('#message');
            userName = authorEl?.textContent?.trim() || '';
            content = msgEl?.textContent?.trim() || '';
          } else if (tagName === 'yt-live-chat-paid-message-renderer') {
            // Super Chat
            const authorEl = el.querySelector('#author-name');
            const msgEl = el.querySelector('#message') || el.querySelector('#purchase-amount');
            userName = authorEl?.textContent?.trim() || '';
            content = msgEl?.textContent?.trim() || 'Super Chat';
            type = 'superchat';
            giftName = 'SuperChat';
          } else if (tagName === 'yt-live-chat-paid-sticker-renderer') {
            // Super Sticker
            const authorEl = el.querySelector('#author-name');
            userName = authorEl?.textContent?.trim() || '';
            content = 'Super Sticker';
            type = 'gift';
            giftName = 'SuperSticker';
          } else if (tagName === 'yt-live-chat-membership-item-renderer') {
            // Membership
            const authorEl = el.querySelector('#author-name');
            userName = authorEl?.textContent?.trim() || '';
            content = 'New Member';
            type = 'gift';
            giftName = 'Membership';
          } else {
            // Try generic extraction
            const text = el.textContent?.trim();
            if (!text || text.length < 2) continue;
            content = text;
          }

          if (content && content.length > 0) {
            msgTotal++;
            console.log('__DANMAKU__:' + JSON.stringify({
              content, userName, type, giftName,
            }));
            if (msgTotal % 50 === 0) {
              console.log('__DANMAKU_STATUS__:total_' + msgTotal);
            }
          }
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true });
  }

  let attempts = 0;
  const interval = setInterval(() => {
    if (!observerStarted) startObserver();
    attempts++;
    if (attempts > 60 || observerStarted) clearInterval(interval);
  }, 2000);

  // Also try after initial page load
  if (document.readyState === 'complete') {
    setTimeout(startObserver, 1000);
  } else {
    window.addEventListener('load', () => setTimeout(startObserver, 2000));
  }

  console.log('__DANMAKU_STATUS__:youtube_preload_installed');
})();
`
  }

  async disconnect(): Promise<void> {
    this._isConnected = false
    if (this.win && !this.win.isDestroyed()) {
      this.win.close()
      this.win = null
    }
    logger.info('YouTube danmaku disconnected')
  }

  onMessage(cb: DanmakuCallback): void {
    this.callbacks.push(cb)
  }
}
