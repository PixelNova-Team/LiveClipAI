import ipc from './client'

export interface StreamerInfo {
  streamer_id: string
  platform: string
  room_url: string
  room_id: string
  nickname: string
  avatar_url: string
  mode: 'persistent' | 'once'
  enabled: boolean
  is_live: boolean
  last_live_at: string | null
  active_task_id: string | null
  created_at: string
  updated_at: string
}

export function listStreamers() {
  return ipc.invoke<StreamerInfo[]>('streamers:list')
}

export function addStreamer(data: {
  room_url: string
  platform?: string
  mode?: 'persistent' | 'once'
}) {
  return ipc.invoke<StreamerInfo>('streamers:add', data)
}

export function updateStreamer(id: string, updates: { mode?: string; enabled?: boolean }) {
  return ipc.invoke<StreamerInfo>('streamers:update', id, updates)
}

export function deleteStreamer(id: string) {
  return ipc.invoke<{ success: boolean }>('streamers:delete', id)
}

export function pollStreamersNow() {
  return ipc.invoke<{ success: boolean }>('streamers:poll-now')
}
