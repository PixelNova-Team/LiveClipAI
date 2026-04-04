import { registry } from './plugins/registry'
import { startMonitor } from './live-monitor'
import * as taskManager from './task-manager'
import * as streamerManager from './streamer-manager'
import { pushNotification } from './notification-service'
import { getLogger } from './utils/logger'
import { mt } from './i18n'

const logger = getLogger('streamer-watcher')

const POLL_INTERVAL = 10 * 60 * 1000  // 10 minutes

let timer: ReturnType<typeof setInterval> | null = null
let polling = false

function cleanUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return u.origin + u.pathname
  } catch {
    return rawUrl
  }
}

export function startWatcher(): void {
  if (timer) return
  logger.info('StreamerWatcher started (interval: 10 min)')
  pollAll()
  timer = setInterval(pollAll, POLL_INTERVAL)
}

export function stopWatcher(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  logger.info('StreamerWatcher stopped')
}

export function pollNow(): void {
  pollAll()
}

async function pollAll(): Promise<void> {
  if (polling) return
  polling = true

  try {
    const streamers = streamerManager.getEnabledStreamers()
    if (streamers.length === 0) { polling = false; return }

    logger.info(`Polling ${streamers.length} streamers...`)

    for (const s of streamers) {
      try {
        const plugin = registry.getPlatform(s.platform)
        if (!plugin) {
          logger.warn(`No plugin for platform: ${s.platform}`)
          continue
        }

        const live = await plugin.isLive(s.room_url)

        if (live && !s.is_live) {
          await onStreamStart(s)
        } else if (!live && s.is_live) {
          await onStreamEnd(s)
        }
      } catch (e: any) {
        logger.warn(`Poll error for ${s.nickname || s.room_url}: ${e.message}`)
      }
    }
  } catch (e: any) {
    logger.error(`pollAll error: ${e.message}`)
  } finally {
    polling = false
  }
}

async function onStreamStart(s: streamerManager.StreamerInfo): Promise<void> {
  logger.info(`Stream started: ${s.nickname || s.room_url} (${s.platform})`)

  try {
    const cleanedUrl = cleanUrl(s.room_url)

    // Check for existing active task for the same URL to avoid duplicates
    const existingTask = taskManager.findActiveTaskByUrl(cleanedUrl)
    if (existingTask) {
      logger.info(`Active task ${existingTask.task_id} already exists for ${cleanedUrl}, skipping duplicate creation`)
      streamerManager.updateStreamer(s.streamer_id, {
        is_live: true,
        last_live_at: new Date().toISOString(),
        active_task_id: existingTask.task_id,
      })
      return
    }

    const task = taskManager.createTask({
      url: cleanedUrl,
      platform: s.platform,
      task_type: 'live',
    })

    startMonitor(task.task_id, cleanedUrl, s.platform)
    taskManager.updateTask(task.task_id, { status: 'starting' })

    streamerManager.updateStreamer(s.streamer_id, {
      is_live: true,
      last_live_at: new Date().toISOString(),
      active_task_id: task.task_id,
    })

    pushNotification({
      type: 'slice',
      title: mt('notify.streamerLive', { name: s.nickname || s.platform }),
      body: mt('notify.autoRecordStarted'),
      taskId: task.task_id,
    })

    logger.info(`Auto-created task ${task.task_id} for streamer ${s.streamer_id}`)
  } catch (e: any) {
    logger.error(`Failed to auto-start for ${s.nickname || s.room_url}: ${e.message}`)
  }
}

async function onStreamEnd(s: streamerManager.StreamerInfo): Promise<void> {
  logger.info(`Stream ended: ${s.nickname || s.room_url} (${s.platform})`)

  const updates: Parameters<typeof streamerManager.updateStreamer>[1] = {
    is_live: false,
    active_task_id: null,
  }

  if (s.mode === 'once') {
    updates.enabled = false
    logger.info(`Streamer ${s.streamer_id} disabled (once mode)`)
  }

  streamerManager.updateStreamer(s.streamer_id, updates)
}
