import ipc from './client'

export interface SliceInfo {
  slice_id: string
  task_id: string
  start_time: number
  end_time: number
  duration: number
  selected_title: string | null
  cover_text: string
  description: string
  tags: string[]
  candidate_titles: string[]
  slice_path: string
  cover_path?: string
  peak_score?: number
  source_url?: string
  platform?: string
  task_title?: string
  channel_id?: string
  created_at?: string
  ai_approved?: number | null
  ai_review_reason?: string
}

export interface SliceDateGroup {
  date: string
  slices: SliceInfo[]
}

export interface SliceSourceGroup {
  group_key: string
  group_label: string
  platform: string
  task_type: string
  total_slices: number
  dates: SliceDateGroup[]
}

export function getSlices(taskId: string) {
  return ipc.invoke<SliceInfo[]>('slices:list', taskId)
}

export function getSlicePreviewUrl(sliceId: string) {
  return `liveclipai://slice/${sliceId}/preview`
}

export function getSliceCoverUrl(sliceId: string) {
  return `liveclipai://slice/${sliceId}/cover`
}

/** Thumbnail URL (480px wide, lower quality) for list views */
export function getSliceThumbUrl(sliceId: string) {
  return `liveclipai://slice/${sliceId}/thumb`
}

export function updateSlice(sliceId: string, data: { title?: string; description?: string; ai_approved?: number | null }) {
  return ipc.invoke('slices:update', sliceId, data)
}

export function deleteSlice(sliceId: string) {
  return ipc.invoke('slices:delete', sliceId)
}

export function getAllSlices(taskType?: string) {
  return ipc.invoke<SliceInfo[]>('slices:all', taskType)
}

export function clearAllSlices() {
  return ipc.invoke('slices:clear-all')
}

export function getSlicesGrouped(taskType?: string) {
  return ipc.invoke<SliceSourceGroup[]>('slices:grouped', taskType)
}

export interface SliceDebugInfo {
  sliceId: string
  taskId: string
  startTime: number
  endTime: number
  duration: number
  subtitlePath: string
  subtitleContent: string
  logContent: string
  error?: string
}

export function getSliceDebugInfo(sliceId: string) {
  return ipc.invoke<SliceDebugInfo>('slices:debug-info', sliceId)
}

export function triggerAiReview(sliceId: string) {
  return ipc.invoke<{ success: boolean; error?: string; aiApproved?: boolean | null; title?: string }>('slices:ai-review', sliceId)
}
