import ipc from './client'

export interface ProcessingLog {
  timestamp: string
  level: string
  stage: string
  message: string
}

export interface TaskInfo {
  task_id: string
  source_url: string
  platform: string
  task_type: string
  status: string
  video_meta: any
  burst_ranges: any
  asr_results: any
  slice_results: any
  local_video_path: string | null
  stream_url: string | null
  live_stats: {
    monitor_started_at?: string
    cycle?: number
    offset?: number
    total_score?: number
    threshold?: number
    danmaku_score?: number
    danmaku_acceleration?: number
    repeat_score?: number
    emotion_score?: number
    gift_score?: number
    danmaku_count?: number
    audio_excitement?: number
    audio_surge?: number
    audio_details?: {
      rms?: number
      zeroCrossingRate?: number
      spectralCentroid?: number
      loudness?: number
    }
    ai_frame_score?: number
    ai_text_score?: number
    ai_reason?: string
    resonance_bonus?: number
    state?: string
    danmaku_connected?: boolean
    has_danmaku?: boolean
    recent_danmaku?: Array<{ text: string; userName: string; timestamp: number; type?: string; giftName?: string }>
    processing_logs?: Array<{ time: string; level: string; message: string }>
  } | null
  processing_logs: ProcessingLog[]
  created_at: string
  updated_at: string
  error_message: string | null
}

export interface TaskListResponse {
  total: number
  page: number
  size: number
  items: TaskInfo[]
}

export function createTask(data: { url: string; platform?: string; output_dir?: string; task_type?: string; record_duration?: number }) {
  return ipc.invoke<TaskInfo>('tasks:create', data)
}

export function batchCreateTasks(data: { urls: string[] }) {
  return ipc.invoke('tasks:batch-create', data)
}

export function getTasks(params: { status?: string; page?: number; size?: number; task_type?: string; platform?: string }) {
  return ipc.invoke<TaskListResponse>('tasks:list', params)
}

export function getTask(taskId: string) {
  return ipc.invoke<TaskInfo>('tasks:get', taskId)
}

export function deleteTask(taskId: string) {
  return ipc.invoke('tasks:delete', taskId)
}

export function batchDeleteTasks(taskIds: string[]) {
  return ipc.invoke<{ deleted: number }>('tasks:batch-delete', taskIds)
}

export function cancelTask(taskId: string) {
  return ipc.invoke('tasks:cancel', taskId)
}

export function retryTask(taskId: string) {
  return ipc.invoke<TaskInfo>('tasks:retry', taskId)
}

export function retryDanmaku(taskId: string) {
  return ipc.invoke<{ connected: boolean }>('tasks:retry-danmaku', taskId)
}

export function getSourceVideoUrl(taskId: string) {
  // In Electron, we'll serve video via a custom protocol or local file path
  return `liveclipai://video/${taskId}/source`
}

export function getStreamProxyUrl(taskId: string) {
  return `liveclipai://stream/${taskId}`
}
