import { BrowserWindow, session } from 'electron'
import { saveCookies, loadCookies, hasCookies, deleteCookies, deleteToken, loadToken, type SavedCookie } from './utils/cookies'
import { registry } from './plugins/registry'
import { getLogger } from './utils/logger'
import { mt } from './i18n'
import { getPlatformConfig } from './utils/platform-config'

const logger = getLogger('auth-manager')

interface LoginResult {
  success: boolean
  cookieCount: number
}

async function extractAndSaveCookies(
  win: BrowserWindow,
  platform: string
): Promise<SavedCookie[]> {
  const cookies = await win.webContents.session.cookies.get({})
  const savedCookies: SavedCookie[] = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '',
    path: c.path || '/',
    httpOnly: c.httpOnly,
    secure: c.secure,
    expirationDate: c.expirationDate,
  }))
  saveCookies(platform, savedCookies)
  return savedCookies
}

/** Check if platform login cookies exist in the BrowserWindow session */
async function hasLoginCookies(win: BrowserWindow, platform: string): Promise<boolean> {
  const config = getPlatformConfig(platform)
  const markers = config?.authCookieNames || []
  if (!markers?.length) {
    logger.warn(`[hasLoginCookies] No auth cookie markers defined for ${platform}`)
    return false
  }

  const domain = config?.cookieDomain
  try {
    const cookies = domain
      ? await win.webContents.session.cookies.get({ domain })
      : await win.webContents.session.cookies.get({})

    const cookieNames = new Set(cookies.map(c => c.name))
    const found = markers.filter(m => cookieNames.has(m))
    const missing = markers.filter(m => !cookieNames.has(m))

    logger.debug(`[hasLoginCookies] ${platform}: expected=${markers.join(',')}, found=${found.join(',')}, missing=${missing.join(',')}`)
    logger.debug(`[hasLoginCookies] All cookies (${domain || 'all'}): ${Array.from(cookieNames).join(',')}`)

    // For platforms with multiple markers: require ANY one to be present (some cookies might not always be set)
    // For platforms with single marker: require that one marker to be present
    // This handles different cookie persistence patterns across platforms
    if (markers.length > 1) {
      // At least one marker should be present
      const hasAny = markers.some(m => cookieNames.has(m))
      if (!hasAny) logger.info(`[hasLoginCookies] ${platform}: None of the markers present`)
      return hasAny
    } else {
      // Single marker: must be present
      return markers.every(m => cookieNames.has(m))
    }
  } catch (e) {
    logger.error(`[hasLoginCookies] Error checking ${platform}: ${e}`)
    return false
  }
}

export async function loginWithBrowser(platform: string): Promise<LoginResult> {
  const plugin = registry.getPlatform(platform)
  const loginUrl = plugin?.getLoginUrl()

  if (!loginUrl) {
    return { success: false, cookieCount: 0 }
  }

  logger.info(`Opening login window for ${platform}: ${loginUrl}`)

  // Use a persistent session partition so cookies persist across login and publish.
  // This allows the publish flow to reuse the same browser context (SSO, cookies, etc.)
  const loginSession = session.fromPartition(`persist:platform-${platform}`)

  // Clear all cookies from previous sessions to prevent false positive detection
  await loginSession.clearStorageData({ storages: ['cookies'] })
  logger.info(`Cleared previous session cookies for ${platform}`)

  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    title: mt('notify.loginTitle', { platform: plugin?.label || platform }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: loginSession,
    },
  })

  // Some platforms (e.g. Huya) redirect during page load, which causes ERR_ABORTED.
  // This is normal — the redirect completes via did-navigate, so we ignore the error.
  try {
    await win.loadURL(loginUrl)
  } catch (e: any) {
    const msg = e?.message || ''
    if (msg.includes('ERR_ABORTED') || msg.includes('-3')) {
      logger.info(`Initial load aborted for ${platform} (redirect), continuing...`)
    } else {
      logger.warn(`Login page load error for ${platform}: ${msg}`)
    }
  }

  // After page loads, run platform's onBeforeLogin hook (e.g. auto-click login button)
  win.webContents.on('did-finish-load', () => {
    const p = registry.getPlatform(platform)
    if (p?.onBeforeLogin && !win.isDestroyed()) {
      p.onBeforeLogin(win).catch((e: any) => logger.debug(`onBeforeLogin error: ${e.message}`))
    }
  })

  return new Promise<LoginResult>((resolve) => {
    let resolved = false
    let detected = false
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const cleanup = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const finishLogin = async () => {
      if (resolved) return
      resolved = true
      cleanup()

      try {
        // Visit publisher URL to complete SSO handshake for creator platforms
        // (e.g., creator.douyin.com needs its own SSO redirect after logging in on douyin.com)
        const config = getPlatformConfig(platform)
        const publisherUrl = config?.publisherSsoUrl
        if (publisherUrl && !win.isDestroyed()) {
          logger.info(`Visiting publisher URL for SSO handshake: ${publisherUrl}`)
          try {
            await win.loadURL(publisherUrl)
            // Wait for the SSO redirect chain to complete
            await new Promise<void>(r => setTimeout(r, 5000))
          } catch (e: any) {
            logger.warn(`Publisher SSO visit failed (non-critical): ${e.message}`)
          }
        }

        // Run platform-specific post-login hook (e.g. Huya token extraction)
        if (!win.isDestroyed()) {
          try {
            const plugin = registry.getPlatform(platform)
            if (plugin?.onLoginSuccess) {
              logger.info(`Running onLoginSuccess hook for ${platform}`)
              await plugin.onLoginSuccess(win)
            }
          } catch (e: any) {
            logger.warn(`onLoginSuccess hook failed for ${platform}: ${e.message}`)
          }
        }

        const savedCookies = await extractAndSaveCookies(win, platform)
        logger.info(`Login successful for ${platform}, saved ${savedCookies.length} cookies`)
        try { win.close() } catch { /* already closed */ }
        resolve({ success: true, cookieCount: savedCookies.length })
      } catch (e) {
        logger.warn(`Failed to save cookies for ${platform}:`, e)
        try { win.close() } catch { /* already closed */ }
        resolve({ success: false, cookieCount: 0 })
      }
    }

    // Poll for login cookies every 2 seconds
    pollTimer = setInterval(async () => {
      if (resolved || detected) return
      try {
        if (win.isDestroyed()) {
          cleanup()
          return
        }
        const loggedIn = await hasLoginCookies(win, platform)
        if (loggedIn) {
          detected = true  // Prevent duplicate detection
          logger.info(`Login cookies detected for ${platform}, saving in 1s...`)
          setTimeout(() => finishLogin(), 1000)
        }
      } catch {
        // window might be closed
      }
    }, 2000)

    // Log navigation for debugging
    win.webContents.on('did-navigate', (_: any, url: string) => {
      if (!resolved) logger.info(`[${platform}] navigated to: ${url}`)
    })

    // When user closes the window manually
    win.on('closed', () => {
      cleanup()
      if (!resolved) {
        resolved = true
        // If cookies were detected but finishLogin hasn't run yet,
        // we still need to save cookies — but window is already destroyed.
        // Check cookie files instead.
        if (detected) {
          logger.info(`Window closed after login detected for ${platform}, cookies should be saved`)
          resolve({ success: true, cookieCount: 0 })
        } else {
          logger.info(`Login window closed without completing login for ${platform}`)
          resolve({ success: false, cookieCount: 0 })
        }
      }
    })
  })
}

export async function getAuthStatus(platform: string): Promise<{ authenticated: boolean; platform: string }> {
  const config = getPlatformConfig(platform)
  const markers = config?.authCookieNames || []

  // Check 1: Do we have key login cookies that haven't expired?
  const cookies = loadCookies(platform)
  if (cookies.length > 0 && markers?.length) {
    const now = Date.now() / 1000
    const validCookies = cookies.filter(c => !c.expirationDate || c.expirationDate > now)
    const validNames = new Set(validCookies.map(c => c.name))

    // For multiple markers: at least one should be present
    // For single marker: that marker must be present
    const authenticated = markers.length > 1
      ? markers.some(m => validNames.has(m))
      : markers.every(m => validNames.has(m))

    if (authenticated) {
      return { authenticated: true, platform }
    }
  }

  // Check 2: Persistent session may have valid cookies (login flow saves there)
  try {
    const ses = session.fromPartition(`persist:platform-${platform}`)
    const domain = config?.cookieDomain
    const sesCookies = domain
      ? await ses.cookies.get({ domain })
      : await ses.cookies.get({})

    if (markers?.length) {
      const sesNames = new Set(sesCookies.map(c => c.name))
      const authenticated = markers.length > 1
        ? markers.some(m => sesNames.has(m))
        : markers.every(m => sesNames.has(m))

      if (authenticated) {
        return { authenticated: true, platform }
      }
    } else if (sesCookies.length >= 5) {
      return { authenticated: true, platform }
    }
  } catch (e) {
    logger.debug(`Error checking persistent session for ${platform}: ${e}`)
  }

  // Check 3: Platform-specific auth token (e.g. Huya WebSocket token)
  const tokenData = loadToken(platform)
  if (tokenData && tokenData.token.length > 50) {
    return { authenticated: true, platform }
  }

  // Neither source has valid login cookies — clean up stale cookie file
  if (cookies.length > 0) {
    deleteCookies(platform)
    logger.info(`Removed expired cookies for ${platform}`)
  }

  return { authenticated: false, platform }
}

export async function logoutPlatform(platform: string): Promise<void> {
  deleteCookies(platform)
  deleteToken(platform)
  // Also clear the persistent session partition
  try {
    const ses = session.fromPartition(`persist:platform-${platform}`)
    await ses.clearStorageData()
    logger.info(`Cleared persistent session for ${platform}`)
  } catch (e: any) {
    logger.warn(`Failed to clear session for ${platform}: ${e.message}`)
  }
  logger.info(`Logged out from ${platform}`)
}
