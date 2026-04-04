<template>
  <div class="notification-page">
    <div class="page-header">
      <div class="header-left">
        <h1 class="page-title">{{ t('notification.title') }}</h1>
        <p class="page-desc">{{ t('notification.subtitle') }}</p>
      </div>
      <div class="header-right">
        <el-button v-if="unreadCount > 0" round @click="markAllRead">
          <el-icon><Check /></el-icon>
          {{ t('notification.markAllRead') }}
        </el-button>
        <el-button v-if="notifications.length > 0" type="danger" plain round @click="handleClearAll">
          <el-icon><Delete /></el-icon>
          {{ t('notification.clearAll') }}
        </el-button>
      </div>
    </div>

    <!-- Notification permission banner -->
    <div v-if="permissionStatus === 'denied' || permissionStatus === 'not-determined'" class="perm-banner glass-card">
      <div class="perm-icon">
        <el-icon :size="20"><Bell /></el-icon>
      </div>
      <div class="perm-content">
        <div class="perm-title">{{ t('notification.permRequired') }}</div>
        <div class="perm-desc">{{ t('notification.permDesc') }}</div>
        <div class="perm-steps">
          <span class="perm-step">{{ t('notification.permStep1') }}</span>
          <span class="perm-step">{{ t('notification.permStep2') }}</span>
          <span class="perm-step">{{ t('notification.permStep3') }}</span>
        </div>
      </div>
      <el-button round size="small" class="gradient-btn" @click="openNotifSettings">
        {{ t('notification.goSettings') }}
      </el-button>
    </div>

    <!-- Notification list -->
    <div v-if="notifications.length > 0" class="notif-list">
      <div
        v-for="n in notifications"
        :key="n.id"
        class="notif-item glass-card"
        :class="{ 'is-unread': !n.read }"
        @click="handleNotifClick(n)"
      >
        <div class="notif-icon" :class="[`notif-type--${n.type}`]">
          <el-icon :size="18">
            <Scissor v-if="n.type === 'slice'" />
            <Promotion v-else-if="n.type === 'publish'" />
            <WarningFilled v-else-if="n.type === 'error'" />
            <InfoFilled v-else />
          </el-icon>
        </div>
        <div class="notif-content">
          <div class="notif-title">{{ n.title }}</div>
          <div v-if="n.body" class="notif-body">{{ n.body }}</div>
        </div>
        <div class="notif-meta">
          <span class="notif-time">{{ formatNotifTime(n.created_at) }}</span>
          <span v-if="!n.read" class="notif-unread-dot"></span>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else class="notif-empty glass-card">
      <el-icon :size="48" color="var(--text-tertiary)"><Bell /></el-icon>
      <span class="notif-empty-text">{{ t('notification.empty') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  Bell, Check, Delete,
  Scissor, Promotion, WarningFilled, InfoFilled,
} from '@element-plus/icons-vue'
import { useNotifications, type AppNotification } from '@/composables/useNotifications'
import ipc from '@/api/client'

const { t } = useI18n()
const router = useRouter()
const { notifications, unreadCount, markRead, markAllRead, clearAll } = useNotifications()

const permissionStatus = ref<string>('granted')

onMounted(async () => {
  try {
    permissionStatus.value = await ipc.invoke<string>('notifications:check-permission')
  } catch { /* ignore */ }
})

async function openNotifSettings() {
  try {
    await ipc.invoke('notifications:open-settings')
  } catch { /* ignore */ }
}

function handleNotifClick(n: AppNotification) {
  markRead(n.id)
  if (n.task_id) {
    router.push(`/live/${n.task_id}`)
  }
}

function handleClearAll() {
  clearAll()
}

function formatNotifTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return t('notification.justNow')
    if (diffMin < 60) return t('notification.minutesAgo', { n: diffMin })
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return t('notification.hoursAgo', { n: diffHr })
    const diffDay = Math.floor(diffHr / 24)
    return t('notification.daysAgo', { n: diffDay })
  } catch {
    return iso
  }
}
</script>

<style scoped>
.notification-page {
  max-width: 960px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 24px;
}

.header-left {
  flex: 1;
}

.page-title {
  font-size: 22px;
  font-weight: 700;
  margin: 0 0 6px;
}

.page-desc {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.header-right {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

/* Permission banner */
.perm-banner {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  margin-bottom: 16px;
  border-left: 3px solid var(--accent);
  background: var(--accent-subtle);
}

.perm-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: rgba(240, 86, 56, 0.12);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.perm-content {
  flex: 1;
  min-width: 0;
}

.perm-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.perm-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.perm-steps {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.perm-step {
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--glass-bg);
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
}

.gradient-btn {
  background: var(--accent) !important;
  border: none !important;
  color: #fff !important;
  font-weight: 500;
}

.gradient-btn:hover {
  background: var(--accent-hover) !important;
}

/* Notification list */
.notif-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.notif-item {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 16px 20px;
  cursor: pointer;
  transition: background 0.15s var(--ease-out), border-color 0.15s var(--ease-out);
  border-left: 2px solid transparent;
}

.notif-item:hover {
  border-left-color: var(--accent);
  background: var(--glass-hover);
}

.notif-item:active {
  background: var(--accent-subtle);
  transition-duration: 80ms;
}

.notif-item.is-unread {
  background: var(--accent-subtle);
  border-left-color: var(--accent);
}

.notif-item.is-unread:hover {
  background: rgba(240, 86, 56, 0.08);
}

.notif-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

.notif-type--slice {
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
}

.notif-type--publish {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}

.notif-type--error {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.notif-type--info {
  background: rgba(240, 86, 56, 0.12);
  color: #f05638;
}

.notif-content {
  flex: 1;
  min-width: 0;
}

.notif-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  line-height: 1.5;
}

.notif-body {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  white-space: normal;
}

.notif-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-top: 4px;
}

.notif-time {
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.notif-unread-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 6px rgba(240, 86, 56, 0.5);
  flex-shrink: 0;
}

/* Empty state */
.notif-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 24px;
  text-align: center;
}

.notif-empty-text {
  font-size: 15px;
  color: var(--text-tertiary);
}
</style>
