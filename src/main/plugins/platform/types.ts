export interface LiveInfo {
  roomId: string
  title: string
  author: string
  coverUrl?: string
  platform: string
}

export interface PlatformPlugin {
  readonly name: string
  readonly label: string
  readonly label_en?: string       // English display name (optional, for metadata)
  readonly icon: string

  /** Check if URL belongs to this platform */
  validateUrl(url: string): boolean

  /** Get live room info (title, author, etc.) */
  getLiveInfo(url: string): Promise<LiveInfo>

  /** Get the actual stream URL (FLV/HLS) for recording */
  getStreamUrl(url: string): Promise<string>

  /** Check if the stream is currently live */
  isLive(url: string): Promise<boolean>

  /** Login URL for this platform, null if login not needed */
  getLoginUrl(): string | null

  /** Extra HTTP headers needed for stream access */
  getHeaders(): Record<string, string>

  /**
   * Hook called after the login page finishes loading.
   * Platforms can use this to auto-click login buttons, scroll to login area, etc.
   */
  onBeforeLogin?(win: import('electron').BrowserWindow): Promise<void>

  /**
   * Hook called after browser login succeeds, before the window closes.
   * Platforms can use this for post-login tasks like extracting extra auth tokens.
   */
  onLoginSuccess?(win: import('electron').BrowserWindow): Promise<void>
}
