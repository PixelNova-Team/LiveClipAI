export type DanmakuType = 'chat' | 'gift' | 'superchat'

export interface DanmakuMessage {
  text: string
  userName: string
  timestamp: number
  type: DanmakuType
  /** Gift name for display (e.g. "火箭", "嘉年华"). Empty for chat messages. */
  giftName: string
}

export type DanmakuCallback = (msg: DanmakuMessage) => void

export interface DanmakuCollector {
  readonly platform: string
  readonly label?: string          // Display name (optional, for metadata)
  readonly label_en?: string       // English display name (optional, for metadata)

  /** Connect to live room chat */
  connect(roomId: string, cookies?: string): Promise<void>

  /** Disconnect from live room chat */
  disconnect(): Promise<void>

  /** Register message callback */
  onMessage(cb: DanmakuCallback): void

  /** Whether currently connected */
  readonly isConnected: boolean
}
