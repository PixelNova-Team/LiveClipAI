import { ref, onMounted, onUnmounted } from 'vue'
import ipc from '@/api/client'

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

const notifications = ref<AppNotification[]>([])
const unreadCount = ref(0)

let initialized = false
let unsubscribe: (() => void) | null = null

function init() {
  if (initialized) return
  initialized = true

  // Load existing notifications
  loadNotifications()

  // Listen for new notifications from main process
  unsubscribe = ipc.on('notification:new', (notification: AppNotification) => {
    notifications.value.unshift(notification)
    unreadCount.value++
  })
}

async function loadNotifications() {
  try {
    notifications.value = await ipc.invoke<AppNotification[]>('notifications:list', 50)
    unreadCount.value = await ipc.invoke<number>('notifications:unread-count')
  } catch { /* ignore */ }
}

async function markRead(id: number) {
  const n = notifications.value.find(n => n.id === id)
  if (n && !n.read) {
    n.read = true
    unreadCount.value = Math.max(0, unreadCount.value - 1)
    await ipc.invoke('notifications:mark-read', id)
  }
}

async function markAllRead() {
  notifications.value.forEach(n => { n.read = true })
  unreadCount.value = 0
  await ipc.invoke('notifications:mark-all-read')
}

async function clearAll() {
  notifications.value = []
  unreadCount.value = 0
  await ipc.invoke('notifications:clear')
}

export function useNotifications() {
  onMounted(() => init())

  return {
    notifications,
    unreadCount,
    loadNotifications,
    markRead,
    markAllRead,
    clearAll,
  }
}
