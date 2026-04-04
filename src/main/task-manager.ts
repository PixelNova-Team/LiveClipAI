import { randomUUID } from 'crypto'
import { getDb } from './db'
import { getLogger } from './utils/logger'

const logger = getLogger('task-manager')

export interface TaskRow {
  task_id: string
  source_url: string
  platform: string
  task_type: string
  status: string
  title: string
  author: string
  cover_url: string
  stream_url: string
  output_dir: string
  config_json: string
  live_stats_json: string
  error_message: string
  created_at: string
  updated_at: string
}

export interface TaskInfo {
  task_id: string
  source_url: string
  platform: string
  task_type: string
  status: string
  video_meta: { title: string; author: string; cover_url: string } | null
  burst_ranges: any
  asr_results: any
  slice_results: any
  local_video_path: string | null
  stream_url: string | null
  live_stats: any
  task_config: Record<string, any>
  processing_logs: any[]
  created_at: string
  updated_at: string
  error_message: string | null
}

function rowToTaskInfo(row: TaskRow): TaskInfo {
  let liveStats = null
  try { liveStats = JSON.parse(row.live_stats_json || '{}') } catch { /* ignore */ }
  let taskConfig: Record<string, any> = {}
  try { taskConfig = JSON.parse(row.config_json || '{}') } catch { /* ignore */ }

  // Surface processing_logs from live_stats to top-level for frontend compatibility
  const processingLogs = liveStats?.processing_logs || []

  return {
    task_id: row.task_id,
    source_url: row.source_url,
    platform: row.platform,
    task_type: row.task_type,
    status: row.status,
    video_meta: row.title ? { title: row.title, author: row.author, cover_url: row.cover_url } : null,
    burst_ranges: null,
    asr_results: null,
    slice_results: null,
    local_video_path: null,
    stream_url: row.stream_url || null,
    live_stats: liveStats,
    task_config: taskConfig,
    processing_logs: processingLogs,
    created_at: row.created_at,
    updated_at: row.updated_at,
    error_message: row.error_message || null,
  }
}

/** Strip query parameters and hash fragments from a live stream URL */
function cleanLiveUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return u.origin + u.pathname
  } catch {
    return rawUrl
  }
}

export function createTask(data: {
  url: string
  platform?: string
  task_type?: string
  output_dir?: string
  config?: Record<string, any>
}): TaskInfo {
  const db = getDb()
  const taskId = randomUUID()

  db.prepare(`
    INSERT INTO tasks (task_id, source_url, platform, task_type, output_dir, config_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    cleanLiveUrl(data.url),
    data.platform || '',
    data.task_type || 'live',
    data.output_dir || '',
    JSON.stringify(data.config || {}),
  )

  logger.info(`Task created: ${taskId}`)
  return getTask(taskId)!
}

export function findActiveTaskByUrl(url: string): TaskInfo | null {
  const db = getDb()
  const cleaned = cleanLiveUrl(url)
  const row = db.prepare(
    `SELECT * FROM tasks WHERE source_url = ? AND status IN ('starting', 'recording', 'running', 'processing') LIMIT 1`
  ).get(cleaned) as TaskRow | undefined
  return row ? rowToTaskInfo(row) : null
}

export function getTask(taskId: string): TaskInfo | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined
  return row ? rowToTaskInfo(row) : null
}

export function listTasks(params: {
  status?: string
  task_type?: string
  platform?: string
  page?: number
  size?: number
}): { total: number; page: number; size: number; items: TaskInfo[] } {
  const db = getDb()
  const page = params.page || 1
  const size = params.size || 20
  const offset = (page - 1) * size

  let where = 'WHERE 1=1'
  const binds: any[] = []
  if (params.status) {
    // Support comma-separated statuses: "starting,recording,running"
    const statuses = params.status.split(',').map((s: string) => s.trim()).filter(Boolean)
    if (statuses.length === 1) {
      where += ' AND status = ?'; binds.push(statuses[0])
    } else if (statuses.length > 1) {
      where += ` AND status IN (${statuses.map(() => '?').join(',')})`; binds.push(...statuses)
    }
  }
  if (params.task_type) { where += ' AND task_type = ?'; binds.push(params.task_type) }
  if (params.platform) { where += ' AND platform = ?'; binds.push(params.platform) }

  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM tasks ${where}`).get(...binds) as any).cnt
  const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...binds, size, offset) as TaskRow[]

  return { total, page, size, items: rows.map(rowToTaskInfo) }
}

export function updateTask(taskId: string, updates: Partial<{
  status: string
  title: string
  author: string
  cover_url: string
  stream_url: string
  live_stats: any
  error_message: string
}>): void {
  const db = getDb()
  const sets: string[] = ["updated_at = datetime('now')"]
  const values: any[] = []

  if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status) }
  if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title) }
  if (updates.author !== undefined) { sets.push('author = ?'); values.push(updates.author) }
  if (updates.cover_url !== undefined) { sets.push('cover_url = ?'); values.push(updates.cover_url) }
  if (updates.stream_url !== undefined) { sets.push('stream_url = ?'); values.push(updates.stream_url) }
  if (updates.live_stats !== undefined) { sets.push('live_stats_json = ?'); values.push(JSON.stringify(updates.live_stats)) }
  if (updates.error_message !== undefined) { sets.push('error_message = ?'); values.push(updates.error_message) }

  values.push(taskId)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...values)
}

export function deleteTask(taskId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId)
  logger.info(`Task deleted: ${taskId}`)
}
