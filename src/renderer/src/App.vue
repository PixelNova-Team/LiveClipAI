<template>
  <el-config-provider :locale="elementLocale">
  <div class="app-layout" :class="theme">
    <!-- Sidebar -->
    <aside class="app-sidebar">
      <div class="sidebar-logo">
        <div class="logo-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M13 3L4 14h7l-2 7 9-11h-7l2-7z" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
        </div>
        <span class="logo-title">LiveClipAI</span>
      </div>

      <nav class="sidebar-nav">
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav-item"
          :class="{ active: isActive(item.path) }"
          :aria-current="isActive(item.path) ? 'page' : undefined"
        >
          <el-icon :size="20"><component :is="item.icon" /></el-icon>
          <span class="nav-label">{{ item.label }}</span>
          <span v-if="item.path === '/notifications' && unreadCount > 0" class="nav-badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
        </router-link>
      </nav>

      <div class="sidebar-bottom">
        <!-- Slice queue status — always visible -->
        <div class="slice-status" :class="{
          'slice-active': sliceQueue.running > 0 || sliceQueue.liveState === 'slicing',
          'slice-burst': sliceQueue.liveState === 'burst',
          'slice-heating': sliceQueue.liveState === 'heating',
        }">
          <div class="slice-status-icon">
            <el-icon :size="16"><Scissor /></el-icon>
            <span v-if="sliceQueue.running > 0 || sliceQueue.liveState === 'burst' || sliceQueue.liveState === 'slicing'" class="slice-status-spinner" />
          </div>
          <div class="slice-status-text">
            <template v-if="sliceQueue.running > 0 || sliceQueue.queued > 0">
              <span class="slice-status-label">
                {{ t('sliceQueue.slicing', { count: sliceQueue.running }) }}
              </span>
              <span v-if="sliceQueue.queued > 0" class="slice-status-queued">
                {{ t('sliceQueue.queued', { count: sliceQueue.queued }) }}
              </span>
            </template>
            <template v-else-if="sliceQueue.liveState === 'burst'">
              <span class="slice-status-label slice-status-burst">{{ t('sliceQueue.burst') }}</span>
            </template>
            <template v-else-if="sliceQueue.liveState === 'heating'">
              <span class="slice-status-label slice-status-heat">{{ t('sliceQueue.heating') }}</span>
            </template>
            <span v-else class="slice-status-idle">{{ t('sliceQueue.idle') }}</span>
          </div>
        </div>
        <button
          class="theme-toggle"
          @click="toggleTheme"
          :title="theme === 'dark' ? t('theme.switchLight') : t('theme.switchDark')"
          :aria-label="theme === 'dark' ? t('theme.switchLight') : t('theme.switchDark')"
          role="switch"
          :aria-checked="theme === 'dark'"
        >
          <el-icon :size="18">
            <Sunny v-if="theme === 'dark'" />
            <Moon v-else />
          </el-icon>
          <span class="theme-label">{{ theme === 'dark' ? t('theme.light') : t('theme.dark') }}</span>
        </button>
        <span class="sidebar-version">v0.3.0</span>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="app-content">
      <transition name="offline-slide">
        <div v-if="isOffline" class="offline-banner">
          <div class="offline-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="1" y1="1" x2="23" y2="23"/>
              <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
              <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
              <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
              <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
              <line x1="12" y1="20" x2="12.01" y2="20"/>
            </svg>
          </div>
          <span class="offline-text">{{ t('network.offline') }}</span>
          <span class="offline-hint">{{ t('network.offlineHint') }}</span>
        </div>
      </transition>
      <router-view v-slot="{ Component }">
        <transition name="fade-slide" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
  </div>
  </el-config-provider>
</template>

<script setup lang="ts">
import { computed, ref, reactive, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import en from 'element-plus/es/locale/lang/en'
import {
  DataBoard,
  Microphone,
  Scissor,
  Bell,
  Setting,
  Sunny,
  Moon,
} from '@element-plus/icons-vue'
import { useTheme } from '@/composables/useTheme'
import { useNotifications } from '@/composables/useNotifications'
import ipc from '@/api/client'

const { t, locale } = useI18n()
const route = useRoute()
const elementLocale = computed(() => locale.value === 'zh-CN' ? zhCn : en)
const { theme, toggleTheme } = useTheme()
const { unreadCount } = useNotifications()

const isOffline = ref(!navigator.onLine)
const onOnline = () => { isOffline.value = false }
const onOffline = () => { isOffline.value = true }

// Slice queue status — global indicator
const sliceQueue = reactive({ running: 0, queued: 0, maxConcurrent: 1, liveState: 'idle' })
let sliceQueueCleanup: (() => void) | null = null
let sliceQueuePollTimer: ReturnType<typeof setInterval> | null = null

function fetchQueueStatus() {
  ipc.invoke('slice-queue:status').then((s: any) => {
    if (s) {
      if (s.running > 0 || s.queued > 0) {
        console.log('[SliceQueue] poll:', JSON.stringify(s))
      }
      Object.assign(sliceQueue, s)
    }
  }).catch(() => {})
}

onMounted(() => {
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  // Load initial slice queue status
  fetchQueueStatus()
  // Listen for real-time push updates
  sliceQueueCleanup = ipc.on('slice-queue:status', (s: any) => {
    console.log('[SliceQueue] push received:', JSON.stringify(s))
    if (s) Object.assign(sliceQueue, s)
  })
  // Poll as fallback every 1s
  sliceQueuePollTimer = setInterval(fetchQueueStatus, 1000)
})
onUnmounted(() => {
  window.removeEventListener('online', onOnline)
  window.removeEventListener('offline', onOffline)
  sliceQueueCleanup?.()
  if (sliceQueuePollTimer) { clearInterval(sliceQueuePollTimer); sliceQueuePollTimer = null }
})

const navItems = computed(() => [
  { path: '/dashboard', label: t('sidebar.workspace'), icon: DataBoard },
  { path: '/live', label: t('sidebar.liveTasks'), icon: Microphone },
  { path: '/clips', label: t('clipManager.title'), icon: Scissor },
  { path: '/notifications', label: t('notification.title'), icon: Bell },
  { path: '/settings', label: t('sidebar.settings'), icon: Setting },
])

function isActive(path: string): boolean {
  if (path === '/live') {
    return route.path === '/live' || route.path.startsWith('/live/')
  }
  return route.path === path || route.path.startsWith(path + '/')
}
</script>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  background: var(--bg-primary);
  transition: background-color 0.3s ease;
}


/* ---- Sidebar ---- */
.app-sidebar {
  width: 220px;
  min-width: 220px;
  max-width: 220px;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-right: 1px solid var(--glass-border);
  padding: 0;
  z-index: 10;
}

.sidebar-logo {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 24px 20px 20px;
}

.logo-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--accent-subtle);
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}

.logo-title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--text-primary);
}

/* ---- Navigation ---- */
.sidebar-nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: color 0.15s var(--ease-out), background 0.15s var(--ease-out);
  position: relative;
  cursor: pointer;
}

/* Indicator bar — always present, animated via opacity + scaleY */
.nav-item::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%) scaleY(0);
  width: 3px;
  height: 20px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
  opacity: 0;
  transition: transform 0.2s var(--ease-out-expo), opacity 0.15s var(--ease-out);
}

.nav-item:hover {
  background: var(--glass-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--accent-subtle);
  color: var(--accent);
}

.nav-item.active::before {
  transform: translateY(-50%) scaleY(1);
  opacity: 1;
}

.nav-item .el-icon {
  flex-shrink: 0;
}

.nav-label {
  white-space: nowrap;
}

.nav-badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--status-danger);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  line-height: 1;
  animation: badgeIn 0.25s var(--ease-out-expo) both;
}

@keyframes badgeIn {
  from { transform: scale(0); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

/* ---- Sidebar Bottom ---- */
.sidebar-bottom {
  padding: 12px 12px 16px;
  border-top: 1px solid var(--glass-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.theme-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: none;
  background: var(--glass-bg);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  width: 100%;
  transition: color 0.15s var(--ease-out), background 0.15s var(--ease-out);
}

.theme-toggle .el-icon {
  transition: transform 0.3s var(--ease-out-expo);
}

.theme-toggle:hover .el-icon {
  transform: rotate(15deg);
}

.theme-toggle:hover {
  background: var(--glass-hover);
  color: var(--text-primary);
}

.theme-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.theme-label {
  white-space: nowrap;
}

.sidebar-version {
  font-size: 11px;
  color: var(--text-tertiary);
  letter-spacing: 0.5px;
  padding-left: 12px;
}

/* ---- Slice Queue Status ---- */
.slice-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--glass-bg);
  margin-bottom: 4px;
  transition: background 0.2s ease;
}

.slice-status.slice-active {
  background: var(--accent-subtle);
}

.slice-status-icon {
  position: relative;
  color: var(--text-tertiary);
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s ease;
}

.slice-active .slice-status-icon {
  color: var(--accent);
}

.slice-status-spinner {
  position: absolute;
  inset: -3px;
  border: 2px solid transparent;
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spinSlice 1s linear infinite;
}

@keyframes spinSlice {
  to { transform: rotate(360deg); }
}

.slice-status-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.slice-status-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  white-space: nowrap;
}

.slice-status-queued {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.slice-status-idle {
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.slice-status-burst {
  color: #ef4444 !important;
}

.slice-status-heat {
  color: #f59e0b !important;
}

.slice-burst {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.2);
}

.slice-heating {
  background: rgba(245, 158, 11, 0.08);
  border-color: rgba(245, 158, 11, 0.2);
}


/* ---- Main Content ---- */
.app-content {
  flex: 1;
  overflow-y: auto;
  padding: 32px;
  min-width: 0;
}

/* ---- Offline Banner ---- */
.offline-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  margin: -32px -32px 24px -32px;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.08) 0%, rgba(251, 146, 60, 0.08) 100%);
  border-bottom: 1px solid rgba(239, 68, 68, 0.15);
  backdrop-filter: blur(8px);
}

.offline-icon {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  animation: offlinePulse 2s ease-in-out infinite;
}

@keyframes offlinePulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.offline-text {
  font-size: 14px;
  font-weight: 600;
  color: #ef4444;
}

.offline-hint {
  font-size: 13px;
  color: var(--text-tertiary);
}

.offline-slide-enter-active {
  transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}

.offline-slide-leave-active {
  transition: all 0.25s ease-in;
}

.offline-slide-enter-from {
  opacity: 0;
  transform: translateY(-100%);
}

.offline-slide-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}
</style>
