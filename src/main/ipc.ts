import { ipcMain, app, Notification, systemPreferences, shell } from 'electron'
import { existsSync, readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import { registry } from './plugins/registry'
import { PluginManager } from './plugins/manager'
import { loginWithBrowser, getAuthStatus, logoutPlatform } from './auth-manager'
import * as taskManager from './task-manager'
import { startMonitor, stopMonitor, getActiveTaskIds } from './live-monitor'
import { getConfig, saveConfig, loadConfig } from './config'
import { getDb } from './db'
import { getLogger } from './utils/logger'
import { saveCookies } from './utils/cookies'
import { getNotifications, getUnreadCount, markAsRead, markAllAsRead, clearNotifications, pushNotification } from './notification-service'
import { getBrandColor } from './utils/platform-config'
import { mt, setMainLocale } from './i18n'
import * as streamerManager from './streamer-manager'
import { startWatcher, stopWatcher, pollNow } from './streamer-watcher'
import { getWhisperLocalStatus, setupWhisperLocal, deleteWhisperModel } from './whisper-local'
import { getQueueStatus } from './slice-queue'
import { generateSliceContent, isAiConfigured, type SliceContext } from './ai-client'

const logger = getLogger('ipc')

/** Strip query parameters and hash fragments from a live stream URL, keeping only origin + pathname */
function cleanLiveUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return u.origin + u.pathname
  } catch {
    return rawUrl
  }
}

/** Ensure IPC return values are plain serializable objects (no class instances, proxies, etc.) */
function toPlain<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

async function registerPlugins(): Promise<void> {
  const pluginManager = new PluginManager()
  const result = await pluginManager.initialize()

  logger.info(
    `Plugin initialization complete: ${result.loadedCount} loaded, ${result.failedCount} failed. ` +
    `${registry.listPlatforms().length} platforms, ${registry.listDanmaku().length} danmaku, ${registry.listPublishers().length} publishers`
  )

  if (result.failedCount > 0) {
    logger.warn(`Failed plugins: ${result.failedPlugins.map(p => `${p.pluginId} (${p.error})`).join(', ')}`)
  }
}

/** Reset orphaned tasks that were running when app last closed */
function resetOrphanedTasks(): void {
  const db = getDb()
  const orphaned = db.prepare(
    "SELECT task_id FROM tasks WHERE status IN ('starting', 'recording', 'running', 'processing')"
  ).all() as { task_id: string }[]

  if (orphaned.length > 0) {
    db.prepare(
      `UPDATE tasks SET status = 'stopped', error_message = '${mt('error.appRestart')}' WHERE status IN ('starting', 'recording', 'running', 'processing')`
    ).run()
    logger.info(`Reset ${orphaned.length} orphaned tasks to stopped: ${orphaned.map(t => t.task_id).join(', ')}`)
  }
}

export async function registerIpcHandlers(): Promise<void> {
  // Initialize
  loadConfig()
  await registerPlugins()
  resetOrphanedTasks()

  ipcMain.handle('set-locale', (_e, locale: string) => {
    setMainLocale(locale)
  })

  // ---- App ----
  ipcMain.handle('app:version', () => {
    return '0.1.0'
  })

  // ---- Tasks ----
  ipcMain.handle('tasks:list', (_e, params) => {
    return toPlain(taskManager.listTasks(params || {}))
  })

  ipcMain.handle('tasks:get', (_e, taskId: string) => {
    return toPlain(taskManager.getTask(taskId))
  })

  ipcMain.handle('tasks:create', async (_e, data) => {
    // Detect platform from URL
    const cleanedUrl = cleanLiveUrl(data.url)
    const detected = registry.detectPlatform(cleanedUrl)
    const platform = data.platform || detected?.name || ''

    const task = taskManager.createTask({
      url: cleanedUrl,
      platform,
      task_type: data.task_type || 'live',
      output_dir: data.output_dir,
      config: {
        record_duration: data.record_duration,
      },
    })

    // Start live monitor if it's a live task
    if (task.task_type === 'live') {
      try {
        startMonitor(task.task_id, cleanedUrl, platform)
        taskManager.updateTask(task.task_id, { status: 'starting' })
      } catch (e: any) {
        taskManager.updateTask(task.task_id, { status: 'failed', error_message: e.message })
      }
    }

    return toPlain(taskManager.getTask(task.task_id))
  })

  ipcMain.handle('tasks:delete', (_e, taskId: string) => {
    stopMonitor(taskId)
    taskManager.deleteTask(taskId)
    return { success: true }
  })

  ipcMain.handle('tasks:cancel', (_e, taskId: string) => {
    stopMonitor(taskId)
    taskManager.updateTask(taskId, { status: 'cancelled' })
    return { success: true }
  })

  ipcMain.handle('tasks:retry', async (_e, taskId: string) => {
    const task = taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found')

    // Stop existing monitor if any before retrying
    stopMonitor(taskId)
    taskManager.updateTask(taskId, { status: 'starting', error_message: '', live_stats: null })
    startMonitor(taskId, task.source_url, task.platform)
    return toPlain(taskManager.getTask(taskId))
  })

  ipcMain.handle('tasks:batch-create', async (_e, data: { urls: string[] }) => {
    const results = []
    for (const rawUrl of data.urls) {
      const url = cleanLiveUrl(rawUrl)
      const detected = registry.detectPlatform(url)
      const task = taskManager.createTask({
        url,
        platform: detected?.name || '',
        task_type: 'live',
      })
      if (detected) {
        startMonitor(task.task_id, url, detected.name)
        taskManager.updateTask(task.task_id, { status: 'starting' })
      }
      results.push(taskManager.getTask(task.task_id))
    }
    return toPlain(results)
  })

  ipcMain.handle('tasks:batch-delete', (_e, taskIds: string[]) => {
    for (const id of taskIds) {
      stopMonitor(id)
      taskManager.deleteTask(id)
    }
    return { deleted: taskIds.length }
  })

  ipcMain.handle('tasks:retry-danmaku', async (_e, taskId: string) => {
    const task = taskManager.getTask(taskId)
    if (!task) throw new Error('Task not found')

    const collector = registry.getDanmaku(task.platform)
    if (collector) {
      if (collector.isConnected) await collector.disconnect()
      const info = await registry.getPlatform(task.platform)?.getLiveInfo(task.source_url)
      if (info) await collector.connect(info.roomId)
      return { connected: collector.isConnected }
    }
    return { connected: false }
  })

  // ---- Auth ----
  ipcMain.handle('auth:login', async (_e, platform: string) => {
    return loginWithBrowser(platform)
  })

  ipcMain.handle('auth:status', async (_e, platform: string) => {
    return getAuthStatus(platform)
  })

  ipcMain.handle('auth:logout', async (_e, platform: string) => {
    await logoutPlatform(platform)
    return { success: true }
  })

  ipcMain.handle('auth:qrcode-generate', async (_e, platform: string) => {
    // In Electron, we use BrowserWindow login instead of QR code
    // But return a stub for compatibility
    return { platform, url: '', message: 'Use browser login instead' }
  })

  ipcMain.handle('auth:qrcode-poll', async (_e, _data) => {
    return { status: 'expired', platform: '' }
  })

  ipcMain.handle('auth:qrcode-confirm', async (_e, _platform: string) => {
    return { status: 'expired', platform: '' }
  })

  ipcMain.handle('auth:import-cookies', (_e, data: { platform: string; cookie_text: string }) => {
    const cookies = data.cookie_text.split(';').map((c: string) => {
      const [name, ...rest] = c.trim().split('=')
      return { name: name.trim(), value: rest.join('=').trim(), domain: '', path: '/' }
    }).filter((c: any) => c.name && c.value)
    saveCookies(data.platform, cookies)
    return { cookies_imported: cookies.length }
  })

  // ---- Config ----
  ipcMain.handle('config:get-all', () => {
    return toPlain(getConfig())
  })

  ipcMain.handle('config:get', (_e, section: string) => {
    const config = getConfig() as any
    return toPlain(config[section] || {})
  })

  ipcMain.handle('config:update', (_e, updates) => {
    const result = toPlain(saveConfig(updates))
    // Reset ASR providers cache when config changes
    try {
      const { resetAsrProviders } = require('./asr')
      resetAsrProviders()
    } catch { /* ignore */ }
    return result
  })

  ipcMain.handle('config:cache-stats', () => {
    const config = getConfig()
    const { cache_dir, temp_dir, output_dir } = config.storage

    function scanDir(dir: string): { total_size: number; file_count: number; task_dirs: { name: string; size: number; file_count: number }[] } {
      if (!existsSync(dir)) return { total_size: 0, file_count: 0, task_dirs: [] }
      let totalSize = 0
      let fileCount = 0
      const taskDirs: { name: string; size: number; file_count: number }[] = []

      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            const sub = scanDirFlat(fullPath)
            taskDirs.push({ name: entry.name, size: sub.size, file_count: sub.count })
            totalSize += sub.size
            fileCount += sub.count
          } else if (entry.isFile()) {
            try {
              const st = statSync(fullPath)
              totalSize += st.size
              fileCount++
            } catch { /* skip */ }
          }
        }
      } catch { /* dir not readable */ }

      return { total_size: totalSize, file_count: fileCount, task_dirs: taskDirs }
    }

    function scanDirFlat(dir: string): { size: number; count: number } {
      let size = 0, count = 0
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = join(dir, entry.name)
          if (entry.isFile()) {
            try { const st = statSync(fullPath); size += st.size; count++ } catch { /* skip */ }
          } else if (entry.isDirectory()) {
            const sub = scanDirFlat(fullPath)
            size += sub.size; count += sub.count
          }
        }
      } catch { /* skip */ }
      return { size, count }
    }

    const temp = scanDir(temp_dir)
    const cache = scanDir(cache_dir)
    const output = scanDir(output_dir)

    // Build slices info from output dir + DB
    const db = getDb()
    let slicesInfo: any = null
    try {
      const sliceTasks: any[] = []
      let sliceTotalSize = 0
      let sliceTotalCount = 0

      if (existsSync(output_dir)) {
        const taskFolders = readdirSync(output_dir, { withFileTypes: true }).filter(e => e.isDirectory())
        for (const folder of taskFolders) {
          const taskId = folder.name
          const taskDir = join(output_dir, taskId)
          const sub = scanDirFlat(taskDir)
          if (sub.count === 0) continue

          sliceTotalSize += sub.size
          sliceTotalCount += sub.count

          // Look up task info from DB
          let title = taskId
          let platform = ''
          let status = 'completed'
          try {
            const row = db.prepare('SELECT title, platform, status FROM tasks WHERE task_id = ?').get(taskId) as any
            if (row) {
              title = row.title || taskId
              platform = row.platform || ''
              status = row.status || 'completed'
            }
          } catch { /* skip */ }

          sliceTasks.push({
            task_id: taskId,
            title,
            platform,
            status,
            size: sub.size,
            slice_count: sub.count,
          })
        }
      }

      slicesInfo = {
        total_size: sliceTotalSize,
        total_count: sliceTotalCount,
        tasks: sliceTasks,
      }
    } catch { /* skip */ }

    return { temp, cache, output, slices: slicesInfo }
  })

  ipcMain.handle('config:clear-cache', (_e, data: { target: string; keep_active?: boolean }) => {
    const config = getConfig()
    const { cache_dir, temp_dir, output_dir } = config.storage
    const target = data.target
    let freed = 0

    function clearDir(dir: string, keepActive: boolean): number {
      if (!existsSync(dir)) return 0
      const activeIds = keepActive ? new Set(getActiveTaskIds()) : new Set<string>()
      let removed = 0
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          // Skip directories belonging to active monitoring tasks
          if (keepActive && activeIds.has(entry.name)) {
            logger.info(`Skipping active task directory: ${entry.name}`)
            continue
          }
          const fullPath = join(dir, entry.name)
          try {
            const st = statSync(fullPath)
            const size = entry.isDirectory()
              ? scanDirSize(fullPath)
              : st.size
            rmSync(fullPath, { recursive: true, force: true })
            removed += size
          } catch { /* skip locked files */ }
        }
      } catch { /* skip */ }
      return removed
    }

    function scanDirSize(dir: string): number {
      let size = 0
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = join(dir, entry.name)
          if (entry.isFile()) {
            try { size += statSync(fullPath).size } catch { /* skip */ }
          } else if (entry.isDirectory()) {
            size += scanDirSize(fullPath)
          }
        }
      } catch { /* skip */ }
      return size
    }

    const db = getDb()

    if (target === 'all') {
      freed += clearDir(temp_dir, data.keep_active !== false)
      freed += clearDir(cache_dir, data.keep_active !== false)
      freed += clearDir(output_dir, data.keep_active !== false)

      // If full cleanup (keep_active === false), also clear DB data and auth
      if (data.keep_active === false) {
        try { db.prepare('DELETE FROM slices').run() } catch { /* skip */ }
        try { db.prepare('DELETE FROM publish_records').run() } catch { /* skip */ }
        try { db.prepare('DELETE FROM streamers').run() } catch { /* skip */ }
        try { db.prepare('DELETE FROM tasks').run() } catch { /* skip */ }
        try { db.prepare('DELETE FROM notifications').run() } catch { /* skip */ }
        logger.info('Full cleanup: database records cleared')
      } else {
        try { db.prepare('DELETE FROM slices').run() } catch { /* skip */ }
        // Also clean up old read notifications in standard cleanup
        try { db.prepare("DELETE FROM notifications WHERE read = 1").run() } catch { /* skip */ }
      }
    } else if (target === 'temp') {
      freed = clearDir(temp_dir, !!data.keep_active)
    } else if (target === 'cache') {
      freed = clearDir(cache_dir, !!data.keep_active)
    } else if (target === 'output') {
      freed = clearDir(output_dir, !!data.keep_active)
      // Delete all slice records from DB
      try { db.prepare('DELETE FROM slices').run() } catch { /* skip */ }
    } else if (target.startsWith('temp/')) {
      const subDir = join(temp_dir, target.slice(5))
      if (existsSync(subDir)) {
        freed = scanDirSize(subDir)
        rmSync(subDir, { recursive: true, force: true })
      }
    } else if (target.startsWith('cache/')) {
      const subDir = join(cache_dir, target.slice(6))
      if (existsSync(subDir)) {
        freed = scanDirSize(subDir)
        rmSync(subDir, { recursive: true, force: true })
      }
    }

    return { success: true, freed }
  })

  ipcMain.handle('config:upload-cookies', (_e, data: { name: string; content: string }) => {
    return { success: true }
  })

  ipcMain.handle('config:delete-cookies', () => {
    return { success: true }
  })

  ipcMain.handle('config:clear-task-slices', (_e, taskId: string) => {
    const config = getConfig()
    const taskDir = join(config.storage.output_dir, taskId)
    let freed = 0
    if (existsSync(taskDir)) {
      try {
        const entries = readdirSync(taskDir, { withFileTypes: true })
        for (const entry of entries) {
          const fp = join(taskDir, entry.name)
          try { freed += statSync(fp).size } catch { /* skip */ }
        }
        rmSync(taskDir, { recursive: true, force: true })
      } catch { /* skip */ }
    }
    // Delete slice records from DB
    try { getDb().prepare('DELETE FROM slices WHERE task_id = ?').run(taskId) } catch { /* skip */ }
    return { success: true, freed }
  })

  ipcMain.handle('config:clear-finished-slices', () => {
    const config = getConfig()
    const outputDir = config.storage.output_dir
    const db = getDb()
    let freed = 0
    const clearedTaskIds: string[] = []
    if (!existsSync(outputDir)) return { success: true, freed: 0 }

    try {
      const folders = readdirSync(outputDir, { withFileTypes: true }).filter(e => e.isDirectory())
      for (const folder of folders) {
        const taskId = folder.name
        // Check if task is still active
        try {
          const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as any
          if (row && ['starting', 'recording', 'running', 'processing'].includes(row.status)) continue
        } catch { /* if no DB row, treat as finished */ }

        const taskDir = join(outputDir, taskId)
        try {
          const entries = readdirSync(taskDir, { withFileTypes: true })
          for (const entry of entries) {
            try { freed += statSync(join(taskDir, entry.name)).size } catch { /* skip */ }
          }
          rmSync(taskDir, { recursive: true, force: true })
          clearedTaskIds.push(taskId)
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    // Delete slice records from DB for cleared tasks
    for (const taskId of clearedTaskIds) {
      try { db.prepare('DELETE FROM slices WHERE task_id = ?').run(taskId) } catch { /* skip */ }
    }

    return { success: true, freed }
  })

  ipcMain.handle('config:cookies-status', async () => {
    const platforms = await Promise.all(
      registry.listPlatforms().map(async p => {
        const status = await getAuthStatus(p.name)
        return { platform: p.name, authenticated: status.authenticated }
      })
    )
    return { platforms }
  })

  // ---- Slices ----
  /** Parse tags_json and candidate_titles_json into arrays for frontend consumption */
  function parseSliceRow(row: any): any {
    if (!row) return row
    try { row.tags = JSON.parse(row.tags_json || '[]') } catch { row.tags = [] }
    try { row.candidate_titles = JSON.parse(row.candidate_titles_json || '[]') } catch { row.candidate_titles = [] }
    // Normalize ai_approved: DB stores as INTEGER (0/1/null), expose as-is
    // ai_review_reason is already a TEXT column, no transformation needed
    return row
  }
  function parseSliceRows(rows: any[]): any[] {
    return rows.map(parseSliceRow)
  }

  ipcMain.handle('slices:list', (_e, taskId: string) => {
    const db = getDb()
    return toPlain(parseSliceRows(db.prepare('SELECT * FROM slices WHERE task_id = ? ORDER BY created_at DESC').all(taskId)))
  })

  ipcMain.handle('slices:all', (_e, taskType?: string) => {
    const db = getDb()
    if (taskType) {
      return toPlain(parseSliceRows(db.prepare(`
        SELECT s.*, t.platform, t.title as task_title, t.source_url, t.author as channel_id
        FROM slices s JOIN tasks t ON s.task_id = t.task_id
        WHERE t.task_type = ? ORDER BY s.created_at DESC
      `).all(taskType)))
    }
    return toPlain(parseSliceRows(db.prepare(`
      SELECT s.*, t.platform, t.title as task_title, t.source_url, t.author as channel_id
      FROM slices s JOIN tasks t ON s.task_id = t.task_id
      ORDER BY s.created_at DESC
    `).all()))
  })

  ipcMain.handle('slices:update', (_e, sliceId: string, data: { title?: string; description?: string; ai_approved?: number | null }) => {
    const db = getDb()
    const updates: string[] = []
    const values: any[] = []
    if (data.title !== undefined) { updates.push('selected_title = ?'); values.push(data.title) }
    if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description) }
    if (data.ai_approved !== undefined) { updates.push('ai_approved = ?'); values.push(data.ai_approved) }
    if (updates.length === 0) return { success: true }
    values.push(sliceId)
    db.prepare(`UPDATE slices SET ${updates.join(', ')} WHERE slice_id = ?`).run(...values)
    return { success: true }
  })

  ipcMain.handle('slices:delete', (_e, sliceId: string) => {
    const db = getDb()
    db.prepare('DELETE FROM slices WHERE slice_id = ?').run(sliceId)
    return { success: true }
  })

  ipcMain.handle('slices:clear-all', () => {
    const db = getDb()
    const count = db.prepare('SELECT COUNT(*) as cnt FROM slices').get() as any
    db.prepare('DELETE FROM slices').run()
    return { success: true, deleted: count?.cnt || 0 }
  })

  ipcMain.handle('slices:ai-review', async (_e, sliceId: string) => {
    if (!isAiConfigured()) {
      return { success: false, error: mt('error.aiNotConfigured') }
    }
    const db = getDb()
    const slice = db.prepare(`
      SELECT s.*, t.platform, t.title as task_title, t.author
      FROM slices s JOIN tasks t ON s.task_id = t.task_id
      WHERE s.slice_id = ?
    `).get(sliceId) as any
    if (!slice) return { success: false, error: 'Slice not found' }

    const ctx: SliceContext = {
      platform: slice.platform || '',
      streamerName: slice.author || '',
      liveTitle: slice.task_title || '',
      danmakuTexts: [],
      giftNames: [],
      clipDuration: slice.duration || 0,
      peakScore: slice.peak_score || 0,
      framePaths: slice.cover_path && existsSync(slice.cover_path) ? [slice.cover_path] : undefined,
    }

    // Try to read subtitle file for transcript
    if (slice.subtitle_path && existsSync(slice.subtitle_path)) {
      try {
        const srtContent = require('fs').readFileSync(slice.subtitle_path, 'utf-8')
        // Extract text lines from SRT (skip timestamps and sequence numbers)
        const lines = srtContent.split('\n').filter((l: string) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l))
        ctx.transcript = lines.join('')
      } catch { /* ignore */ }
    }

    const content = await generateSliceContent(ctx)

    // Update the slice in DB
    const updates: string[] = []
    const values: any[] = []
    if (content.title) { updates.push('selected_title = ?'); values.push(content.title) }
    if (content.description) { updates.push('description = ?'); values.push(content.description) }
    if (content.coverText) { updates.push('cover_text = ?'); values.push(content.coverText) }
    if (content.candidateTitles.length > 0) { updates.push('candidate_titles_json = ?'); values.push(JSON.stringify(content.candidateTitles)) }
    if (content.tags.length > 0) { updates.push('tags_json = ?'); values.push(JSON.stringify(content.tags)) }
    if (content.aiApproved != null) { updates.push('ai_approved = ?'); values.push(content.aiApproved ? 1 : 0) }
    updates.push('ai_review_reason = ?'); values.push(content.aiReviewReason || '')

    if (updates.length > 0) {
      values.push(sliceId)
      db.prepare(`UPDATE slices SET ${updates.join(', ')} WHERE slice_id = ?`).run(...values)
    }

    logger.info(`AI review for ${sliceId}: approved=${content.aiApproved}, title="${content.title}", reason="${content.aiReviewReason}"`)
    return toPlain({
      success: true,
      aiApproved: content.aiApproved,
      aiReviewReason: content.aiReviewReason,
      title: content.title,
      description: content.description,
      tags: content.tags,
    })
  })

  ipcMain.handle('slices:grouped', (_e, taskType?: string) => {
    const db = getDb()
    const slices = taskType
      ? db.prepare(`SELECT s.*, t.platform, t.task_type, t.source_url FROM slices s JOIN tasks t ON s.task_id = t.task_id WHERE t.task_type = ? ORDER BY s.created_at DESC`).all(taskType)
      : db.prepare('SELECT s.*, t.platform, t.task_type, t.source_url FROM slices s JOIN tasks t ON s.task_id = t.task_id ORDER BY s.created_at DESC').all()
    return toPlain(parseSliceRows(slices))
  })

  // ---- Slice debug download: subtitle file + relevant logs ----
  ipcMain.handle('slices:debug-info', (_e, sliceId: string) => {
    const db = getDb()
    const row = db.prepare('SELECT * FROM slices WHERE slice_id = ?').get(sliceId) as any
    if (!row) return { error: 'Slice not found' }

    // Read subtitle file content
    let subtitleContent = ''
    if (row.subtitle_path && existsSync(row.subtitle_path)) {
      try {
        subtitleContent = require('fs').readFileSync(row.subtitle_path, 'utf-8')
      } catch { /* ignore */ }
    }

    // Read today's log file and filter for this slice
    const shortId = sliceId.slice(0, 8)
    let logContent = ''
    try {
      const logDir = join(app.getPath('userData'), 'logs')
      // Read all log files from last 2 days (in case slice was created near midnight)
      const logFiles = existsSync(logDir) ? readdirSync(logDir)
        .filter(f => f.endsWith('.log'))
        .sort()
        .slice(-2) : []
      for (const f of logFiles) {
        const content = require('fs').readFileSync(join(logDir, f), 'utf-8')
        // Filter lines relevant to this slice (by short ID or task ID)
        const lines = content.split('\n').filter((line: string) =>
          line.includes(shortId) ||
          line.includes(row.task_id) ||
          line.includes('[slice-worker]') ||
          line.includes('[whisper-local]') ||
          line.includes('[subtitle]') ||
          line.includes('[ffmpeg]')
        )
        if (lines.length > 0) {
          logContent += `\n=== ${f} ===\n` + lines.join('\n')
        }
      }
    } catch { /* ignore */ }

    return {
      sliceId,
      taskId: row.task_id,
      startTime: row.start_time,
      endTime: row.end_time,
      duration: row.duration,
      subtitlePath: row.subtitle_path || '',
      subtitleContent,
      logContent: logContent || '(no matching logs found)',
    }
  })

  // ---- Platforms (all registered, for login) ----
  ipcMain.handle('platforms:list', () => {
    return registry.listPlatforms().map(p => ({
      name: p.name,
      label: p.label,
    }))
  })

  // ---- Plugin Metadata (for frontend auto-discovery) ----
  ipcMain.handle('plugins:get-platforms', () => {
    return toPlain(registry.listPlatforms().map(p => ({
      id: p.name,
      name: p.name,
      label: p.label,
      label_en: p.label_en || '',
      icon: p.icon,
      brandColor: getBrandColor(p.name),
    })))
  })

  ipcMain.handle('plugins:get-danmaku', () => {
    return toPlain(registry.listDanmaku().map(d => ({
      id: d.platform,
      name: d.platform,
      label: d.label || '',
      label_en: d.label_en || '',
    })))
  })

  ipcMain.handle('plugins:get-publishers', () => {
    return toPlain(registry.listPublishers().map(p => ({
      id: p.name,
      name: p.name,
      label: p.label,
      label_en: p.label_en || '',
    })))
  })

  ipcMain.handle('plugins:get-all-metadata', () => {
    return toPlain({
      platforms: registry.listPlatforms().map(p => ({
        id: p.name,
        name: p.name,
        label: p.label,
        label_en: p.label_en || '',
        icon: p.icon,
      })),
      danmaku: registry.listDanmaku().map(d => ({
        id: d.platform,
        name: d.platform,
        label: d.label || '',
        label_en: d.label_en || '',
      })),
      publishers: registry.listPublishers().map(p => ({
        id: p.name,
        name: p.name,
        label: p.label,
        label_en: p.label_en || '',
      })),
    })
  })

  // Detect platform from URL using plugin system
  ipcMain.handle('plugins:detect-platform', (_e, url: string) => {
    const cleanedUrl = cleanLiveUrl(url)
    const detected = registry.detectPlatform(cleanedUrl)
    return detected ? detected.name : null
  })

  // Check if URL is supported by any platform
  ipcMain.handle('plugins:is-supported-url', (_e, url: string) => {
    const cleanedUrl = cleanLiveUrl(url)
    const detected = registry.detectPlatform(cleanedUrl)
    console.log(`[DEBUG] plugins:is-supported-url: url=${url}, cleaned=${cleanedUrl}, detected=${detected?.name || 'none'}`)
    logger.info(`plugins:is-supported-url - url: ${url}, detected: ${detected?.name || 'unsupported'}`)
    return detected !== undefined
  })

  // ---- Publish ----
  ipcMain.handle('publish:platforms', () => {
    return registry.listPublishers().map(p => ({
      name: p.name,
      label: p.label,
      available: true,
    }))
  })

  ipcMain.handle('publish:submit', async (_e, data) => {
    const publisher = registry.getPublisher(data.platform)
    if (!publisher) throw new Error(`Publisher not found: ${data.platform}`)
    return publisher.publish({
      videoPath: data.slice_path || data.videoPath,
      title: data.title,
      description: data.description || '',
      tags: data.tags || [],
      coverPath: data.cover_path || data.coverPath,
    })
  })

  ipcMain.handle('publish:history', (_e, params?: { page?: number; size?: number; status?: string }) => {
    const db = getDb()
    const page = params?.page || 1
    const size = params?.size || 50
    const offset = (page - 1) * size

    let where = '1=1'
    const binds: any[] = []
    if (params?.status) {
      where += ' AND pr.status = ?'
      binds.push(params.status)
    }

    const items = db.prepare(`
      SELECT pr.id, pr.slice_id, pr.platform, pr.status, pr.publish_url as url,
             pr.error_message, pr.created_at as published_at,
             s.selected_title as title
      FROM publish_records pr
      LEFT JOIN slices s ON pr.slice_id = s.slice_id
      WHERE ${where}
      ORDER BY pr.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...binds, size, offset)

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM publish_records pr WHERE ${where}`).get(...binds) as any)?.cnt || 0

    return toPlain({ items, total, page, size })
  })

  ipcMain.handle('publish:by-id', async (_e, data: { sliceId: string; platform: string; title?: string; description?: string; tags?: string[] }) => {
    const db = getDb()
    const slice = db.prepare('SELECT * FROM slices WHERE slice_id = ?').get(data.sliceId) as any
    if (!slice) throw new Error('Slice not found')

    const publisher = registry.getPublisher(data.platform)
    if (!publisher) throw new Error(`Publisher not found: ${data.platform}`)

    // Create publish record
    db.prepare(
      'INSERT INTO publish_records (slice_id, platform, status) VALUES (?, ?, ?)'
    ).run(data.sliceId, data.platform, 'publishing')

    let sliceTags: string[] = data.tags || []
    if (sliceTags.length === 0) {
      try { sliceTags = JSON.parse(slice.tags_json || '[]') } catch { sliceTags = [] }
    }

    try {
      const result = await publisher.publish({
        videoPath: slice.slice_path,
        title: data.title || slice.selected_title || '',
        description: data.description || '',
        tags: sliceTags,
        coverPath: slice.cover_path || '',
      })

      if (result?.success) {
        db.prepare(
          "UPDATE publish_records SET status = 'published', publish_url = ? WHERE slice_id = ? AND platform = ? AND status = 'publishing'"
        ).run(result?.url || '', data.sliceId, data.platform)

        pushNotification({
          type: 'publish',
          title: mt('notify.publishSuccess', { title: data.title || slice.selected_title || mt('label.clip') }),
          body: mt('notify.publishedTo', { platform: data.platform }),
          sliceId: data.sliceId,
        })
      } else {
        // Publisher returned failure (e.g. user closed window, timeout)
        const errMsg = result?.error || 'unknown'
        const isCancelled = errMsg === 'cancelled'
        db.prepare(
          "UPDATE publish_records SET status = ?, error_message = ? WHERE slice_id = ? AND platform = ? AND status = 'publishing'"
        ).run(isCancelled ? 'cancelled' : 'failed', isCancelled ? '' : errMsg, data.sliceId, data.platform)
      }

      return toPlain({ success: result?.success || false, url: result?.url })
    } catch (e: any) {
      db.prepare(
        "UPDATE publish_records SET status = 'failed', error_message = ? WHERE slice_id = ? AND platform = ? AND status = 'publishing'"
      ).run(e.message, data.sliceId, data.platform)
      throw e
    }
  })

  ipcMain.handle('publish:batch', async (_e, data: { slice_ids: string[]; platform: string }) => {
    const db = getDb()
    const publisher = registry.getPublisher(data.platform)
    if (!publisher) throw new Error(`Publisher not found: ${data.platform}`)

    const results: { slice_id: string; success: boolean; error?: string }[] = []

    for (const sliceId of data.slice_ids) {
      const slice = db.prepare('SELECT * FROM slices WHERE slice_id = ?').get(sliceId) as any
      if (!slice) {
        results.push({ slice_id: sliceId, success: false, error: 'Slice not found' })
        continue
      }

      db.prepare(
        'INSERT INTO publish_records (slice_id, platform, status) VALUES (?, ?, ?)'
      ).run(sliceId, data.platform, 'publishing')

      let batchTags: string[] = []
      try { batchTags = JSON.parse(slice.tags_json || '[]') } catch { batchTags = [] }

      try {
        const result = await publisher.publish({
          videoPath: slice.slice_path,
          title: slice.selected_title || '',
          description: slice.description || '',
          tags: batchTags,
          coverPath: slice.cover_path || '',
        })

        db.prepare(
          "UPDATE publish_records SET status = 'published', publish_url = ? WHERE slice_id = ? AND platform = ? AND status = 'publishing'"
        ).run(result?.url || '', sliceId, data.platform)

        results.push({ slice_id: sliceId, success: true })
      } catch (e: any) {
        db.prepare(
          "UPDATE publish_records SET status = 'failed', error_message = ? WHERE slice_id = ? AND platform = ? AND status = 'publishing'"
        ).run(e.message, sliceId, data.platform)
        results.push({ slice_id: sliceId, success: false, error: e.message })
      }
    }

    return toPlain({ results, total: results.length, success: results.filter(r => r.success).length })
  })

  // ---- Notifications ----
  ipcMain.handle('notifications:list', (_e, limit?: number) => {
    return toPlain(getNotifications(limit || 50))
  })

  ipcMain.handle('notifications:unread-count', () => {
    return getUnreadCount()
  })

  ipcMain.handle('notifications:mark-read', (_e, id: number) => {
    markAsRead(id)
    return { success: true }
  })

  ipcMain.handle('notifications:mark-all-read', () => {
    markAllAsRead()
    return { success: true }
  })

  ipcMain.handle('notifications:clear', () => {
    clearNotifications()
    return { success: true }
  })

  ipcMain.handle('notifications:check-permission', async () => {
    if (!Notification.isSupported()) return 'unsupported'
    // macOS: check system notification permission
    if (process.platform === 'darwin') {
      const perm = systemPreferences.getNotificationSettings?.()
      // If getNotificationSettings is not available, fall back to checking
      // Notification.permission equivalent
      if (perm && perm.authorizationStatus !== undefined) {
        // 0 = notDetermined, 1 = denied, 2 = authorized, 3 = provisional
        if (perm.authorizationStatus === 2 || perm.authorizationStatus === 3) return 'granted'
        if (perm.authorizationStatus === 1) return 'denied'
        return 'not-determined'
      }
    }
    return 'granted' // Default assume granted on other platforms
  })

  ipcMain.handle('notifications:open-settings', () => {
    if (process.platform === 'darwin') {
      // macOS 13+: use Ventura-style URL; falls back to legacy URL on older macOS
      const bundleId = app.isPackaged ? app.getName() : 'com.electron'
      shell.openExternal(`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${bundleId}`)
        .catch(() => shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications'))
    } else if (process.platform === 'win32') {
      shell.openExternal('ms-settings:notifications')
    }
    return { success: true }
  })

  // ---- Slice Queue ----
  ipcMain.handle('slice-queue:status', () => {
    const queueStatus = getQueueStatus()
    // Include the most active live state from running monitors
    // so sidebar can show burst/heating even before slicing starts
    let liveState: string = 'idle'
    const activeIds = getActiveTaskIds()
    for (const id of activeIds) {
      const task = taskManager.getTask(id)
      const s = task?.live_stats?.state
      if (s === 'burst') { liveState = 'burst'; break }
      if (s === 'slicing') { liveState = 'slicing' }
      if (s === 'heating' && liveState === 'idle') { liveState = 'heating' }
    }
    return { ...queueStatus, liveState }
  })

  // ---- ASR Providers ----
  ipcMain.handle('asr:providers', () => {
    const { getAsrProviderInfo } = require('./asr')
    return getAsrProviderInfo()
  })

  // ---- Whisper Local ----
  ipcMain.handle('whisper:status', () => {
    return getWhisperLocalStatus()
  })

  ipcMain.handle('whisper:setup', async () => {
    try {
      await setupWhisperLocal((stage, percent) => {
        logger.info(`Whisper setup: ${stage} ${percent}%`)
      })
      return { success: true }
    } catch (e: any) {
      logger.error(`Whisper setup failed: ${e.message}`)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('whisper:delete-model', (_e, modelName: string) => {
    return deleteWhisperModel(modelName)
  })

  // ---- Streamers ----
  ipcMain.handle('streamers:list', () => {
    return toPlain(streamerManager.listStreamers())
  })

  ipcMain.handle('streamers:add', async (_e, data: {
    room_url: string
    platform?: string
    mode?: 'persistent' | 'once'
  }) => {
    const cleanedUrl = cleanLiveUrl(data.room_url)
    const detected = registry.detectPlatform(cleanedUrl)
    const platform = data.platform || detected?.name || ''
    if (!platform) throw new Error(mt('error.platformUnknown'))

    let nickname = ''
    let roomId = ''
    let avatarUrl = ''
    try {
      const plugin = registry.getPlatform(platform)
      if (plugin) {
        const info = await plugin.getLiveInfo(cleanedUrl)
        nickname = info.author || info.title || ''
        roomId = info.roomId || ''
        avatarUrl = info.coverUrl || ''
      }
    } catch {
      // Room info fetch failed (streamer may be offline), that's OK
    }

    const streamer = streamerManager.addStreamer({
      platform,
      room_url: cleanedUrl,
      room_id: roomId,
      nickname,
      avatar_url: avatarUrl,
      mode: data.mode || 'persistent',
    })

    pollNow()
    return toPlain(streamer)
  })

  ipcMain.handle('streamers:update', (_e, id: string, updates: { mode?: string; enabled?: boolean }) => {
    streamerManager.updateStreamer(id, updates)
    return toPlain(streamerManager.getStreamer(id))
  })

  ipcMain.handle('streamers:delete', (_e, id: string) => {
    streamerManager.deleteStreamer(id)
    return { success: true }
  })

  ipcMain.handle('streamers:poll-now', () => {
    pollNow()
    return { success: true }
  })

  // Start streamer watcher
  startWatcher()

  logger.info('IPC handlers registered')
}
