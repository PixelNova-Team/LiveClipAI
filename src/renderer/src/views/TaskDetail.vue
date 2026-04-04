<template>
  <div class="task-detail" v-loading="loading">
    <!-- Back button -->
    <el-button text @click="goBack" class="back-btn">
      <el-icon><ArrowLeft /></el-icon>
      {{ t('taskDetail.backToList') }}
    </el-button>

    <template v-if="task">
      <!-- Task Info Card -->
      <div class="info-card" :class="[`info-card--${task.platform}`]">
        <div class="info-card-top">
          <div class="info-left">
            <PlatformIcon :platform="task.platform" size="lg" />
            <div class="info-meta">
              <h2 class="info-title">
                {{ getPlatformLabel(task.platform) }} {{ task.task_type === 'live' ? t('taskDetail.liveTask') : t('taskDetail.task') }}
                <TaskStatusBadge :status="task.status" />
              </h2>
              <div class="info-id">ID: {{ task.task_id }}</div>
            </div>
          </div>
          <div class="info-actions">
            <!-- Live task: start/stop monitor -->
            <template v-if="isLiveTask">
              <el-button
                v-if="task.status === 'failed' || task.status === 'stopped'"
                type="success"
                round
                size="small"
                @click="handleStartMonitor"
              >
                <el-icon class="el-icon--left"><VideoPlay /></el-icon>
                {{ t('liveTask.turnOn') }}
              </el-button>
              <el-button
                v-if="isProcessing(task.status)"
                type="danger"
                round
                size="small"
                @click="handleStopMonitor"
              >
                <el-icon class="el-icon--left"><VideoPause /></el-icon>
                {{ t('liveTask.turnOff') }}
              </el-button>
            </template>
            <!-- Video task: retry/cancel -->
            <template v-else>
              <el-button
                v-if="task.status === 'failed' || task.status === 'stopped'"
                type="primary"
                round
                size="small"
                @click="handleRetry"
              >
                {{ t('taskDetail.reprocess') }}
              </el-button>
              <el-button
                v-if="isProcessing(task.status)"
                type="warning"
                round
                size="small"
                @click="handleCancel"
              >
                {{ t('taskDetail.cancelTask') }}
              </el-button>
            </template>
          </div>
        </div>

        <el-divider />

        <el-row :gutter="24">
          <el-col :span="12">
            <div class="info-item">
              <span class="info-label">{{ task.task_type === 'live' ? t('taskDetail.liveUrl') : t('taskDetail.videoUrl') }}</span>
              <el-link :href="task.source_url" target="_blank" type="primary" class="info-link">
                {{ task.source_url }}
              </el-link>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="info-item">
              <span class="info-label">{{ t('common.createdAt') }}</span>
              <span class="info-value">{{ formatTime(task.created_at) }}</span>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="info-item">
              <span class="info-label">{{ t('common.updatedAt') }}</span>
              <span class="info-value">{{ formatTime(task.updated_at) }}</span>
            </div>
          </el-col>
        </el-row>

        <!-- Live Stream Section (for live tasks) -->
        <div v-if="isLiveTask" class="live-stream-section" :class="{ 'live-active': isProcessing(task.status) }">
          <div class="live-stream-row">
            <div class="live-stream-left">
              <img
                v-if="task.video_meta?.cover_url"
                :src="task.video_meta.cover_url + (task.video_meta.cover_url.includes('?') ? '&' : '?') + '_t=' + coverCacheBust"
                alt="cover"
                class="live-cover-img"
              />
              <PlatformIcon v-else :platform="task.platform" size="lg" />
              <div class="live-stream-meta">
                <div class="live-stream-title-row">
                  <h3 class="live-stream-title">{{ task.video_meta?.title || task.source_url }}</h3>
                  <div class="live-stream-badge" v-if="isProcessing(task.status)">
                    <span class="live-dot"></span>
                    LIVE
                  </div>
                  <span v-else class="live-ended-badge">{{ t('taskDetail.liveEnded') }}</span>
                </div>
                <span class="live-stream-author" v-if="task.video_meta?.author">{{ task.video_meta.author }}</span>
              </div>
            </div>
            <el-button type="primary" round @click="openLiveRoom">
              <el-icon><Link /></el-icon>
              {{ t('taskDetail.openLiveRoom') }}
            </el-button>
          </div>
        </div>

        <!-- Source Video Player (for video tasks) -->
        <div v-else-if="task.local_video_path" class="source-video-section">
          <div class="source-video-header" @click="sourceVideoExpanded = !sourceVideoExpanded">
            <div class="source-video-info">
              <el-icon><VideoPlay /></el-icon>
              <span>{{ t('taskDetail.sourceVideo') }}</span>
              <el-tag size="small" type="success" effect="plain" round>{{ t('taskDetail.downloaded') }}</el-tag>
            </div>
            <el-icon class="source-collapse-arrow" :class="{ rotated: sourceVideoExpanded }"><ArrowDown /></el-icon>
          </div>
          <el-collapse-transition>
            <div v-show="sourceVideoExpanded" class="source-video-player-wrap">
              <VideoPlayer :src="getSourceVideoUrl(task.task_id)" />
            </div>
          </el-collapse-transition>
        </div>

        <!-- Platform auth warning -->
        <div v-if="isLiveTask && platformAuthChecked && !platformAuthed" class="auth-warning-banner">
          <div class="auth-warning-content">
            <el-icon :size="16"><WarningFilled /></el-icon>
            <span>{{ t('taskDetail.authWarning', { platform: getPlatformLabel(task.platform) }) }}</span>
          </div>
          <el-button type="primary" size="small" round @click="router.push('/settings')">
            {{ t('taskDetail.goToAuth') }}
          </el-button>
        </div>

        <div v-if="task.error_message" class="error-banner">
          <el-icon><WarningFilled /></el-icon>
          {{ task.error_message }}
        </div>

        <!-- Progress Steps (Video tasks: linear pipeline) -->
        <div class="progress-section" v-if="isProcessing(task.status) && !isLiveTask">
          <el-divider />
          <div class="progress-title">{{ t('taskDetail.progress') }}</div>
          <div class="custom-steps">
            <div class="steps-progress-track">
              <div class="steps-progress-fill" :style="{ width: (progressStep / (progressSteps.length - 1) * 100) + '%' }"></div>
            </div>
            <div
              v-for="(step, index) in progressSteps"
              :key="step.key"
              class="custom-step"
              :class="{
                active: index === progressStep,
                done: index < progressStep,
                pending: index > progressStep,
              }"
            >
              <div class="step-icon-wrap">
                <div class="step-glow-ring" v-if="index === progressStep"></div>
                <div class="step-glow-ring step-glow-ring--delayed" v-if="index === progressStep"></div>
                <span v-if="index < progressStep" class="step-checkmark">&#10003;</span>
                <el-icon v-else :size="18"><component :is="step.icon" /></el-icon>
              </div>
              <div class="step-label">{{ step.label }}</div>
            </div>
          </div>
        </div>

      </div>

      <!-- Live Analysis Panel (only during recording/monitoring) -->
      <div class="analysis-panel-wrapper" v-if="isLiveTask && isProcessing(task.status) && task.live_stats">
        <LiveAnalysisPanel
          :stats="task.live_stats"
          :retrying="retryingDanmaku"
          :startTime="task.live_stats?.monitor_started_at || task.created_at"
          @retryDanmaku="handleRetryDanmaku"
        />
      </div>

      <!-- Processing Logs -->
      <div class="section logs-section" v-if="allLogs.length > 0">
        <div class="section-header">
          <h3 class="section-title">
            <el-icon class="logs-icon"><Document /></el-icon>
            {{ t('taskDetail.processingLogs') }}
            <span class="count-badge">{{ allLogs.length }}</span>
          </h3>
          <el-button text type="primary" size="small" @click="logsExpanded = !logsExpanded">
            {{ logsExpanded ? t('taskDetail.collapse') : t('taskDetail.expand') }}
          </el-button>
        </div>
        <el-collapse-transition>
          <div v-show="logsExpanded" class="logs-container">
            <div class="logs-timeline">
              <div
                v-for="(log, idx) in [...allLogs].reverse()"
                :key="idx"
                class="log-entry"
                :class="[`log-${log.level}`]"
              >
                <div class="log-dot-line">
                  <div class="log-dot" :class="[`dot-${log.level}`]">
                    <div class="log-dot-ring"></div>
                  </div>
                  <div class="log-line" v-if="idx < allLogs.length - 1"></div>
                </div>
                <div class="log-content">
                  <div class="log-header">
                    <span class="log-stage" v-if="log.stage">{{ getStageLabel(log.stage) }}</span>
                    <span class="log-time">{{ formatLogTime(log.timestamp) }}</span>
                  </div>
                  <div class="log-message">{{ log.message }}</div>
                </div>
              </div>
            </div>
          </div>
        </el-collapse-transition>
      </div>

      <!-- Slice Results as Grid -->
      <div class="section" v-if="slices.length > 0">
        <div class="section-header">
          <h3 class="section-title">
            {{ t('taskDetail.sliceResults') }}
            <span class="count-badge">{{ slices.length }}</span>
          </h3>
          <el-button type="danger" plain round size="small" @click="handleClearAllSlices">
            <el-icon class="el-icon--left"><Delete /></el-icon>
            {{ t('clipManager.clearAll') }}
          </el-button>
        </div>

        <el-row :gutter="20" v-if="slices.length > 0">
          <el-col :span="8" v-for="slice in slices" :key="slice.slice_id">
            <div class="slice-card">
              <div class="slice-thumb" @click="handlePreview(slice)">
                <img
                  v-if="slice.cover_path"
                  :src="getSliceThumbUrl(slice.slice_id)"
                  class="thumb-cover"
                  @error="($event.target as HTMLImageElement).style.display = 'none'"
                />
                <div class="thumb-placeholder">
                  <el-icon :size="36" color="rgba(255,255,255,0.7)"><VideoPlay /></el-icon>
                </div>
                <div class="duration-badge">
                  {{ formatDuration(slice.duration) }}
                </div>
              </div>
              <div class="slice-body">
                <div class="slice-title" :title="slice.selected_title || undefined">{{ slice.selected_title || t('taskDetail.unnamed') }}</div>
                <div class="slice-desc" v-if="slice.description">{{ slice.description }}</div>
                <div class="slice-time">
                  {{ formatDuration(slice.start_time) }} - {{ formatDuration(slice.end_time) }}
                </div>
                <div class="slice-actions">
                  <el-button text type="primary" size="small" @click="handlePreview(slice)">
                    <el-icon><VideoPlay /></el-icon>
                    {{ t('taskDetail.preview') }}
                  </el-button>
                  <el-button text type="success" size="small" @click="handlePublish(slice)">
                    <el-icon><Promotion /></el-icon>
                    {{ t('taskDetail.publish') }}
                  </el-button>
                  <el-button text type="danger" size="small" @click="handleDeleteSlice(slice)">
                    <el-icon><Delete /></el-icon>
                    {{ t('taskDetail.deleteSlice') }}
                  </el-button>
                </div>
              </div>
            </div>
          </el-col>
        </el-row>
        <el-empty v-else :description="t('taskDetail.noSliceResults')" :image-size="64" />
      </div>

      <!-- Video Preview Dialog -->
      <el-dialog v-model="showPreview" :title="t('taskDetail.videoPreview')" width="720px" destroy-on-close>
        <VideoPlayer v-if="previewUrl" :src="previewUrl" />
      </el-dialog>

      <!-- ASR Results -->
      <div class="section" v-if="task.asr_results && task.asr_results.length > 0">
        <div class="section-header">
          <h3 class="section-title">
            {{ t('taskDetail.asrResults') }}
            <span class="count-badge">{{ task.asr_results.length }}</span>
          </h3>
          <el-button text type="primary" size="small" @click="asrExpanded = !asrExpanded">
            {{ asrExpanded ? t('taskDetail.collapse') : t('taskDetail.expand') }}
          </el-button>
        </div>
        <el-collapse-transition>
          <div v-show="asrExpanded" class="asr-section">
            <div v-if="asrSegments.length > 0" class="asr-timeline">
              <div
                v-for="(seg, idx) in asrSegments"
                :key="idx"
                class="asr-segment"
              >
                <span class="asr-time">
                  {{ seg.time }}
                  <span class="asr-waveform">
                    <span class="wave-bar" v-for="n in 5" :key="n" :style="{ animationDelay: (n * 0.1) + 's', height: [40,70,50,80,35][n-1] + '%' }"></span>
                  </span>
                </span>
                <span class="asr-text">{{ seg.text }}</span>
                <span class="asr-confidence-wrap" v-if="seg.confidence">
                  <span class="asr-confidence-bar">
                    <span class="asr-confidence-fill" :style="{ width: (seg.confidence * 100) + '%' }"></span>
                  </span>
                  <span class="asr-confidence">{{ (seg.confidence * 100).toFixed(0) }}%</span>
                </span>
              </div>
            </div>
            <el-empty v-else :description="t('taskDetail.noASR')" :image-size="48" />
          </div>
        </el-collapse-transition>
      </div>

      <!-- Publish Dialog -->
      <PublishDialog
        v-model="showPublishDialog"
        :slice="selectedSlice"
        @published="loadSlices"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, markRaw } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import i18n from '@/i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowLeft, ArrowDown, VideoPlay, VideoPause, Promotion, Delete, WarningFilled, Document,
  Search, Download, Microphone, DataAnalysis, Scissor, CircleCheck, Link, Loading,
} from '@element-plus/icons-vue'
import { getTask, cancelTask, retryTask, retryDanmaku, getSourceVideoUrl, type TaskInfo } from '@/api/tasks'
import { getAuthStatus } from '@/api/auth'
import { getSlices, getSlicePreviewUrl, getSliceCoverUrl, getSliceThumbUrl, deleteSlice, clearAllSlices, type SliceInfo } from '@/api/slices'
import TaskStatusBadge from '@/components/TaskStatusBadge.vue'
import VideoPlayer from '@/components/VideoPlayer.vue'
import PublishDialog from '@/components/PublishDialog.vue'
import PlatformIcon from '@/components/PlatformIcon.vue'

import LiveAnalysisPanel from '@/components/LiveAnalysisPanel.vue'

const { t } = useI18n()

const props = defineProps<{
  taskType?: string
}>()

const route = useRoute()
const router = useRouter()
const taskId = route.params.id as string

const task = ref<TaskInfo | null>(null)
const slices = ref<SliceInfo[]>([])
const loading = ref(true)
const asrExpanded = ref(false)
const logsExpanded = ref(false) // default collapsed, expanded on load for non-live or stopped tasks

/** Merge logs from processing_logs and live_stats.processing_logs */
const allLogs = computed(() => {
  const seen = new Set<string>()
  const logs: any[] = []

  // Collect from top-level processing_logs (which now includes live_stats logs from backend)
  if (task.value?.processing_logs?.length) {
    for (const log of task.value.processing_logs) {
      const key = `${log.timestamp || log.time}|${log.message}`
      if (!seen.has(key)) {
        seen.add(key)
        logs.push({ ...log, timestamp: log.timestamp || log.time, stage: log.stage || '' })
      }
    }
  }

  // Also check live_stats.processing_logs for redundancy
  if (task.value?.live_stats?.processing_logs?.length) {
    for (const log of task.value.live_stats.processing_logs) {
      const key = `${log.time}|${log.message}`
      if (!seen.has(key)) {
        seen.add(key)
        logs.push({ ...log, timestamp: log.time, stage: '' })
      }
    }
  }

  return logs
})
const sourceVideoExpanded = ref(true)
const showPreview = ref(false)
const previewUrl = ref('')
const showPublishDialog = ref(false)
const selectedSlice = ref<SliceInfo | null>(null)

const platformAuthed = ref(false)
const platformAuthChecked = ref(false)

let refreshTimer: ReturnType<typeof setInterval> | null = null
// Cache-busting for cover image — changes every 60s to force browser refresh
const coverCacheBust = ref(Math.floor(Date.now() / 60000))

const processingStatuses = ['starting', 'recording', 'running', 'processing']

const isLiveTask = computed(() => task.value?.task_type === 'live')

const progressSteps = computed(() => {
  return [
    { key: 'running', label: t('taskDetail.stepMonitoring'), icon: markRaw(DataAnalysis) },
    { key: 'stopped', label: t('taskDetail.stepStopped'), icon: markRaw(CircleCheck) },
  ]
})

const progressStep = computed(() => {
  if (!task.value) return 0
  const status = task.value.status
  if (isProcessing(status)) return 0
  if (status === 'stopped' || status === 'completed') return 1
  return 0 // failed
})


function openLiveRoom() {
  if (task.value?.source_url) {
    window.open(task.value.source_url, '_blank')
  }
}

const asrSegments = computed(() => {
  if (!task.value?.asr_results) return []
  const asr = task.value.asr_results
  if (Array.isArray(asr)) {
    return asr.map((item: any) => ({
      time: item.start_time != null ? formatDuration(item.start_time) : '',
      text: item.text || '',
      confidence: item.confidence || 0,
    })).filter((s: any) => s.text)
  }
  return []
})

const stageKeyMap: Record<string, string> = {
  init: 'taskDetail.stageInit',
  parsing: 'taskDetail.stageParsing',
  downloading: 'taskDetail.stageDownloading',
  asr: 'taskDetail.stageASR',
  analyzing: 'taskDetail.stageAnalyzing',
  slicing: 'taskDetail.stageSlicing',
  processing: 'taskDetail.stageProcessing',
  monitor: 'taskDetail.stageMonitor',
  slice_worker: 'taskDetail.stageSlicing',
  stopped: 'taskDetail.stageStopped',
  error: 'taskDetail.stageError',
}

function getStageLabel(stage: string) {
  return t(stageKeyMap[stage] || stage, stage)
}

function isProcessing(status: string) {
  return processingStatuses.includes(status)
}

function goBack() {
  const backPath = props.taskType === 'live' ? '/live' : '/video'
  router.push(backPath)
}

onMounted(async () => {
  await loadTask()
  await loadSlices()
  loading.value = false

  // Default logs to expanded for non-live or stopped tasks
  const isLiveProcessing = task.value?.task_type === 'live' && task.value?.status && isProcessing(task.value.status)
  logsExpanded.value = !isLiveProcessing

  // Check platform auth for live tasks
  if (task.value?.task_type === 'live' && task.value.platform) {
    try {
      const res = await getAuthStatus(task.value.platform)
      platformAuthed.value = res.authenticated
    } catch {
      platformAuthed.value = false
    }
    platformAuthChecked.value = true
  }
  let wasProcessing = task.value ? isProcessing(task.value.status) : false
  refreshTimer = setInterval(async () => {
    if (!task.value) return
    // Update cover cache bust every 60s
    coverCacheBust.value = Math.floor(Date.now() / 60000)
    const currentlyProcessing = isProcessing(task.value.status)
    if (currentlyProcessing || wasProcessing) {
      // Keep refreshing while processing, plus one extra refresh after status changes to terminal
      await loadTask()
      await loadSlices()
      wasProcessing = isProcessing(task.value!.status)
    }
  }, 1000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})

async function loadTask() {
  try {
    task.value = await getTask(taskId)
  } catch {
    // handled
  }
}

async function loadSlices() {
  try {
    slices.value = await getSlices(taskId)
  } catch {
    slices.value = []
  }
}

async function handleRetry() {
  try {
    await retryTask(taskId)
    ElMessage.success(t('taskDetail.retrySubmitted'))
    await loadTask()
  } catch {
    ElMessage.error(t('taskDetail.retryFailed'))
  }
}

const retryingDanmaku = ref(false)

async function handleRetryDanmaku() {
  retryingDanmaku.value = true
  try {
    const res = await retryDanmaku(taskId)
    if (res.connected) {
      ElMessage.success(t('liveAnalysis.danmakuRetrySuccess'))
    } else {
      ElMessage.warning(t('liveAnalysis.danmakuRetryFailed'))
    }
    await loadTask()
  } catch {
    ElMessage.error(t('liveAnalysis.danmakuRetryFailed'))
  } finally {
    retryingDanmaku.value = false
  }
}

async function handleCancel() {
  try {
    await ElMessageBox.confirm(t('taskDetail.confirmCancel'), t('taskDetail.cancelTaskTitle'), { type: 'warning' })
    await cancelTask(taskId)
    ElMessage.success(t('taskDetail.taskCancelled'))
    await loadTask()
  } catch {
    // user cancelled
  }
}

async function handleStartMonitor() {
  try {
    await retryTask(taskId)
    ElMessage.success(t('liveTask.turnedOn'))
    await loadTask()
  } catch {
    // handled
  }
}

async function handleStopMonitor() {
  try {
    await ElMessageBox.confirm(t('liveTask.confirmTurnOff'), t('liveTask.turnOff'), { type: 'warning' })
    await cancelTask(taskId)
    ElMessage.success(t('liveTask.turnedOff'))
    await loadTask()
  } catch {
    // user cancelled
  }
}

function handleSourcePreview() {
  if (!task.value) return
  previewUrl.value = getSourceVideoUrl(task.value.task_id)
  showPreview.value = true
}

function handlePreview(slice: SliceInfo) {
  previewUrl.value = getSlicePreviewUrl(slice.slice_id)
  showPreview.value = true
}

function handlePublish(slice: SliceInfo) {
  selectedSlice.value = slice
  showPublishDialog.value = true
}

async function handleDeleteSlice(slice: SliceInfo) {
  try {
    await ElMessageBox.confirm(t('taskDetail.confirmDeleteSlice'), t('taskDetail.deleteSliceTitle'), { type: 'warning' })
    await deleteSlice(slice.slice_id)
    ElMessage.success(t('taskDetail.sliceDeleted'))
    loadSlices()
  } catch {
    // user cancelled
  }
}

async function handleClearAllSlices() {
  try {
    await ElMessageBox.confirm(t('clipManager.clearAllConfirm'), t('clipManager.clearAllTitle'), { type: 'warning' })
    await clearAllSlices()
    slices.value = []
    ElMessage.success(t('clipManager.clearAllDone'))
  } catch {
    // user cancelled
  }
}

function getPlatformLabel(platform: string) {
  return t(`platform.${platform}`, platform)
}


function formatTime(time: string) {
  if (!time) return '-'
  const locale = i18n.global.locale.value
  return new Date(time).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')
}

function formatLogTime(time: string) {
  if (!time) return ''
  const d = new Date(time)
  const locale = i18n.global.locale.value
  return d.toLocaleTimeString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(seconds: number) {
  if (seconds == null) return '-'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

</script>

<style scoped>
.task-detail {
  max-width: 1200px;
  margin: 0 auto;
}

.back-btn {
  margin-bottom: 20px;
  color: var(--text-secondary);
  font-size: 14px;
}

.back-btn:hover {
  color: var(--primary-color);
}

/* ========== Info Card with platform gradient top border ========== */
.info-card {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border-radius: var(--card-radius);
  padding: 28px;
  box-shadow: var(--card-shadow);
  border: 1px solid var(--glass-border);
  margin-bottom: 24px;
  animation: fadeInUp 0.5s ease;
  position: relative;
  overflow: hidden;
}

.info-card:hover {
  border-color: rgba(240, 86, 56, 0.15);
  box-shadow: 0 4px 24px rgba(240, 86, 56, 0.08);
}
html.light .info-card {
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 4px 16px rgba(0, 0, 0, 0.03);
}
html.light .info-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06), 0 8px 24px rgba(240, 86, 56, 0.06);
}
html.light .info-id {
  background: rgba(0, 0, 0, 0.04);
  border-color: rgba(0, 0, 0, 0.06);
}
html.light .live-ended-badge {
  background: rgba(0, 0, 0, 0.05);
}

.info-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  background: var(--accent);
  z-index: 1;
}

/* Platform-specific gradient top borders */
.info-card--bilibili::before {
  background: linear-gradient(90deg, #fb7299, #ff9ab5);
}

.info-card--douyin::before {
  background: linear-gradient(90deg, #010101, #25f4ee, #fe2c55);
}

.info-card--douyu::before {
  background: linear-gradient(90deg, #ff6a00, #ffba00);
}

.info-card--kuaishou::before {
  background: linear-gradient(90deg, #ff4906, #ff7e29);
}

.info-card--huya::before {
  background: linear-gradient(90deg, #f5a623, #ffcc02);
}

.info-card--youtube::before {
  background: linear-gradient(90deg, #ff0000, #cc0000);
}

.info-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.info-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.info-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Code-style background for info-id */
.info-id {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  background: rgba(255, 255, 255, 0.04);
  padding: 2px 10px;
  border-radius: 4px;
  border: 1px solid var(--glass-border);
  display: inline-block;
  letter-spacing: 0.3px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.info-label {
  font-size: 12px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.info-value {
  font-size: 14px;
  color: var(--text-primary);
}

.info-link {
  font-size: 14px;
  word-break: break-all;
  text-align: left;
  justify-content: flex-start;
}

/* Source video section with inline player */
.source-video-section {
  margin-top: 16px;
  background: rgba(240, 86, 56, 0.05);
  border: 1px solid rgba(240, 86, 56, 0.15);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.source-video-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.source-video-header:hover {
  background: rgba(240, 86, 56, 0.08);
}

.source-video-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--primary-color);
  font-weight: 500;
}

.source-collapse-arrow {
  font-size: 14px;
  color: var(--text-tertiary);
  transition: transform 0.35s cubic-bezier(0.68, -0.55, 0.265, 1.55);
}

.source-collapse-arrow.rotated {
  transform: rotate(180deg);
}

.source-video-player-wrap {
  padding: 0 16px 16px;
}

.source-video-player-wrap :deep(video) {
  border-radius: 8px;
  max-height: 480px;
  width: 100%;
  background: #000;
}

/* Live stream section */
.live-stream-section {
  margin-top: 16px;
  background: linear-gradient(135deg, rgba(255, 77, 79, 0.04), rgba(255, 77, 79, 0.08));
  border: 1px solid rgba(255, 77, 79, 0.15);
  border-radius: 12px;
  padding: 20px;
  position: relative;
  overflow: hidden;
}

.live-stream-section.live-active {
  border-color: rgba(255, 77, 79, 0.3);
  box-shadow: 0 0 20px rgba(255, 77, 79, 0.08);
}

.live-stream-section.live-active::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, #ff4d4f, #ff7875, #ff4d4f);
  background-size: 200% 100%;
  animation: live-gradient 2s linear infinite;
}

@keyframes live-gradient {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.live-stream-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.live-stream-left {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  flex: 1;
}

.live-cover-img {
  width: 80px;
  height: 50px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.live-stream-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.live-stream-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.live-stream-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}



.live-stream-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #ff4d4f;
  color: white;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  flex-shrink: 0;
  box-shadow: 0 0 12px rgba(255, 77, 79, 0.4);
}

.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.8);
  animation: live-blink 1.5s ease-in-out infinite;
}

@keyframes live-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.live-ended-badge {
  font-size: 12px;
  color: var(--text-tertiary);
  background: rgba(255, 255, 255, 0.06);
  padding: 3px 10px;
  border-radius: 20px;
  font-weight: 500;
  flex-shrink: 0;
}

.live-stream-author {
  font-size: 13px;
  color: var(--text-secondary);
}

/* ========== Live Progress ========== */
.progress-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.live-phase-hint {
  font-size: 13px;
  color: var(--text-tertiary);
  font-style: italic;
}

.cycle-return-hint {
  position: absolute;
  bottom: -16px;
  right: -8px;
  font-size: 16px;
  color: var(--status-success);
  font-weight: 700;
  opacity: 0.6;
}

.live-slice-count {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 16px;
  font-size: 13px;
  color: var(--primary-color);
  font-weight: 600;
}

/* Frosted glass error banner */
.auth-warning-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  margin-top: 12px;
  background: rgba(245, 158, 11, 0.1);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: var(--radius-sm);
  color: var(--el-color-warning);
  font-size: 13px;
}

.auth-warning-content {
  display: flex;
  align-items: center;
  gap: 8px;
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(239, 68, 68, 0.1);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: var(--radius-sm);
  color: var(--status-danger);
  font-size: 13px;
  margin-top: 16px;
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.1);
}

/* ========== Custom Progress Steps with glow & gradient line ========== */
.progress-section {
  position: relative;
}

.progress-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 20px;
}

.custom-steps {
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: relative;
}

/* Background track */
.steps-progress-track {
  position: absolute;
  top: 18px;
  left: 24px;
  right: 24px;
  height: 3px;
  background: var(--glass-border);
  z-index: 0;
  border-radius: 2px;
  overflow: hidden;
}

/* Animated gradient fill */
.steps-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), #3b82f6, #06b6d4);
  background-size: 200% 100%;
  border-radius: 2px;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  animation: shimmer-progress 3s ease infinite;
  box-shadow: 0 0 8px rgba(240, 86, 56, 0.4);
}

@keyframes shimmer-progress {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.custom-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  position: relative;
  z-index: 1;
}

.step-icon-wrap {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  color: var(--text-tertiary);
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
}

/* Completed step checkmark */
.step-checkmark {
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  animation: checkPop 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
}

@keyframes checkPop {
  0% { transform: scale(0) rotate(-45deg); opacity: 0; }
  60% { transform: scale(1.2) rotate(5deg); }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}

.custom-step.done .step-icon-wrap {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 2px 8px rgba(240, 86, 56, 0.3);
}

.custom-step.active .step-icon-wrap {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 0 0 4px rgba(240, 86, 56, 0.2);
}

/* Animated glow rings for active step */
.step-glow-ring {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid rgba(240, 86, 56, 0.4);
  animation: glow-ring-expand 2s ease-out infinite;
  pointer-events: none;
}

.step-glow-ring--delayed {
  animation-delay: 1s;
}

@keyframes glow-ring-expand {
  0% {
    inset: -2px;
    opacity: 0.8;
    border-color: rgba(240, 86, 56, 0.6);
  }
  100% {
    inset: -16px;
    opacity: 0;
    border-color: rgba(240, 86, 56, 0);
  }
}

.custom-step.pending .step-icon-wrap {
  background: var(--glass-bg);
  color: var(--text-tertiary);
}

.step-label {
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: 500;
}

.custom-step.active .step-label,
.custom-step.done .step-label {
  color: var(--primary-color);
  font-weight: 600;
}

@keyframes pulse-step {
  0%, 100% { box-shadow: 0 0 0 4px rgba(240, 86, 56, 0.2); }
  50% { box-shadow: 0 0 0 8px rgba(240, 86, 56, 0.1); }
}

/* ========== Section ========== */
.section {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border-radius: var(--card-radius);
  padding: 24px;
  box-shadow: var(--card-shadow);
  border: 1px solid var(--glass-border);
  margin-bottom: 24px;
  animation: fadeInUp 0.5s ease 0.1s both;
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
  display: flex;
  align-items: center;
  gap: 8px;
}

.count-badge {
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  padding: 2px 10px;
  border-radius: 20px;
}

/* ========== Analysis Panel Wrapper ========== */
.analysis-panel-wrapper {
  margin-bottom: 28px;
  animation: fadeInUp 0.5s ease 0.05s both;
}

/* ========== Processing Logs with slide-in & accent borders ========== */
.logs-section {
  animation: fadeInUp 0.5s ease 0.1s both;
}

.logs-icon {
  color: var(--primary-color);
}

.logs-container {
  max-height: 400px;
  overflow-y: auto;
  overflow-x: visible;
  padding-right: 8px;
}

.logs-timeline {
  display: flex;
  flex-direction: column;
  padding-left: 6px;
}

.log-entry {
  display: flex;
  gap: 14px;
  min-height: 40px;
  border-left: 3px solid transparent;
  padding-left: 8px;
  margin-left: -3px;
  border-radius: 0 6px 6px 0;
  animation: log-slide-in 0.35s cubic-bezier(0.4, 0, 0.2, 1) both;
  transition: background 0.15s ease;
}

.log-entry:hover {
  background: rgba(255, 255, 255, 0.02);
}

/* Level-based left border accents */
.log-entry.log-info {
  border-left-color: rgba(240, 86, 56, 0.4);
}

.log-entry.log-warning {
  border-left-color: rgba(245, 158, 11, 0.5);
}

.log-entry.log-error {
  border-left-color: rgba(239, 68, 68, 0.5);
}

/* Staggered slide-in animations */
.log-entry:nth-child(1) { animation-delay: 0s; }
.log-entry:nth-child(2) { animation-delay: 0.04s; }
.log-entry:nth-child(3) { animation-delay: 0.08s; }
.log-entry:nth-child(4) { animation-delay: 0.12s; }
.log-entry:nth-child(5) { animation-delay: 0.16s; }
.log-entry:nth-child(6) { animation-delay: 0.2s; }
.log-entry:nth-child(7) { animation-delay: 0.24s; }
.log-entry:nth-child(8) { animation-delay: 0.28s; }
.log-entry:nth-child(9) { animation-delay: 0.32s; }
.log-entry:nth-child(10) { animation-delay: 0.36s; }

@keyframes log-slide-in {
  0% {
    opacity: 0;
    transform: translateX(-12px);
  }
  100% {
    opacity: 1;
    transform: translateX(0);
  }
}

.log-dot-line {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 20px;
  flex-shrink: 0;
}

/* Gradient dots for timeline */
.log-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 5px;
  transition: all 0.3s ease;
  position: relative;
}

.log-dot-ring {
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  opacity: 0.25;
}

.dot-info {
  background: radial-gradient(circle, #f87171, var(--accent));
  box-shadow: 0 0 6px rgba(240, 86, 56, 0.3);
}

.dot-warning {
  background: radial-gradient(circle, #fbbf24, #f59e0b);
  box-shadow: 0 0 6px rgba(245, 158, 11, 0.3);
}

.dot-error {
  background: radial-gradient(circle, #f87171, #ef4444);
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.3);
}

.log-line {
  width: 2px;
  flex: 1;
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.04));
  min-height: 16px;
}

.log-content {
  flex: 1;
  padding-bottom: 14px;
}

.log-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 3px;
}

.log-stage {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: rgba(240, 86, 56, 0.12);
  padding: 1px 8px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.log-entry.log-warning .log-stage {
  color: var(--status-warning);
  background: rgba(245, 158, 11, 0.12);
}

.log-entry.log-error .log-stage {
  color: var(--status-danger);
  background: rgba(239, 68, 68, 0.12);
}

.log-time {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: monospace;
}

.log-message {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.log-entry.log-warning .log-message {
  color: var(--status-warning);
}

.log-entry.log-error .log-message {
  color: var(--status-danger);
  font-weight: 500;
}

/* ========== Slice Cards with film-strip & play pulse ========== */
.slice-card {
  background: var(--glass-bg);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  overflow: hidden;
  margin-bottom: 20px;
  transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.slice-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 32px rgba(240, 86, 56, 0.1);
  border-color: rgba(240, 86, 56, 0.15);
}

.slice-thumb {
  position: relative;
  background: linear-gradient(135deg, #1a1c2e, #2d2e3e);
  height: 140px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
}

.thumb-cover {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 1;
}

/* Film-strip pattern on thumbnail background */
.slice-thumb::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    repeating-linear-gradient(
      90deg,
      transparent,
      transparent 18px,
      rgba(255,255,255,0.03) 18px,
      rgba(255,255,255,0.03) 20px
    );
  pointer-events: none;
  z-index: 1;
}

/* Top and bottom film perforations */
.slice-thumb::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    repeating-linear-gradient(
      90deg,
      transparent,
      transparent 14px,
      rgba(255,255,255,0.06) 14px,
      rgba(255,255,255,0.06) 18px,
      transparent 18px,
      transparent 22px
    );
  background-size: 100% 10px;
  background-repeat: no-repeat;
  background-position: top;
  pointer-events: none;
  z-index: 1;
  box-shadow: inset 0 -10px 0 0 transparent;
}

/* Play button overlay on thumbnail */
.thumb-placeholder {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
  z-index: 2;
}

/* Play button pulse animation on hover */
.slice-card:hover .thumb-placeholder {
  background: rgba(255,255,255,0.2);
  transform: scale(1.1);
  box-shadow: 0 0 0 0 rgba(255,255,255,0.4);
  animation: play-pulse 1.5s ease-out infinite;
}

@keyframes play-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(255,255,255,0.4);
  }
  70% {
    box-shadow: 0 0 0 14px rgba(255,255,255,0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255,255,255,0);
  }
}

/* Subtle gradient overlay on thumbnail bottom */
.slice-thumb > .duration-badge {
  z-index: 3;
}

.slice-card .slice-thumb {
  background:
    linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.45) 100%),
    linear-gradient(135deg, #1a1c2e, #2d2e3e);
}

.duration-badge {
  position: absolute;
  bottom: 8px;
  right: 8px;
  background: rgba(0,0,0,0.7);
  color: #fff;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  font-family: monospace;
  z-index: 3;
  backdrop-filter: blur(4px);
}

.slice-body {
  padding: 14px;
}

.slice-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slice-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.4;
}

.slice-time {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 12px;
  font-family: monospace;
}

.slice-actions {
  display: flex;
  gap: 4px;
  border-top: 1px solid var(--glass-border);
  padding-top: 10px;
}

/* ========== ASR Section with waveform & confidence bar ========== */
.asr-section {
  max-height: 400px;
  overflow-y: auto;
}

.asr-timeline {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.asr-segment {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.asr-segment:hover {
  background: rgba(255, 255, 255, 0.03);
}

.asr-time {
  font-size: 12px;
  font-family: monospace;
  color: var(--accent);
  background: rgba(240, 86, 56, 0.12);
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Waveform visual indicator */
.asr-waveform {
  display: inline-flex;
  align-items: center;
  gap: 1.5px;
  height: 14px;
  vertical-align: middle;
}

.wave-bar {
  width: 2px;
  background: var(--primary-color);
  border-radius: 1px;
  opacity: 0.5;
  animation: wave-dance 1.2s ease-in-out infinite alternate;
  min-height: 3px;
}

.asr-segment:hover .wave-bar {
  opacity: 0.9;
  animation: wave-dance 0.6s ease-in-out infinite alternate;
}

@keyframes wave-dance {
  0% { transform: scaleY(0.4); }
  100% { transform: scaleY(1); }
}

.asr-text {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  flex: 1;
}

/* Confidence with tiny progress bar */
.asr-confidence-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.asr-confidence-bar {
  width: 40px;
  height: 4px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 2px;
  overflow: hidden;
}

.asr-confidence-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.4s ease;
}

.asr-confidence {
  font-size: 11px;
  color: var(--text-tertiary);
  flex-shrink: 0;
  font-family: monospace;
  min-width: 28px;
  text-align: right;
}

/* Live slicing sub-indicator under monitoring step */
.step-slicing-sub {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 11px;
  color: #e6a23c;
  font-weight: 500;
  animation: pulse-step 1.5s ease-in-out infinite;
}

/* Live slicing sub-indicator in header */
.slicing-sub {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #e6a23c;
  font-weight: 500;
  margin-left: 8px;
}

.slicing-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #e6a23c;
  animation: pulse-dot 1.5s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.slice-fade-enter-active { animation: slice-in 0.3s ease-out; }
.slice-fade-leave-active { animation: slice-in 0.3s ease-in reverse; }
@keyframes slice-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
