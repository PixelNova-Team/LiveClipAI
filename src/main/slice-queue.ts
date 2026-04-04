import { getConfig } from './config'
import { getLogger } from './utils/logger'
import { BrowserWindow } from 'electron'

const logger = getLogger('slice-queue')

export interface SliceJob {
  id: string
  taskId: string
  execute: () => Promise<void>
}

const queue: SliceJob[] = []
let running = 0

function getMaxConcurrent(): number {
  const val = getConfig().slice.max_concurrent_slices
  return Math.max(1, Math.min(val || 1, 5))
}

export function enqueueSlice(job: SliceJob): { position: number } {
  queue.push(job)
  const position = queue.length
  logger.info(`Job queued: ${job.id} (task=${job.taskId}), queue=${queue.length}, running=${running}`)
  broadcastQueueStatus()
  processNext()
  return { position }
}

/**
 * Remove all queued (not yet running) jobs for a given taskId.
 * Returns the number of jobs removed.
 */
export function removeJobsForTask(taskId: string): number {
  const before = queue.length
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].taskId === taskId) {
      queue.splice(i, 1)
    }
  }
  const removed = before - queue.length
  if (removed > 0) {
    logger.info(`Removed ${removed} queued jobs for task ${taskId}`)
  }
  return removed
}

export function getQueueStatus(): { running: number; queued: number; maxConcurrent: number } {
  return { running, queued: queue.length, maxConcurrent: getMaxConcurrent() }
}

/** Broadcast queue status to all renderer windows */
function broadcastQueueStatus(): void {
  const status = getQueueStatus()
  logger.info(`Broadcasting queue status: running=${status.running}, queued=${status.queued}`)
  try {
    const windows = BrowserWindow.getAllWindows()
    logger.info(`Found ${windows.length} window(s) to broadcast to`)
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('slice-queue:status', status)
      }
    }
  } catch (e: any) {
    logger.error(`broadcastQueueStatus error: ${e?.message || e}`)
  }
}

function processNext(): void {
  const max = getMaxConcurrent()
  while (running < max && queue.length > 0) {
    const job = queue.shift()!
    running++
    logger.info(`Job starting: ${job.id} (task=${job.taskId}), running=${running}, remaining=${queue.length}`)
    broadcastQueueStatus()
    job.execute()
      .catch(e => logger.error(`Job ${job.id} failed: ${e?.message || e}`))
      .finally(() => {
        running--
        logger.info(`Job finished: ${job.id}, running=${running}, remaining=${queue.length}`)
        broadcastQueueStatus()
        processNext()
      })
  }
}
