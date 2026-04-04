import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'

function getCookieDir(): string {
  let dir: string
  try {
    dir = join(app.getPath('userData'), 'platform_cookies')
  } catch {
    dir = join(process.cwd(), 'platform_cookies')
  }
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getCookiePath(platform: string): string {
  return join(getCookieDir(), `${platform}.json`)
}

export interface SavedCookie {
  name: string
  value: string
  domain: string
  path: string
  httpOnly?: boolean
  secure?: boolean
  expirationDate?: number
}

export function saveCookies(platform: string, cookies: SavedCookie[]): void {
  const path = getCookiePath(platform)
  writeFileSync(path, JSON.stringify(cookies, null, 2), 'utf-8')
}

export function loadCookies(platform: string): SavedCookie[] {
  const path = getCookiePath(platform)
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return []
  }
}

export function hasCookies(platform: string): boolean {
  const path = getCookiePath(platform)
  return existsSync(path)
}

export function deleteCookies(platform: string): void {
  const path = getCookiePath(platform)
  if (existsSync(path)) unlinkSync(path)
}

/** Convert saved cookies to a cookie header string */
export function cookiesToString(cookies: SavedCookie[], domain?: string): string {
  const filtered = domain
    ? cookies.filter(c => domain.endsWith(c.domain.replace(/^\./, '')))
    : cookies
  return filtered.map(c => `${c.name}=${c.value}`).join('; ')
}

// --- Platform auth token storage (for platforms that need extra tokens beyond cookies) ---

function getTokenPath(platform: string): string {
  return join(getCookieDir(), `${platform}_token.json`)
}

export interface PlatformToken {
  token: string
  extractedAt: number  // unix ms
}

export function saveToken(platform: string, token: string): void {
  const data: PlatformToken = { token, extractedAt: Date.now() }
  writeFileSync(getTokenPath(platform), JSON.stringify(data), 'utf-8')
}

export function loadToken(platform: string): PlatformToken | null {
  const path = getTokenPath(platform)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

export function deleteToken(platform: string): void {
  const path = getTokenPath(platform)
  if (existsSync(path)) unlinkSync(path)
}
