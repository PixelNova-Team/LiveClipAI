import { Notification, BrowserWindow, nativeImage, app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { getDb } from './db'
import { getLogger } from './utils/logger'

const logger = getLogger('notification')

export interface AppNotification {
  id: number
  type: 'slice' | 'publish' | 'error' | 'info'
  title: string
  body: string
  task_id: string
  slice_id: string
  read: boolean
  created_at: string
}

/**
 * Create a notification, save to DB, push to renderer via IPC, and show OS notification.
 */
export function pushNotification(data: {
  type: AppNotification['type']
  title: string
  body?: string
  taskId?: string
  sliceId?: string
}): void {
  const db = getDb()

  const result = db.prepare(`
    INSERT INTO notifications (type, title, body, task_id, slice_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(data.type, data.title, data.body || '', data.taskId || '', data.sliceId || '')

  const id = result.lastInsertRowid as number
  const notification: AppNotification = {
    id,
    type: data.type,
    title: data.title,
    body: data.body || '',
    task_id: data.taskId || '',
    slice_id: data.sliceId || '',
    read: false,
    created_at: new Date().toISOString(),
  }

  // Push to renderer
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    try {
      win.webContents.send('notification:new', notification)
    } catch { /* window might be destroyed */ }
  }

  // Show OS-level notification with app icon
  if (Notification.isSupported()) {
    const iconPaths = [
      join(__dirname, '../../build/icon.png'),
      join(app.getAppPath(), 'build/icon.png'),
      join(app.getAppPath(), '../build/icon.png'),
    ]
    let icon: Electron.NativeImage | undefined
    for (const p of iconPaths) {
      if (existsSync(p)) { icon = nativeImage.createFromPath(p); break }
    }
    const osNotif = new Notification({
      title: data.title,
      body: data.body || '',
      silent: false,
      icon,
    })
    osNotif.on('click', () => {
      // Bring app to front when notification is clicked
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
    osNotif.show()
  }

  // macOS: bounce dock icon when app is in background
  if (process.platform === 'darwin') {
    const focused = BrowserWindow.getAllWindows().some(w => w.isFocused())
    if (!focused) {
      app.dock.bounce('informational')
    }
  }

  logger.info(`Notification: [${data.type}] ${data.title}`)
}

export function getNotifications(limit: number = 50): AppNotification[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as any[]
  return rows.map(r => ({ ...r, read: !!r.read }))
}

export function getUnreadCount(): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE read = 0').get() as any
  return row?.cnt || 0
}

export function markAsRead(id: number): void {
  getDb().prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id)
}

export function markAllAsRead(): void {
  getDb().prepare('UPDATE notifications SET read = 1 WHERE read = 0').run()
}

export function clearNotifications(): void {
  getDb().prepare('DELETE FROM notifications').run()
}
