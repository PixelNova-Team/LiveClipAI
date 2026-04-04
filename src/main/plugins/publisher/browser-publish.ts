import { BrowserWindow, session } from 'electron'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import type { PublishOptions, PublishResult } from './types'
import { saveCookies } from '../../utils/cookies'
import { getFFmpegPath } from '../../ffmpeg'
import { getLogger } from '../../utils/logger'
import { mt } from '../../i18n'

const logger = getLogger('browser-publish')

export interface BrowserPublishConfig {
  platform: string
  label: string
  uploadUrl: string
  cookies: any[]
  /** Whether to show the BrowserWindow (false = background publish) */
  showWindow?: boolean
  /** CSS selector for the file input element (default: 'input[type="file"]') */
  fileInputSelector?: string
  /** JS script to click the upload trigger button (if file input is hidden behind a button click) */
  triggerUploadScript?: string
  /** Build the JS script to fill metadata (title, description, tags) */
  buildFillScript: (opts: PublishOptions) => string
  /** Build the JS script to click the publish button */
  buildPublishScript: () => string
  /** Delay (ms) after file upload before filling metadata (wait for upload to complete) */
  uploadWaitMs?: number
  /** Delay (ms) after filling metadata before clicking publish */
  fillToPublishMs?: number
  /** JS script to click the cover upload trigger (to reveal the cover file input) */
  triggerCoverUploadScript?: string
  /** CSS selector for the cover image file input */
  coverInputSelector?: string
  /** Minimum cover resolution { width, height } — image will be upscaled if smaller */
  coverMinResolution?: { width: number; height: number }
  /** Check if the current URL indicates publish success */
  isSuccessUrl?: (url: string) => boolean
  /** Extra text patterns to detect publish success (e.g. '审核中' for Douyin) */
  successTextPatterns?: string[]
  /** Overall timeout (ms) before giving up (default: 5 minutes) */
  timeoutMs?: number
}

/**
 * Shared browser-based publish flow using CDP for file upload:
 * 1. Open BrowserWindow with cookies
 * 2. Upload video file via Chrome DevTools Protocol
 * 3. Wait for upload to process
 * 4. Fill metadata (title, description, tags)
 * 5. Click publish button
 * 6. Wait for success navigation or timeout
 */
export async function browserPublish(
  opts: PublishOptions,
  config: BrowserPublishConfig,
): Promise<PublishResult> {
  if (!existsSync(opts.videoPath)) {
    return { success: false, error: mt('error.videoNotFound', { path: opts.videoPath }) }
  }

  // Use a persistent session partition shared with the login flow.
  // This avoids the need to manually load/save cookies — the browser context persists
  // across login and publish windows, including SSO redirects and session storage.
  const platformSession = session.fromPartition(`persist:platform-${config.platform}`)

  // Check if the persistent session has login cookies before opening window
  const existingCookies = await platformSession.cookies.get({})
  if (existingCookies.length < 5 && config.cookies.length === 0) {
    logger.warn(`${config.platform}: no session cookies and no saved cookies — user needs to login`)
    return { success: false, error: mt('error.notLoggedIn', { platform: config.label }) }
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,  // always create hidden, show later if needed
    title: mt('notify.publishWindowTitle', { platform: config.label, title: opts.title }),
    webPreferences: { nodeIntegration: false, contextIsolation: true, session: platformSession },
  })

  try {
    // Load saved cookies into the persistent session (supplement, not replace).
    // If the user logged in via the auth flow, the persistent session already has cookies.
    // We also load from the JSON file in case cookies were imported or the session is fresh.
    const ses = win.webContents.session
    if (existingCookies.length < 5 && config.cookies.length > 0) {
      // Session looks empty — load from saved cookie file
      let loaded = 0
      for (const c of config.cookies) {
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
      logger.info(`Loaded ${loaded} cookies into ${config.platform} session (was empty)`)
    } else {
      logger.info(`${config.platform} session has ${existingCookies.length} cookies, proceeding`)
    }

    // 2. Navigate to upload page
    await win.loadURL(config.uploadUrl)
    // Always show the window so user can see what's happening and intervene if needed
    win.show()

    // Wait for page to fully load (SPA frameworks need more time to render)
    await waitForPageReady(win, 5000)

    // Check if we got redirected to a login page (session expired / cookies invalid).
    // If so, wait for the user to login in this window, then navigate back to the upload page.
    const currentUrl = win.webContents.getURL()
    if (isLoginPage(currentUrl)) {
      logger.info(`${config.platform}: redirected to login page, waiting for user to login...`)
      await waitForLogin(win, config.platform, config.uploadUrl)
      // After login redirect, wait for page to load
      await waitForPageReady(win, 5000)
    }

    // Wait extra time for SPA framework to render upload components
    await delay(3000)

    // 2.5. Click upload trigger button if needed (some platforms require clicking
    //       an "upload" button before the <input type="file"> element appears)
    if (config.triggerUploadScript) {
      logger.info(`${config.platform}: triggering upload area...`)
      await win.webContents.executeJavaScript(config.triggerUploadScript).catch(() => {})
      await delay(3000)
    }

    // 3. Upload video file via CDP
    logger.info(`${config.platform}: uploading video via CDP...`)
    const uploadOk = await uploadFileViaCDP(
      win,
      opts.videoPath,
      config.fileInputSelector || 'input[type="file"]',
    )
    if (!uploadOk) {
      logger.warn(`${config.platform}: CDP file upload failed, window shown for manual operation`)
      // Window is already visible — user can manually upload and publish.
      // Just wait for success navigation or window close.
      const timeoutMs = config.timeoutMs ?? 300000
      const isSuccess = config.isSuccessUrl || (() => false)
      return await waitForPublishResult(win, config.platform, isSuccess, timeoutMs, config.successTextPatterns)
    }

    logger.info(`${config.platform}: video file set on input, waiting for upload to process...`)

    // 4. Wait for upload to process (platform needs time to upload/transcode)
    const uploadWait = config.uploadWaitMs ?? 8000
    await delay(uploadWait)

    // Poll for upload completion (check for progress indicators disappearing)
    await waitForUploadComplete(win, 60000)

    // 5. Fill metadata
    logger.info(`${config.platform}: filling metadata...`)
    const fillScript = config.buildFillScript(opts)
    await win.webContents.executeJavaScript(fillScript).catch(() => {})
    // Retry fill after a short delay (some platforms render fields lazily)
    await delay(2000)
    await win.webContents.executeJavaScript(fillScript).catch(() => {})

    // 5.5. Upload cover image if provided
    if (opts.coverPath && existsSync(opts.coverPath)) {
      logger.info(`${config.platform}: uploading cover image...`)
      // Ensure cover meets minimum resolution requirement
      let coverFile = opts.coverPath
      if (config.coverMinResolution) {
        const resized = ensureCoverResolution(opts.coverPath, config.coverMinResolution.width, config.coverMinResolution.height)
        if (resized) coverFile = resized
      }
      // Click cover upload trigger if needed
      if (config.triggerCoverUploadScript) {
        await win.webContents.executeJavaScript(config.triggerCoverUploadScript).catch(() => {})
        await delay(2000)
      }
      const coverSelector = config.coverInputSelector || 'input[type="file"][accept*="image"]'
      const coverOk = await uploadCoverViaCDP(win, coverFile, coverSelector)
      if (coverOk) {
        logger.info(`${config.platform}: cover image uploaded`)
        await delay(3000) // Wait for cover to process
      } else {
        logger.warn(`${config.platform}: cover upload failed, platform will use auto-generated cover`)
      }
    }

    // 6. Wait a bit then click publish
    const fillToPublish = config.fillToPublishMs ?? 3000
    await delay(fillToPublish)

    logger.info(`${config.platform}: clicking publish button...`)
    const publishScript = config.buildPublishScript()
    await win.webContents.executeJavaScript(publishScript).catch(() => {})
    // Retry publish click after delay
    await delay(3000)
    await win.webContents.executeJavaScript(publishScript).catch(() => {})

    // 7. Wait for success navigation or timeout
    const timeoutMs = config.timeoutMs ?? 300000 // 5 minutes
    const isSuccess = config.isSuccessUrl || (() => false)

    return await waitForPublishResult(win, config.platform, isSuccess, timeoutMs, config.successTextPatterns)
  } catch (e: any) {
    logger.error(`${config.platform} publish error: ${e.message}`)
    if (!win.isDestroyed()) win.close()
    return { success: false, error: mt('error.publishError', { platform: config.label, message: e.message }) }
  }
}

/**
 * Upload a file to an <input type="file"> element using Chrome DevTools Protocol.
 * This bypasses the native file dialog — the file is set programmatically.
 * Retries multiple times as the file input may render lazily.
 */
async function uploadFileViaCDP(
  win: BrowserWindow,
  filePath: string,
  selector: string,
): Promise<boolean> {
  // Retry up to 8 times with increasing delays (SPA pages can take a while to render upload components)
  const delays = [0, 2000, 3000, 4000, 5000, 5000, 5000, 5000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (win.isDestroyed()) return false
    if (delays[attempt] > 0) {
      logger.info(`CDP upload attempt ${attempt + 1}/${delays.length}, waiting ${delays[attempt]}ms...`)
      await delay(delays[attempt])
    }

    const dbg = win.webContents.debugger
    try {
      dbg.attach('1.3')

      // Get full document tree (depth -1 to include iframes/shadow DOM)
      const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true })

      // Try multiple selectors — platforms use different file input patterns
      const selectors = [
        selector,
        'input[type="file"]',
        'input[accept*="video"]',
        'input[accept*="mp4"]',
        'input[accept*="*"]',
      ]
      let targetNodeId = 0

      for (const sel of selectors) {
        try {
          const result = await dbg.sendCommand('DOM.querySelectorAll', {
            nodeId: root.nodeId,
            selector: sel,
          })
          if (result.nodeIds?.length > 0) {
            targetNodeId = result.nodeIds[0]
            logger.info(`Found file input with selector: ${sel} (nodeId=${targetNodeId})`)
            break
          }
        } catch { /* selector may be invalid for this DOM */ }
      }

      if (!targetNodeId) {
        // Try to find any input element (some platforms hide the type attribute)
        try {
          const allInputs = await dbg.sendCommand('DOM.querySelectorAll', {
            nodeId: root.nodeId,
            selector: 'input',
          })
          if (allInputs.nodeIds?.length > 0) {
            // Check each input's attributes to find a file input
            for (const nid of allInputs.nodeIds) {
              try {
                const attrs = await dbg.sendCommand('DOM.getAttributes', { nodeId: nid })
                const attrMap: Record<string, string> = {}
                for (let i = 0; i < (attrs.attributes?.length || 0); i += 2) {
                  attrMap[attrs.attributes[i]] = attrs.attributes[i + 1]
                }
                if (attrMap.type === 'file' || attrMap.accept) {
                  targetNodeId = nid
                  logger.info(`Found file input via attribute scan (type=${attrMap.type}, accept=${attrMap.accept})`)
                  break
                }
              } catch { /* node may have been removed */ }
            }
          }
        } catch { /* ignore */ }
      }

      if (!targetNodeId) {
        dbg.detach()
        // On the last few attempts, try clicking the upload area again to trigger input creation
        if (attempt >= 3) {
          await win.webContents.executeJavaScript(`
            (function() {
              // Click anything that looks like an upload trigger
              const triggers = document.querySelectorAll(
                '[class*="upload"], [class*="drag"], [class*="drop"], ' +
                'button, [role="button"]'
              );
              for (const t of triggers) {
                const text = (t.textContent || '').trim();
                const cls = t.className || '';
                if (/upload|上传|选择|拖拽|drag/i.test(text + cls)) {
                  const style = window.getComputedStyle(t);
                  if (style.display !== 'none' && style.visibility !== 'hidden') {
                    t.click();
                    break;
                  }
                }
              }
            })()
          `).catch(() => {})
        }
        continue // retry
      }

      // Set files via CDP — this triggers the native 'change' event in Chromium
      await dbg.sendCommand('DOM.setFileInputFiles', {
        nodeId: targetNodeId,
        files: [filePath],
      })

      // Also dispatch change/input events via JS to ensure React/Vue frameworks detect it
      dbg.detach()
      await win.webContents.executeJavaScript(`
        (function() {
          const inputs = document.querySelectorAll('input[type="file"], input[accept]');
          for (const input of inputs) {
            if (input.files && input.files.length > 0) {
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
        })()
      `).catch(() => {})

      return true
    } catch (e: any) {
      logger.warn(`CDP file upload attempt ${attempt + 1} failed: ${e.message}`)
      try { dbg.detach() } catch { /* already detached */ }
    }
  }

  logger.warn('All CDP upload attempts failed')
  return false
}

/** Wait for the page's DOMContentLoaded + additional delay */
async function waitForPageReady(win: BrowserWindow, extraMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const check = () => {
      if (win.isDestroyed()) { resolve(); return }
      win.webContents.executeJavaScript('document.readyState')
        .then((state) => {
          if (state === 'complete') resolve()
          else setTimeout(check, 500)
        })
        .catch(() => setTimeout(check, 500))
    }
    check()
  })
  await delay(extraMs)
}

/** Poll until upload progress indicators disappear (or timeout) */
async function waitForUploadComplete(win: BrowserWindow, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (win.isDestroyed()) return
    try {
      // Check for common upload progress indicators
      const stillUploading = await win.webContents.executeJavaScript(`
        (function() {
          // Look for progress bars, percentage text, uploading indicators
          const progressEls = document.querySelectorAll(
            '[class*="progress"], [class*="upload"][class*="ing"], [class*="loading"]'
          );
          for (const el of progressEls) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null) {
              const text = el.textContent || '';
              // If we find a percentage < 100%, still uploading
              const pctMatch = text.match(/(\\d+)\\s*%/);
              if (pctMatch && parseInt(pctMatch[1]) < 100) return true;
              // If element has "uploading" related class and is visible
              if (el.className && /upload.*ing|progress/i.test(el.className)) return true;
            }
          }
          return false;
        })()
      `)
      if (!stillUploading) {
        logger.info('Upload appears complete (no progress indicators found)')
        return
      }
      logger.debug('Upload still in progress...')
    } catch { /* page might be navigating */ }
    await delay(3000)
  }
  logger.warn('Upload wait timed out, proceeding anyway')
}

/** Wait for publish success via navigation or window close */
function waitForPublishResult(
  win: BrowserWindow,
  platform: string,
  isSuccessUrl: (url: string) => boolean,
  timeoutMs: number,
  extraSuccessTexts?: string[],
): Promise<PublishResult> {
  return new Promise<PublishResult>((resolve) => {
    let resolved = false
    const done = (result: PublishResult) => {
      if (resolved) return
      resolved = true
      // Force destroy the window
      try { if (!win.isDestroyed()) win.destroy() } catch { /* ignore */ }
      resolve(result)
    }

    // Listen for success navigation
    win.webContents.on('did-navigate', (_: any, url: string) => {
      if (isSuccessUrl(url)) {
        logger.info(`${platform}: detected success navigation to ${url}`)
        done({ success: true })
      }
    })

    win.webContents.on('did-navigate-in-page', (_: any, url: string) => {
      if (isSuccessUrl(url)) {
        logger.info(`${platform}: detected in-page success navigation to ${url}`)
        done({ success: true })
      }
    })

    // Also poll for success indicators in the page content
    const allPatterns = JSON.stringify([
      ...(extraSuccessTexts || []),
      '发布成功', '上传成功', '投稿成功', '作品已发布',
    ])
    const pollSuccess = setInterval(async () => {
      if (win.isDestroyed() || resolved) { clearInterval(pollSuccess); return }
      try {
        const success = await win.webContents.executeJavaScript(`
          (function() {
            const patterns = ${allPatterns};
            const body = document.body?.innerText || '';
            for (const p of patterns) {
              if (body.includes(p)) return true;
            }
            // Check toasts, modals, dialogs
            const els = document.querySelectorAll(
              '[class*="success"], [class*="toast"], [class*="message"], ' +
              '[class*="modal"], [class*="dialog"], [class*="notice"], [class*="tip"], [class*="result"]'
            );
            for (const t of els) {
              const text = (t.textContent || '').trim();
              for (const p of patterns) {
                if (text.includes(p)) return true;
              }
            }
            return false;
          })()
        `)
        if (success) {
          clearInterval(pollSuccess)
          logger.info(`${platform}: detected success indicator in page`)
          done({ success: true })
        }
      } catch { /* ignore */ }
    }, 3000)

    // Window closed by user — treat as cancelled, NOT success
    win.on('closed', () => {
      clearInterval(pollSuccess)
      if (!resolved) {
        resolved = true
        logger.info(`${platform}: publish window closed by user (no success detected)`)
        resolve({ success: false, error: 'cancelled' })
      }
    })

    // Overall timeout
    setTimeout(() => {
      clearInterval(pollSuccess)
      if (!resolved) {
        logger.warn(`${platform}: publish timed out after ${timeoutMs / 1000}s`)
        done({ success: false, error: mt('error.publishTimeout', { seconds: timeoutMs / 1000 }) })
      }
    }, timeoutMs)
  })
}

/**
 * Ensure a cover image meets minimum resolution requirements.
 * If the image is too small, upscale it using ffmpeg.
 * Returns the path to the resized image, or null if no resize needed or ffmpeg failed.
 */
function ensureCoverResolution(coverPath: string, minWidth: number, minHeight: number): string | null {
  try {
    const ffmpegPath = getFFmpegPath()
    // Get current image dimensions using ffprobe
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1')
    const probe = spawnSync(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', coverPath,
    ], { encoding: 'utf8', timeout: 5000 })
    const dims = (probe.stdout || '').trim().split(',')
    const w = parseInt(dims[0]) || 0
    const h = parseInt(dims[1]) || 0

    if (w >= minWidth && h >= minHeight) {
      logger.info(`Cover ${w}x${h} meets minimum ${minWidth}x${minHeight}`)
      return null // no resize needed
    }

    logger.info(`Cover ${w}x${h} too small, upscaling to meet ${minWidth}x${minHeight}`)
    const outPath = join(tmpdir(), `cover_resized_${Date.now()}.jpg`)
    // Scale up to meet minimum while maintaining aspect ratio, then pad if needed
    const result = spawnSync(ffmpegPath, [
      '-y', '-i', coverPath,
      '-vf', `scale='max(${minWidth},iw)':'max(${minHeight},ih)':force_original_aspect_ratio=increase,crop=${minWidth}:${minHeight}`,
      '-q:v', '2', outPath,
    ], { encoding: 'utf8', timeout: 15000 })

    if (result.status === 0 && existsSync(outPath)) {
      logger.info(`Cover resized to ${minWidth}x${minHeight}: ${outPath}`)
      return outPath
    }
    logger.warn(`Cover resize failed: ${result.stderr?.slice(0, 200)}`)
    return null
  } catch (e: any) {
    logger.warn(`Cover resize error: ${e.message}`)
    return null
  }
}

/**
 * Upload a cover image to an <input type="file"> element using CDP.
 * Searches for image-accepting file inputs (separate from video inputs).
 */
async function uploadCoverViaCDP(
  win: BrowserWindow,
  coverPath: string,
  selector: string,
): Promise<boolean> {
  const delays = [0, 2000, 3000, 4000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (win.isDestroyed()) return false
    if (delays[attempt] > 0) await delay(delays[attempt])

    const dbg = win.webContents.debugger
    try {
      dbg.attach('1.3')
      const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true })

      // Try the provided selector and common image input selectors
      const selectors = [
        selector,
        'input[type="file"][accept*="image"]',
        'input[type="file"][accept*="jpg"]',
        'input[type="file"][accept*="png"]',
      ]
      let targetNodeId = 0

      for (const sel of selectors) {
        try {
          const result = await dbg.sendCommand('DOM.querySelectorAll', {
            nodeId: root.nodeId,
            selector: sel,
          })
          if (result.nodeIds?.length > 0) {
            // If there are multiple file inputs, pick the one that's NOT the video input
            // (video input was already used, so it has files set)
            for (const nid of result.nodeIds) {
              targetNodeId = nid
              break
            }
            if (targetNodeId) {
              logger.info(`Found cover input with selector: ${sel}`)
              break
            }
          }
        } catch { /* skip */ }
      }

      if (!targetNodeId) {
        dbg.detach()
        continue
      }

      await dbg.sendCommand('DOM.setFileInputFiles', {
        nodeId: targetNodeId,
        files: [coverPath],
      })
      dbg.detach()

      // Dispatch change event
      await win.webContents.executeJavaScript(`
        (function() {
          const inputs = document.querySelectorAll('input[type="file"][accept*="image"], input[type="file"][accept*="jpg"], input[type="file"][accept*="png"]');
          for (const input of inputs) {
            if (input.files && input.files.length > 0) {
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
        })()
      `).catch(() => {})

      return true
    } catch (e: any) {
      logger.warn(`Cover CDP upload attempt ${attempt + 1} failed: ${e.message}`)
      try { dbg.detach() } catch { /* already detached */ }
    }
  }
  return false
}

/** Check if a URL is a login/SSO page (not the upload page) */
function isLoginPage(url: string): boolean {
  const loginPatterns = [
    /sso\./i,
    /login/i,
    /signin/i,
    /passport/i,
    /accounts\.google/i,
    /扫码登录/i,
  ]
  // Also check: if the URL doesn't contain upload/publish/content paths, it's likely a redirect
  const isUploadPage = /upload|publish|content|article/i.test(url)
  if (isUploadPage) return false
  return loginPatterns.some(p => p.test(url))
}

/** Wait for the user to login in the publish window, then navigate back to the upload page */
function waitForLogin(
  win: BrowserWindow,
  platform: string,
  uploadUrl: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (win.isDestroyed()) { resolve(); return }

    const checkInterval = setInterval(async () => {
      if (win.isDestroyed()) {
        clearInterval(checkInterval)
        resolve()
        return
      }
      const url = win.webContents.getURL()
      // If we navigated away from the login page (login succeeded), go to upload page
      if (!isLoginPage(url)) {
        clearInterval(checkInterval)
        logger.info(`${platform}: login completed (now at ${url}), saving cookies and navigating to upload page...`)
        // Save cookies to JSON file so next publish doesn't need login again
        try {
          const cookies = await win.webContents.session.cookies.get({})
          saveCookies(platform, cookies.map(c => ({
            name: c.name, value: c.value, domain: c.domain || '',
            path: c.path || '/', httpOnly: c.httpOnly, secure: c.secure,
            expirationDate: c.expirationDate,
          })))
        } catch { /* ignore */ }
        try {
          await win.loadURL(uploadUrl)
        } catch { /* ignore navigation errors */ }
        resolve()
      }
    }, 2000)

    // Timeout after 5 minutes — give up waiting for login
    setTimeout(() => {
      clearInterval(checkInterval)
      logger.warn(`${platform}: login wait timed out`)
      resolve()
    }, 300000)

    // If window is closed, stop waiting
    win.on('closed', () => {
      clearInterval(checkInterval)
      resolve()
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
