import ipc from './client'

export interface PublishParams {
  slice_path: string
  title: string
  description: string
  tags: string[]
  platform: string
  cover_path?: string
  platform_config?: Record<string, any>
}

export interface PlatformInfo {
  name: string
  label: string
  available: boolean
}

export function publishSlice(data: PublishParams) {
  return ipc.invoke('publish:submit', data)
}

export async function getPlatforms(): Promise<PlatformInfo[]> {
  const data = await ipc.invoke<PlatformInfo[]>('publish:platforms')
  return data.filter(p => p.available)
}

export function getPublishPlatforms() {
  return ipc.invoke<PlatformInfo[]>('publish:platforms')
}

export function publishSliceById(sliceId: string, data: { platform: string; title?: string; description?: string; tags?: string[] }) {
  return ipc.invoke('publish:by-id', { sliceId, ...data })
}

export function batchPublish(data: { slice_ids: string[]; platform: string }) {
  return ipc.invoke('publish:batch', data)
}

export function getPublishHistory(params: { page?: number; size?: number; status?: string }) {
  return ipc.invoke('publish:history', params)
}
