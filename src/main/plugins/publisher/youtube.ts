import type { PublisherPlugin, PublishOptions, PublishResult } from './types'
import type { PluginMetadata } from '../types/metadata'
import { loadCookies } from '../../utils/cookies'
import { getConfig } from '../../config'
import { browserPublish } from './browser-publish'
import { getLogger } from '../../utils/logger'

const logger = getLogger('publisher.youtube')

// Metadata for plugin discovery
export const YOUTUBE_PUBLISHER_METADATA = {
  label: 'YouTube',
  label_en: 'YouTube',
  version: '1.0.0',
}

// Metadata export for plugin manager
export const youtubePublisherMetadata: PluginMetadata = {
  id: 'publisher-youtube',
  type: 'publisher',
  name: 'youtube',
  platform: 'youtube',
  label: YOUTUBE_PUBLISHER_METADATA.label,
  label_en: YOUTUBE_PUBLISHER_METADATA.label_en,
  version: YOUTUBE_PUBLISHER_METADATA.version,
  description: 'Video publisher plugin for YouTube',
  enabled: true,
}

export const youtubePublisher: PublisherPlugin = {
  name: 'youtube',
  label: YOUTUBE_PUBLISHER_METADATA.label,
  label_en: YOUTUBE_PUBLISHER_METADATA.label_en,

  getLoginUrl(): string {
    return 'https://accounts.google.com/ServiceLogin?continue=https://studio.youtube.com'
  },

  async publish(opts: PublishOptions): Promise<PublishResult> {
    const cookies = loadCookies('youtube')

    logger.info(`YouTube publish: "${opts.title}"`)

    return browserPublish(opts, {
      platform: 'youtube',
      label: 'YouTube',
      uploadUrl: 'https://studio.youtube.com/',
      cookies,
      showWindow: getConfig().publish.show_publish_window,
      uploadWaitMs: 15000,  // YouTube Studio loads slowly
      fillToPublishMs: 5000,

      buildFillScript: (o) => `
        (function() {
          const title = ${JSON.stringify(o.title)};
          const desc = ${JSON.stringify(o.description || '')};
          const tags = ${JSON.stringify(o.tags || [])};

          // YouTube Studio uses custom textbox elements
          // Title
          const titleBox = document.querySelector(
            '#textbox[aria-label*="title"], #title-textarea #textbox, ' +
            'ytcp-social-suggestions-textbox #textbox'
          );
          if (titleBox) {
            titleBox.textContent = '';
            titleBox.focus();
            document.execCommand('selectAll');
            document.execCommand('insertText', false, title);
            titleBox.dispatchEvent(new Event('input', { bubbles: true }));
          }

          // Description — append tags as hashtags
          const tagStr = tags.length > 0 ? '\\n\\n' + tags.map(t => '#' + t).join(' ') : '';
          const fullDesc = desc + tagStr;
          if (fullDesc) {
            const descBox = document.querySelector(
              '#textbox[aria-label*="description"], #description-textarea #textbox'
            );
            if (descBox) {
              descBox.textContent = '';
              descBox.focus();
              document.execCommand('selectAll');
              document.execCommand('insertText', false, fullDesc);
              descBox.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }

          // YouTube also supports tags in the "Tags" section (under "Show more")
          if (tags.length > 0) {
            // Try to expand "Show more" to reveal the tags input
            const showMore = document.querySelector('#toggle-button, [class*="show-more"]');
            if (showMore) showMore.click();
            setTimeout(() => {
              const tagsInput = document.querySelector(
                'input[aria-label*="Tags"], input[aria-label*="tags"], ' +
                '#tags-container input, [id*="tags"] input'
              );
              if (tagsInput) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(tagsInput, tags.join(', '));
                tagsInput.dispatchEvent(new Event('input', { bubbles: true }));
                tagsInput.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, 500);
          }
        })()
      `,

      buildPublishScript: () => `
        (function() {
          // YouTube Studio publish flow: multiple steps
          // Step 1: Click through "Next" buttons to reach the publish step
          function clickNext() {
            const nextBtn = document.querySelector('#next-button, ytcp-button#next-button');
            if (nextBtn) { nextBtn.click(); return true; }
            return false;
          }

          // Step 2: Select "Public" visibility if radio exists
          function selectPublic() {
            const publicRadio = document.querySelector(
              'tp-yt-paper-radio-button[name="PUBLIC"], ' +
              '#made-for-kids-options tp-yt-paper-radio-button:first-child'
            );
            if (publicRadio) publicRadio.click();
          }

          // Step 3: Click "Publish" / "Done" button
          function clickPublish() {
            const doneBtn = document.querySelector(
              '#done-button, ytcp-button#done-button, ' +
              'ytcp-button[id="done-button"]'
            );
            if (doneBtn) { doneBtn.click(); return true; }
            return false;
          }

          // Try clicking Next multiple times (YouTube has multi-step wizard)
          let step = 0;
          function advance() {
            step++;
            if (step <= 3) {
              if (clickNext()) {
                setTimeout(advance, 1500);
              } else {
                selectPublic();
                setTimeout(() => clickPublish(), 1000);
              }
            } else {
              selectPublic();
              setTimeout(() => clickPublish(), 1000);
            }
          }
          advance();
          return true;
        })()
      `,

      isSuccessUrl: (url) =>
        url.includes('/videos') || url.includes('upload_success') || url.includes('/channel/videos'),
    })
  },
}
