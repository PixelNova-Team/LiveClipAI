import { randomUUID } from 'crypto'
import { getDb } from './db'
import { getLogger } from './utils/logger'
import { mt } from './i18n'

const logger = getLogger('streamer-manager')

export interface StreamerRow {
  streamer_id: string
  platform: string
  room_url: string
  room_id: string
  nickname: string
  avatar_url: string
  mode: string
  enabled: number
  is_live: number
  last_live_at: string
  active_task_id: string
  created_at: string
  updated_at: string
}

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

function rowToInfo(row: StreamerRow): StreamerInfo {
  return {
    ...row,
    mode: row.mode as 'persistent' | 'once',
    enabled: row.enabled === 1,
    is_live: row.is_live === 1,
    last_live_at: row.last_live_at || null,
    active_task_id: row.active_task_id || null,
  }
}

export function addStreamer(data: {
  platform: string
  room_url: string
  room_id?: string
  nickname?: string
  avatar_url?: string
  mode?: 'persistent' | 'once'
}): StreamerInfo {
  const db = getDb()
  const id = randomUUID()

  const existing = db.prepare('SELECT streamer_id FROM streamers WHERE room_url = ?').get(data.room_url)
  if (existing) {
    throw new Error(mt('error.duplicateStreamer'))
  }

  db.prepare(`
    INSERT INTO streamers (streamer_id, platform, room_url, room_id, nickname, avatar_url, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.platform, data.room_url, data.room_id || '', data.nickname || '', data.avatar_url || '', data.mode || 'persistent')

  logger.info(`Streamer added: ${id} (${data.platform} ${data.room_url})`)
  return getStreamer(id)!
}

export function getStreamer(id: string): StreamerInfo | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM streamers WHERE streamer_id = ?').get(id) as StreamerRow | undefined
  return row ? rowToInfo(row) : null
}

export function listStreamers(): StreamerInfo[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM streamers ORDER BY created_at DESC').all() as StreamerRow[]
  return rows.map(rowToInfo)
}

export function getEnabledStreamers(): StreamerInfo[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM streamers WHERE enabled = 1 ORDER BY created_at DESC').all() as StreamerRow[]
  return rows.map(rowToInfo)
}

export function updateStreamer(id: string, updates: Partial<{
  mode: string
  enabled: boolean
  is_live: boolean
  nickname: string
  avatar_url: string
  last_live_at: string
  active_task_id: string | null
}>): void {
  const db = getDb()
  const sets: string[] = ["updated_at = datetime('now')"]
  const values: any[] = []

  if (updates.mode !== undefined) { sets.push('mode = ?'); values.push(updates.mode) }
  if (updates.enabled !== undefined) { sets.push('enabled = ?'); values.push(updates.enabled ? 1 : 0) }
  if (updates.is_live !== undefined) { sets.push('is_live = ?'); values.push(updates.is_live ? 1 : 0) }
  if (updates.nickname !== undefined) { sets.push('nickname = ?'); values.push(updates.nickname) }
  if (updates.avatar_url !== undefined) { sets.push('avatar_url = ?'); values.push(updates.avatar_url) }
  if (updates.last_live_at !== undefined) { sets.push('last_live_at = ?'); values.push(updates.last_live_at) }
  if (updates.active_task_id !== undefined) { sets.push('active_task_id = ?'); values.push(updates.active_task_id || '') }

  values.push(id)
  db.prepare(`UPDATE streamers SET ${sets.join(', ')} WHERE streamer_id = ?`).run(...values)
}

export function deleteStreamer(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM streamers WHERE streamer_id = ?').run(id)
  logger.info(`Streamer deleted: ${id}`)
}
