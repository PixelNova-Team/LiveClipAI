import ipc from './client'

export interface QRCodeResult {
  platform: string
  url: string
  qrcode_key?: string
  token?: string
  qr_image_base64?: string
  qr_login_token?: string
  qr_login_signature?: string
}

export interface PollResult {
  status: 'waiting' | 'scanned' | 'expired' | 'success'
  platform: string
}

export interface AuthStatus {
  authenticated: boolean
  platform: string
}

export function loginWithBrowser(platform: string) {
  // Opens a BrowserWindow for the platform login
  return ipc.invoke<{ success: boolean; cookieCount: number }>('auth:login', platform)
}

export function generateQRCode(platform: string) {
  return ipc.invoke<QRCodeResult>('auth:qrcode-generate', platform)
}

export function pollQRCode(platform: string, params: Record<string, string>) {
  return ipc.invoke<PollResult>('auth:qrcode-poll', { platform, ...params })
}

export function getAuthStatus(platform: string) {
  return ipc.invoke<AuthStatus>('auth:status', platform)
}

export function importCookies(platform: string, cookieText: string) {
  return ipc.invoke<{ cookies_imported: number }>('auth:import-cookies', { platform, cookie_text: cookieText })
}

export function confirmQRLogin(platform: string) {
  return ipc.invoke<PollResult>('auth:qrcode-confirm', platform)
}

export function logout(platform: string) {
  return ipc.invoke('auth:logout', platform)
}
