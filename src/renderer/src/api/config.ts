import ipc from './client'

export function getAiConfig() {
  return ipc.invoke('config:get', 'ai')
}

export function getAsrConfig() {
  return ipc.invoke('config:get', 'asr')
}

export function getSliceConfig() {
  return ipc.invoke('config:get', 'slice')
}

export function getAllConfig() {
  return ipc.invoke('config:get-all')
}

export function updateConfig(data: {
  ai?: any
  asr?: any
  slice?: any
  task?: any
  storage?: any
  logging?: any
  live?: any
  publish?: any
  whisperLocalModel?: string
}) {
  return ipc.invoke('config:update', data)
}

export function getCacheStats() {
  return ipc.invoke('config:cache-stats')
}

export function clearCache(target: string, keepActive: boolean = true) {
  return ipc.invoke('config:clear-cache', { target, keep_active: keepActive })
}

export function uploadCookies(file: File) {
  // In Electron, read file content and send via IPC
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      ipc.invoke('config:upload-cookies', {
        name: file.name,
        content: reader.result
      }).then(resolve).catch(reject)
    }
    reader.onerror = reject
    reader.readAsText(file)
  })
}

export function deleteCookies() {
  return ipc.invoke('config:delete-cookies')
}

export function getCookiesStatus() {
  return ipc.invoke('config:cookies-status')
}

export function clearTaskSlices(taskId: string) {
  return ipc.invoke('config:clear-task-slices', taskId)
}

export function clearFinishedSlices() {
  return ipc.invoke('config:clear-finished-slices')
}
