<template>
  <div class="dashboard">
    <!-- Top row: 4 stat cards -->
    <div class="stats-grid">
      <div
        v-for="(stat, idx) in statCards"
        :key="stat.key"
        class="glass-card stat-card"
        :style="{ animationDelay: `${idx * 0.08}s` }"
      >
        <div class="stat-icon" :style="{ background: stat.iconBg }">
          <el-icon :size="20" color="#fff"><component :is="stat.icon" /></el-icon>
        </div>
        <div class="stat-value">{{ stat.value }}</div>
        <div class="stat-label">{{ stat.label }}</div>
      </div>
    </div>

    <!-- Middle row: Recent Clips -->
    <div class="glass-card section-card">
      <div class="section-header">
        <h3 class="section-title">{{ t('dashboard.recentClips') }}</h3>
        <router-link to="/live" class="view-all-link">
          {{ t('dashboard.viewAll') }}
          <el-icon :size="14"><ArrowRight /></el-icon>
        </router-link>
      </div>
      <div v-if="recentClips.length > 0" class="clips-scroll">
        <div
          v-for="clip in recentClips"
          :key="clip.slice_id"
          class="clip-card"
          @click="goToClipTask(clip)"
        >
          <div class="clip-cover">
            <img
              v-if="clip.cover_path"
              :src="getSliceThumbUrl(clip.slice_id)"
              alt=""
              loading="lazy"
            />
            <div v-else class="clip-cover-placeholder">
              <el-icon :size="24"><VideoCamera /></el-icon>
            </div>
            <span class="clip-duration">{{ formatDuration(clip.duration) }}</span>
          </div>
          <div class="clip-info">
            <div class="clip-title">{{ clip.selected_title || t('taskDetail.unnamed') }}</div>
            <div class="clip-meta">
              <PlatformIcon v-if="clip.platform" :platform="clip.platform" size="sm" />
              <span class="clip-time">{{ formatTimeShort(clip.created_at) }}</span>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">
        <el-icon :size="32" class="empty-icon"><VideoCamera /></el-icon>
        <span>{{ t('dashboard.noRecentClips') }}</span>
      </div>
    </div>

    <!-- Bottom row: Active Monitors -->
    <div class="glass-card section-card">
      <div class="section-header">
        <h3 class="section-title">{{ t('dashboard.activeMonitors') }}</h3>
        <router-link to="/live" class="view-all-link">
          {{ t('dashboard.viewAll') }}
          <el-icon :size="14"><ArrowRight /></el-icon>
        </router-link>
      </div>
      <div v-if="activeMonitors.length > 0" class="monitor-list">
        <div
          v-for="monitor in activeMonitors"
          :key="monitor.task_id"
          class="monitor-row"
          @click="goToDetail(monitor)"
        >
          <div class="monitor-left">
            <PlatformIcon :platform="monitor.platform" size="sm" />
            <span class="monitor-channel">{{ monitor.video_meta?.author || monitor.video_meta?.title || monitor.source_url }}</span>
          </div>
          <div class="monitor-right">
            <span class="monitor-duration">{{ formatElapsed(monitor.live_stats?.monitor_started_at || monitor.created_at) }}</span>
            <span class="monitor-score-indicator" :class="getScoreLevel(monitor)">
              <span class="score-dot"></span>
              {{ getScoreLabel(monitor) }}
            </span>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">
        <el-icon :size="32" class="empty-icon"><Monitor /></el-icon>
        <span>{{ t('dashboard.noActiveMonitors') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, markRaw } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import i18n from '@/i18n'
import {
  Microphone, ArrowRight, Monitor, VideoCamera,
  Files, CircleCheck, Loading, CircleClose,
} from '@element-plus/icons-vue'
import { getTasks, type TaskInfo } from '@/api/tasks'
import { getAllSlices, getSliceThumbUrl, type SliceInfo } from '@/api/slices'
import { getPublishHistory } from '@/api/publish'
import PlatformIcon from '@/components/PlatformIcon.vue'

const router = useRouter()
const { t } = useI18n()
const allTasks = ref<TaskInfo[]>([])
const recentClips = ref<SliceInfo[]>([])

const processingStatuses = ['starting', 'recording', 'running', 'processing']

const stats = reactive({
  monitoring: 0,
  todaysClips: 0,
  pendingPublish: 0,
  published: 0,
})

const statCards = computed(() => [
  {
    key: 'monitoring',
    label: t('dashboard.monitoring'),
    value: stats.monitoring,
    icon: markRaw(Microphone),
    iconBg: 'var(--accent)',
  },
  {
    key: 'todaysClips',
    label: t('dashboard.todaysClips'),
    value: stats.todaysClips,
    icon: markRaw(Files),
    iconBg: '#3b82f6',
  },
  {
    key: 'pendingPublish',
    label: t('dashboard.pendingPublish'),
    value: stats.pendingPublish,
    icon: markRaw(Loading),
    iconBg: '#f59e0b',
  },
  {
    key: 'published',
    label: t('dashboard.published'),
    value: stats.published,
    icon: markRaw(CircleCheck),
    iconBg: '#22c55e',
  },
])

const activeMonitors = computed(() => {
  return allTasks.value
    .filter(t => processingStatuses.includes(t.status))
    .slice(0, 8)
})

let refreshTimer: ReturnType<typeof setInterval> | null = null

function onVisibilityChange() {
  if (document.hidden) {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  } else {
    loadData()
    loadClips()
    refreshTimer = setInterval(() => { loadData(); loadClips() }, 5000)
  }
}

onMounted(() => {
  loadData()
  loadClips()
  refreshTimer = setInterval(() => { loadData(); loadClips() }, 5000)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

async function loadData() {
  try {
    const data = await getTasks({ page: 1, size: 1000, task_type: 'live' })
    const items = data.items || []
    allTasks.value = items
    stats.monitoring = items.filter((t: TaskInfo) => processingStatuses.includes(t.status)).length
  } catch {
    // handled by interceptor
  }
}

async function loadClips() {
  try {
    const slices = await getAllSlices('live')
    // Count today's clips
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    stats.todaysClips = slices.filter((s: SliceInfo) => {
      if (!s.created_at) return false
      return new Date(s.created_at) >= today
    }).length
    // Take recent 6
    recentClips.value = slices.slice(0, 6)

    // Calculate pending/published counts from publish records
    try {
      const history = await getPublishHistory({ size: 10000 })
      const records = (history as any)?.items || (Array.isArray(history) ? history : [])
      const publishedSliceIds = new Set<string>()
      let publishedCount = 0
      for (const r of records) {
        if (r.status === 'published' || r.status === 'success') {
          publishedSliceIds.add(r.slice_id)
          publishedCount++
        }
      }
      stats.published = publishedCount
      stats.pendingPublish = slices.filter((s: SliceInfo) => !publishedSliceIds.has(s.slice_id)).length
    } catch {
      // No publish history yet - all slices are pending
      stats.pendingPublish = slices.length
      stats.published = 0
    }
  } catch {
    // handled
  }
}

function goToDetail(row: TaskInfo) {
  router.push(`/live/${row.task_id}`)
}

function goToClipTask(clip: SliceInfo) {
  router.push(`/live/${clip.task_id}`)
}

function formatDuration(seconds: number) {
  if (!seconds) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatTimeShort(time?: string) {
  if (!time) return '-'
  const locale = i18n.global.locale.value === 'zh-CN' ? 'zh-CN' : 'en-US'
  const d = new Date(time)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 3600000) return t('dashboard.minutesAgo', { n: Math.floor(diff / 60000) }, `${Math.floor(diff / 60000)}m ago`)
  if (diff < 86400000) return t('dashboard.hoursAgo', { n: Math.floor(diff / 3600000) }, `${Math.floor(diff / 3600000)}h ago`)
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

function formatElapsed(time: string) {
  if (!time) return '-'
  const diff = Date.now() - new Date(time).getTime()
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function getScoreLevel(task: TaskInfo): string {
  const score = task.live_stats?.total_score ?? 0
  const threshold = task.live_stats?.threshold ?? 0.7
  if (score >= threshold) return 'level-hot'
  if (score >= threshold * 0.6) return 'level-active'
  return 'level-calm'
}

function getScoreLabel(task: TaskInfo): string {
  const score = task.live_stats?.total_score ?? 0
  const threshold = task.live_stats?.threshold ?? 0.7
  if (score >= threshold) return t('liveAnalysis.levelHot')
  if (score >= threshold * 0.6) return t('liveAnalysis.levelActive')
  return t('liveAnalysis.levelCalm')
}
</script>

<style scoped>
.dashboard {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* ========== Stats Grid ========== */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
}

.stat-card {
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  animation: fadeInUp 0.35s var(--ease-out-expo) both;
  cursor: default;
  position: relative;
  overflow: hidden;
}

.stat-card:hover {
  transform: none;
  box-shadow: none;
}


.stat-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
}

.stat-value {
  font-size: 44px;
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: -2px;
  color: var(--text-primary);
}

.stat-label {
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* ========== Section Card ========== */
.section-card {
  padding: 24px;
  animation: fadeInUp 0.35s var(--ease-out-expo) 0.2s both;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.view-all-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  text-decoration: none;
  transition: color 0.2s ease;
}

.view-all-link:hover {
  color: var(--accent);
}

/* ========== Recent Clips Scroll ========== */
.clips-scroll {
  display: flex;
  gap: 16px;
  overflow-x: auto;
  padding-bottom: 8px;
}

.clip-card {
  flex: 0 0 200px;
  cursor: pointer;
  overflow: hidden;
  padding: 0;
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
  transition: box-shadow 0.2s var(--ease-out);
  position: relative;
}

.clip-card:hover {
  box-shadow: var(--shadow-md);
}

.clip-card:active {
  transform: scale(0.98);
  transition: transform 80ms;
}

.clip-cover {
  width: 100%;
  height: 112px;
  position: relative;
  overflow: hidden;
  background: var(--bg-tertiary);
}

.clip-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.clip-cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

.clip-duration {
  position: absolute;
  bottom: 6px;
  right: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  backdrop-filter: blur(4px);
}

.clip-info {
  padding: 10px 12px;
}

.clip-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 6px;
}

.clip-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.clip-time {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* ========== Active Monitors ========== */
.monitor-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.monitor-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s var(--ease-out);
}

.monitor-row:hover {
  background: var(--glass-hover);
}

.monitor-row:active {
  background: var(--accent-subtle);
  transition-duration: 80ms;
}

.monitor-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.monitor-channel {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.monitor-right {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}

.monitor-duration {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.monitor-score-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 20px;
  transition: color 0.3s var(--ease-out), background 0.3s var(--ease-out);
}

.score-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.level-calm {
  color: var(--text-secondary);
  background: rgba(148, 163, 184, 0.1);
}
.level-calm .score-dot {
  background: var(--text-secondary);
}

.level-active {
  color: var(--status-warning);
  background: rgba(245, 158, 11, 0.1);
}
.level-active .score-dot {
  background: var(--status-warning);
  animation: statusPulse 1.5s ease-in-out infinite;
}

.level-hot {
  color: var(--status-danger);
  background: rgba(239, 68, 68, 0.1);
}
.level-hot .score-dot {
  background: var(--status-danger);
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.6);
  animation: statusPulse 0.8s ease-in-out infinite;
}

/* ========== Empty State ========== */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 0;
  color: var(--text-tertiary);
  font-size: 13px;
}

.empty-icon {
  opacity: 0.4;
}

/* ========== Responsive ========== */
@media (max-width: 768px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .clip-card {
    flex: 0 0 160px;
  }
}
</style>
