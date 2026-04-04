import { contextBridge, ipcRenderer } from 'electron'

/** Strip Vue reactive proxies / class instances into plain JSON-safe objects */
function toRaw(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object' && typeof obj !== 'function') return obj
  try {
    return JSON.parse(JSON.stringify(obj))
  } catch {
    return obj
  }
}

const electronAPI = {
  invoke: <T = any>(channel: string, ...args: any[]): Promise<T> => {
    // Deep-clone args to strip Vue reactive proxies before IPC send
    const safeArgs = args.map(toRaw)
    return ipcRenderer.invoke(channel, ...safeArgs)
  },
  on: (channel: string, callback: (...args: any[]) => void) => {
    const subscription = (_event: any, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  },
  once: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.once(channel, (_event, ...args) => callback(...args))
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
