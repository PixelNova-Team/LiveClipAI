import type { PublisherPlugin, PublishOptions, PublishResult } from './types'
import type { PluginMetadata } from '../types/metadata'
import { loadCookies } from '../../utils/cookies'
import { getConfig } from '../../config'
import { browserPublish } from './browser-publish'
import { getLogger } from '../../utils/logger'
import { mt } from '../../i18n'

const logger = getLogger('publisher.kuaishou')

// Metadata for plugin discovery
export const KUAISHOU_PUBLISHER_METADATA = {
  label: '快手',
  label_en: 'Kuaishou',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const kuaishouPublisherMetadata: PluginMetadata = {
  id: 'publisher-kuaishou',
  type: 'publisher',
  name: 'kuaishou',
  platform: 'kuaishou',
  label: KUAISHOU_PUBLISHER_METADATA.label,
  label_en: KUAISHOU_PUBLISHER_METADATA.label_en,
  version: KUAISHOU_PUBLISHER_METADATA.version,
  description: 'Video publisher plugin for Kuaishou',
  enabled: true,
}

export const kuaishouPublisher: PublisherPlugin = {
  name: 'kuaishou',
  label: KUAISHOU_PUBLISHER_METADATA.label,
  label_en: KUAISHOU_PUBLISHER_METADATA.label_en,

  getLoginUrl(): string {
    return 'https://cp.kuaishou.com/'
  },

  async publish(opts: PublishOptions): Promise<PublishResult> {
    const cookies = loadCookies('kuaishou')

    logger.info(`Kuaishou publish: "${opts.title}"`)

    return browserPublish(opts, {
      platform: 'kuaishou',
      label: '快手',
      uploadUrl: 'https://cp.kuaishou.com/article/publish/video',
      cookies,
      showWindow: getConfig().publish.show_publish_window,
      uploadWaitMs: 10000,
      fillToPublishMs: 3000,

      buildFillScript: (o) => `
        (function() {
          const title = ${JSON.stringify(o.title)};
          const desc = ${JSON.stringify(o.description || '')};
          const tags = ${JSON.stringify(o.tags || [])};

          // Fill title
          const inputs = document.querySelectorAll('input[type="text"], input[maxlength]');
          for (const input of inputs) {
            const ph = input.getAttribute('placeholder') || '';
            if (ph.includes('标题') || ph.includes('作品') || ph.includes('描述')) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(input, title);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }

          // Fill description with tags as hashtags
          const tagStr = tags.length > 0 ? '\\n' + tags.map(t => '#' + t).join(' ') : '';
          const fullDesc = desc + tagStr;
          if (fullDesc) {
            const areas = document.querySelectorAll('textarea, [contenteditable="true"]');
            for (const el of areas) {
              if (el.tagName === 'TEXTAREA') {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                setter.call(el, fullDesc);
                el.dispatchEvent(new Event('input', { bubbles: true }));
              } else {
                el.textContent = fullDesc;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
              break;
            }
          }
        })()
      `,

      triggerCoverUploadScript: `
        (function() {
          const btns = document.querySelectorAll('button, [role="button"], [class*="btn"], [class*="cover"], span, div');
          for (const btn of btns) {
            const text = (btn.textContent || '').trim();
            const cls = (btn.className || '').toLowerCase();
            if (/修改封面|更换封面|上传封面|edit.*cover|change.*cover/i.test(text) || /cover.*edit|cover.*change/i.test(cls)) {
              btn.click();
              return;
            }
          }
        })()
      `,

      buildPublishScript: () => `
        (function() {
          const buttons = document.querySelectorAll('button, [role="button"], [class*="btn"]');
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            if (text === '发布' || text === '发布作品' || text === '提交') {
              btn.click();
              return true;
            }
          }
          const submit = document.querySelector('button[type="submit"], [class*="publish"], [class*="submit"]');
          if (submit) { submit.click(); return true; }
          return false;
        })()
      `,

      isSuccessUrl: (url) =>
        url.includes('/manage') || url.includes('success'),
    })
  },
}
