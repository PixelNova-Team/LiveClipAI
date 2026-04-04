import { ElMessage } from 'element-plus'

declare global {
  interface Window {
    electronAPI: {
      invoke: <T = any>(channel: string, ...args: any[]) => Promise<T>
      on: (channel: string, callback: (...args: any[]) => void) => () => void
      once: (channel: string, callback: (...args: any[]) => void) => void
    }
  }
}

const ipc = {
  async invoke<T = any>(channel: string, ...args: any[]): Promise<T> {
    try {
      // Deep-clone args to strip Vue reactive proxies BEFORE contextBridge boundary
      // contextBridge uses structured clone which cannot handle Proxy objects
      const safeArgs = args.map(a => {
        if (a === null || a === undefined || typeof a !== 'object') return a
        try { return JSON.parse(JSON.stringify(a)) } catch { return a }
      })
      console.log(`[IPC] invoke: ${channel}`, safeArgs)
      const result = await window.electronAPI.invoke<T>(channel, ...safeArgs)
      console.log(`[IPC] result: ${channel}`, result)
      return result
    } catch (error: any) {
      const msg = error.message || 'IPC call failed'
      console.error(`[IPC] ERROR on ${channel}:`, msg, error)
      ElMessage.error(`${channel}: ${msg}`)
      throw error
    }
  },

  on(channel: string, callback: (...args: any[]) => void) {
    return window.electronAPI.on(channel, callback)
  }
}

export default ipc
