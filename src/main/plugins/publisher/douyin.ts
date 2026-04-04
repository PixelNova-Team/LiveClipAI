import type { PublisherPlugin, PublishOptions, PublishResult } from './types'
import type { PluginMetadata } from '../types/metadata'
import { loadCookies } from '../../utils/cookies'
import { getConfig } from '../../config'
import { browserPublish } from './browser-publish'
import { getLogger } from '../../utils/logger'
import { mt } from '../../i18n'

const logger = getLogger('publisher.douyin')

// Metadata for plugin discovery
export const DOUYIN_PUBLISHER_METADATA = {
  label: '抖音',
  label_en: 'Douyin',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const douyinPublisherMetadata: PluginMetadata = {
  id: 'publisher-douyin',
  type: 'publisher',
  name: 'douyin',
  platform: 'douyin',
  label: DOUYIN_PUBLISHER_METADATA.label,
  label_en: DOUYIN_PUBLISHER_METADATA.label_en,
  version: DOUYIN_PUBLISHER_METADATA.version,
  description: 'Video publisher plugin for Douyin',
  enabled: true,
}

export const douyinPublisher: PublisherPlugin = {
  name: 'douyin',
  label: DOUYIN_PUBLISHER_METADATA.label,
  label_en: DOUYIN_PUBLISHER_METADATA.label_en,

  getLoginUrl(): string {
    return 'https://creator.douyin.com/'
  },

  async publish(opts: PublishOptions): Promise<PublishResult> {
    const cookies = loadCookies('douyin')
    // Don't reject here if cookie file is empty — the persistent session may have cookies
    // from the login flow. browserPublish will check the session and cookie file together.

    logger.info(`Douyin publish: "${opts.title}"`)

    return browserPublish(opts, {
      platform: 'douyin',
      label: '抖音',
      uploadUrl: 'https://creator.douyin.com/creator-micro/content/upload',
      cookies,
      showWindow: getConfig().publish.show_publish_window,
      uploadWaitMs: 10000,
      fillToPublishMs: 3000,
      coverMinResolution: { width: 1000, height: 752 },

      // Douyin creator may require clicking the upload area before file input appears
      triggerUploadScript: `
        (function() {
          // Click any visible upload button/area to trigger the file input
          const triggers = document.querySelectorAll(
            '[class*="upload"] button, [class*="upload-btn"], ' +
            'button[class*="upload"], [class*="drag-area"], [class*="uploader"]'
          );
          for (const t of triggers) {
            const style = window.getComputedStyle(t);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              t.click();
              return;
            }
          }
        })()
      `,

      buildFillScript: (o) => `
        (function() {
          const title = ${JSON.stringify(o.title)};
          const desc = ${JSON.stringify(o.description || '')};
          const tags = ${JSON.stringify(o.tags || [])};

          // 1. Fill title — input with placeholder "填写作品标题" or maxlength=30
          const titleInput = document.querySelector(
            'input[placeholder*="标题"], input[placeholder*="作品"], input[maxlength="30"]'
          );
          if (titleInput) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(titleInput, title.slice(0, 30));
            titleInput.dispatchEvent(new Event('input', { bubbles: true }));
            titleInput.dispatchEvent(new Event('change', { bubbles: true }));
            titleInput.dispatchEvent(new Event('blur', { bubbles: true }));
          }

          // 2. Fill description — contenteditable or textarea with placeholder "添加作品简介"
          const descAreas = document.querySelectorAll(
            '[contenteditable="true"], textarea'
          );
          for (const el of descAreas) {
            const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
            const text = (el.textContent || '').trim();
            // Match the description area (not the title input, not the tag input)
            if (ph.includes('简介') || ph.includes('描述') || ph.includes('说点什么') ||
                (el.getAttribute('contenteditable') === 'true' && !ph.includes('标题') && !ph.includes('话题') && text === '')) {
              if (el.tagName === 'TEXTAREA') {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                setter.call(el, desc);
                el.dispatchEvent(new Event('input', { bubbles: true }));
              } else {
                el.focus();
                // Use execCommand to trigger framework reactivity
                document.execCommand('selectAll');
                document.execCommand('insertText', false, desc);
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
              break;
            }
          }

          // 3. Fill tags — find the "#添加话题" area and type each tag
          if (tags.length > 0) {
            // Look for the topic/hashtag input area
            const tagAreas = document.querySelectorAll(
              '[contenteditable="true"], input[placeholder*="话题"], input[placeholder*="标签"]'
            );
            for (const el of tagAreas) {
              const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
              const text = (el.textContent || el.value || '').trim();
              if (ph.includes('话题') || ph.includes('标签') || text.includes('#添加话题') || text.includes('添加话题')) {
                el.focus();
                // Type each tag as "#tagname " to trigger Douyin's tag suggestion
                for (const tag of tags) {
                  document.execCommand('insertText', false, '#' + tag + ' ');
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                break;
              }
            }

            // Fallback: click recommended tag buttons if they match our tags
            const tagBtns = document.querySelectorAll('[class*="recommend"] [class*="tag"], [class*="topic"] [class*="item"]');
            for (const btn of tagBtns) {
              const btnText = (btn.textContent || '').replace('#', '').trim();
              if (tags.some(t => btnText.includes(t) || t.includes(btnText))) {
                btn.click();
              }
            }
          }
        })()
      `,

      triggerCoverUploadScript: `
        (function() {
          // Click "选择封面" button (横封面4:3) to reveal the cover file input
          const btns = document.querySelectorAll('button, [role="button"], [class*="btn"], [class*="cover"], span, div, a');
          for (const btn of btns) {
            const text = (btn.textContent || '').trim();
            const cls = (btn.className || '').toLowerCase();
            if (/选择封面|修改封面|更换封面|上传封面/i.test(text) || /cover.*select|cover.*upload|cover.*change/i.test(cls)) {
              const style = window.getComputedStyle(btn);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                btn.click();
                return;
              }
            }
          }
        })()
      `,

      buildPublishScript: () => `
        (function() {
          // Find publish button — Douyin creator uses "发布" button
          const buttons = document.querySelectorAll('button, [role="button"], [class*="btn"]');
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            if (text === '发布' || text === '发布作品' || text === '立即发布') {
              btn.click();
              return true;
            }
          }
          // Fallback: try submit buttons
          const submit = document.querySelector('button[type="submit"], .submit-btn, [class*="publish"]');
          if (submit) { submit.click(); return true; }
          return false;
        })()
      `,

      isSuccessUrl: (url) =>
        url.includes('/manage') || url.includes('success') ||
        url.includes('/content/manage') || url.includes('/content/upload?result='),

      // Douyin shows "审核中" after clicking publish — that counts as success
      successTextPatterns: ['发布成功', '审核中', '审核', '投稿成功', '作品已发布'],
    })
  },
}
