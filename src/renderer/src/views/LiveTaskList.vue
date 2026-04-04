<template>
  <div class="live-task-list">
    <!-- Page Header -->
    <div class="page-header">
      <h2 class="page-title">{{ t('liveTask.title') }}</h2>
      <div class="page-header-right">
        <label class="select-all-wrap" @click.stop>
          <input
            type="checkbox"
            class="modern-checkbox"
            :checked="isAllSelected"
            :indeterminate="isPartialSelected"
            @change="toggleSelectAll"
          />
          <span class="select-all-label">{{ t('common.selectAll') }}</span>
        </label>
        <transition name="fade">
          <el-button v-if="selectedIds.length > 0" type="danger" round @click="handleBatchDelete">
            <el-icon><Delete /></el-icon>
            {{ t('liveTask.batchDelete') }} ({{ selectedIds.length }})
          </el-button>
        </transition>
        <el-button round @click="openNewRecordDialog" class="gradient-btn">
          <el-icon><Plus /></el-icon>
          {{ t('liveTask.newRecording') }}
        </el-button>
      </div>
    </div>

    <!-- Watched Streamers -->
    <div class="streamer-section">
      <div class="streamer-header">
        <span class="streamer-title">{{ t('streamer.title') }} ({{ streamers.length }})</span>
        <div class="streamer-header-actions">
          <button v-if="streamers.length > 0" class="streamer-action-btn" @click="handlePollNow" :disabled="pollLoading">
            <el-icon :size="14"><Refresh /></el-icon>
            {{ pollLoading ? t('streamer.polling') : t('streamer.pollNow') }}
          </button>
          <button class="streamer-action-btn primary" @click="showAddStreamer = true">
            <el-icon :size="14"><Plus /></el-icon>
            {{ t('streamer.addStreamer') }}
          </button>
        </div>
      </div>

      <!-- Streamer cards -->
      <div v-if="streamers.length > 0" class="streamer-strip">
        <div
          v-for="s in streamers"
          :key="s.streamer_id"
          class="streamer-card"
          :class="{ 'is-live': s.is_live, 'is-disabled': !s.enabled }"
          @click="s.active_task_id ? goToDetail({ task_id: s.active_task_id } as any) : undefined"
        >
          <div class="streamer-status-dot" :class="s.is_live ? 'dot-live' : 'dot-offline'"></div>
          <div class="streamer-info">
            <div class="streamer-name">{{ s.nickname || s.room_url }}</div>
            <div class="streamer-meta">
              <PlatformIcon :platform="s.platform" size="sm" />
              <span class="streamer-mode">{{ s.mode === 'persistent' ? t('streamer.persistent') : t('streamer.once') }}</span>
            </div>
          </div>
          <div class="streamer-card-actions" @click.stop>
            <el-dropdown trigger="click" @command="(cmd: string) => handleStreamerAction(cmd, s)">
              <button class="streamer-more-btn">
                <el-icon :size="14"><MoreFilled /></el-icon>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item :command="s.enabled ? 'disable' : 'enable'">
                    {{ s.enabled ? t('streamer.disable') : t('streamer.enable') }}
                  </el-dropdown-item>
                  <el-dropdown-item
                    :command="s.mode === 'persistent' ? 'mode-once' : 'mode-persistent'"
                  >
                    {{ s.mode === 'persistent' ? t('streamer.once') : t('streamer.persistent') }}
                  </el-dropdown-item>
                  <el-dropdown-item command="delete" divided>
                    {{ t('streamer.delete') }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else class="streamer-empty">
        <span class="streamer-empty-text">{{ t('streamer.noStreamersHint') }}</span>
      </div>
    </div>

    <!-- Tab Filters -->
    <div class="filter-tabs">
      <div class="tab-bar">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab-item"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key; handleTabChange()"
        >
          {{ tab.label }}
          <span class="tab-count">{{ tab.count }}</span>
        </button>
      </div>
      <!-- Platform Filter Pills -->
      <div class="platform-pills" v-if="platformPills.length > 1">
        <button
          v-for="pill in platformPills"
          :key="pill.key"
          class="platform-pill"
          :class="{ active: activePlatform === pill.key }"
          @click="activePlatform = pill.key; handleTabChange()"
        >
          <PlatformIcon v-if="pill.key !== 'all'" :platform="pill.key" size="sm" />
          {{ pill.label }}
          <span class="pill-count">({{ pill.count }})</span>
        </button>
      </div>
    </div>

    <!-- Task Card Grid -->
    <div class="task-grid" v-loading="loading">
      <div
        v-for="task in tasks"
        :key="task.task_id"
        class="task-card glass-card"
        :class="{ 'is-selected': selectedIds.includes(task.task_id) }"
        @click="goToDetail(task)"
      >
        <!-- Cover Image -->
        <div class="card-cover">
          <img
            v-if="task.video_meta?.cover_url"
            :src="task.video_meta.cover_url + (task.video_meta.cover_url.includes('?') ? '&' : '?') + '_t=' + coverCacheBust"
            alt="cover"
            class="cover-img"
            @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'"
          />
          <div v-else class="cover-placeholder">
            <span class="cover-placeholder-text">{{ t('liveTask.notStarted') }}</span>
          </div>
          <span v-if="isActive(task.status)" class="live-badge">LIVE</span>
          <div class="card-checkbox-overlay" @click.stop>
            <input
              type="checkbox"
              :checked="selectedIds.includes(task.task_id)"
              @change="toggleSelect(task)"
              class="modern-checkbox"
            />
          </div>
        </div>

        <!-- Card Header: Status -->
        <div class="card-header">
          <span class="monitor-indicator" :class="isActive(task.status) ? 'is-on' : 'is-off'">
            <span class="indicator-dot"></span>
            {{ isActive(task.status) ? t('liveTask.statusOn') : t('liveTask.statusOff') }}
          </span>
        </div>

        <!-- Card Body: Platform + Channel -->
        <div class="card-body">
          <div class="platform-badge">
            <PlatformIcon :platform="task.platform" />
          </div>
          <div class="card-info">
            <span class="platform-name">{{ getPlatformLabel(task.platform) }}</span>
            <span class="channel-name" v-if="task.video_meta?.author">{{ task.video_meta.author }}</span>
            <span class="channel-url" v-else>{{ task.source_url }}</span>
          </div>
        </div>

        <!-- Card Footer: Time + Actions -->
        <div class="card-footer">
          <div class="card-time">
            <el-icon :size="13" class="time-icon"><Clock /></el-icon>
            <span>{{ formatTime(task.created_at) }}</span>
          </div>
          <div class="card-actions" @click.stop>
            <button
              v-if="!isStreamerWatched(task.source_url)"
              class="action-btn action-watch"
              :title="t('streamer.addStreamer')"
              :aria-label="t('streamer.addStreamer')"
              @click="handleWatchFromTask(task)"
            >
              <el-icon :size="14"><Star /></el-icon>
            </button>
            <button
              v-else
              class="action-btn action-unwatch"
              :title="t('streamer.unfollow')"
              :aria-label="t('streamer.unfollow')"
              @click="handleUnwatchFromTask(task)"
            >
              <el-icon :size="14"><StarFilled /></el-icon>
            </button>
            <button
              v-if="isActive(task.status)"
              class="action-btn action-off"
              :title="t('liveTask.turnOff')"
              :aria-label="t('liveTask.turnOff')"
              @click="handleStop(task)"
            >
              <el-icon :size="14"><VideoPause /></el-icon>
            </button>
            <button
              v-else
              class="action-btn action-on"
              :title="t('liveTask.turnOn')"
              :aria-label="t('liveTask.turnOn')"
              @click="handleStart(task)"
            >
              <el-icon :size="14"><VideoPlay /></el-icon>
            </button>
            <button
              class="action-btn action-danger"
              :title="t('common.delete')"
              :aria-label="t('common.delete')"
              @click="handleDelete(task)"
            >
              <el-icon :size="14"><Delete /></el-icon>
            </button>
          </div>
        </div>
      </div>

      <!-- Add New Card -->
      <div class="task-card add-card" @click="openNewRecordDialog">
        <el-icon :size="32" color="var(--text-tertiary)"><Plus /></el-icon>
        <span class="add-text">{{ t('liveTask.newRecording') }}</span>
      </div>
    </div>

    <el-empty v-if="!loading && tasks.length === 0" :description="t('liveTask.noTasks')" :image-size="80" />

    <div class="pagination-wrapper" v-if="total > pageSize">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        @current-change="loadTasks"
        @size-change="loadTasks"
        background
      />
    </div>

    <!-- Add Streamer Dialog -->
    <el-dialog v-model="showAddStreamer" :title="t('streamer.addDialog')" width="480px" style="max-width: 92vw" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item :label="t('streamer.urlLabel')">
          <el-input v-model="newStreamerUrl" :placeholder="t('streamer.urlPlaceholder')" clearable size="large" @input="detectStreamerPlatform">
            <template #prefix>
              <PlatformIcon v-if="detectedStreamerPlatform" :platform="detectedStreamerPlatform" size="sm" />
              <el-icon v-else><Link /></el-icon>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item :label="t('streamer.mode')">
          <el-radio-group v-model="newStreamerMode">
            <el-radio value="persistent">
              {{ t('streamer.persistent') }}
              <span class="form-tip">{{ t('streamer.persistentDesc') }}</span>
            </el-radio>
            <el-radio value="once">
              {{ t('streamer.once') }}
              <span class="form-tip">{{ t('streamer.onceDesc') }}</span>
            </el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddStreamer = false" round>{{ t('common.cancel') }}</el-button>
        <el-button :loading="addingStreamer" @click="handleAddStreamer" round class="gradient-btn">{{ t('streamer.addStreamer') }}</el-button>
      </template>
    </el-dialog>

    <!-- New Record Dialog -->
    <el-dialog v-model="showNewRecord" :title="t('liveTask.newRecordDialog')" width="520px" style="max-width: 92vw" :close-on-click-modal="false">
      <el-form label-width="100px" class="record-form">
        <el-form-item :label="t('liveTask.liveUrlLabel')">
          <el-input v-model="newRecordUrl" :placeholder="t('liveTask.liveUrlPlaceholder')" clearable size="large" @input="detectPlatform">
            <template #prefix>
              <PlatformIcon v-if="detectedPlatform" :platform="detectedPlatform" size="sm" />
              <el-icon v-else><Link /></el-icon>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item :label="t('liveTask.livePlatform')">
          <el-select v-model="newRecordPlatform" :placeholder="t('liveTask.autoDetect')" clearable style="width: 100%" size="large">
            <el-option v-for="p in livePlatforms" :key="p.value" :label="p.label" :value="p.value">
              <div class="platform-option">
                <PlatformIcon :platform="p.value" size="sm" />
                {{ p.label }}
              </div>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item v-if="false" :label="t('liveTask.recordDuration')">
          <el-input-number v-model="recordDuration" :min="0" :max="720" :step="30" size="large" style="width: 200px" />
          <span class="form-tip">{{ t('liveTask.minutes') }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showNewRecord = false" round>{{ t('common.cancel') }}</el-button>
        <el-button :loading="creating" @click="handleCreateRecord" round class="gradient-btn">{{ t('liveTask.startRecording') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import i18n from '@/i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Link, VideoPause, VideoPlay, Delete, Clock, Refresh, MoreFilled, Star, StarFilled } from '@element-plus/icons-vue'
import { getTasks, createTask, deleteTask, batchDeleteTasks, cancelTask, retryTask, type TaskInfo } from '@/api/tasks'
import PlatformIcon from '@/components/PlatformIcon.vue'
import { listStreamers, addStreamer, updateStreamer, deleteStreamer, pollStreamersNow, type StreamerInfo } from '@/api/streamers'
import { getPlatforms, detectPlatformFromUrl, isSupportedUrl } from '@/api/plugins'

const { t } = useI18n()

const platformsData = ref<any[]>([])

const livePlatforms = computed(() => {
  if (platformsData.value.length === 0) {
    // Fallback while loading
    return []
  }
  return platformsData.value.map(p => ({
    label: p.label_en || p.label || p.name,
    value: p.name || p.id,
  }))
})

const props = defineProps<{ autoNew?: boolean }>()

const router = useRouter()
const tasks = ref<TaskInfo[]>([])
const coverCacheBust = ref(Math.floor(Date.now() / 60000))
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const activeTab = ref('all')

const showNewRecord = ref(false)
const newRecordUrl = ref('')
const newRecordPlatform = ref('')
const detectedPlatform = ref('')
const recordDuration = ref(0)
const creating = ref(false)

const selectedIds = ref<string[]>([])
const activePlatform = ref('all')

// Streamer state
const streamers = ref<StreamerInfo[]>([])
const showAddStreamer = ref(false)
const newStreamerUrl = ref('')
const newStreamerMode = ref<'persistent' | 'once'>('persistent')
const detectedStreamerPlatform = ref('')
const addingStreamer = ref(false)
const pollLoading = ref(false)

const tabCounts = reactive({ all: 0, active: 0, inactive: 0 })
const allItems = ref<TaskInfo[]>([])

const tabs = computed(() => [
  { key: 'all', label: t('liveTask.all'), count: tabCounts.all },
  { key: 'active', label: t('liveTask.statusOn'), count: tabCounts.active },
  { key: 'inactive', label: t('liveTask.statusOff'), count: tabCounts.inactive },
])

const platformPills = computed(() => {
  const countMap: Record<string, number> = {}
  for (const item of allItems.value) {
    const p = item.platform || 'unknown'
    countMap[p] = (countMap[p] || 0) + 1
  }
  const pills: { key: string; label: string; count: number }[] = [
    { key: 'all', label: t('liveTask.allPlatforms'), count: allItems.value.length },
  ]
  for (const [platform, count] of Object.entries(countMap)) {
    pills.push({ key: platform, label: t(`platform.${platform}`, platform), count })
  }
  return pills
})

const isAllSelected = computed(() => {
  return tasks.value.length > 0 && tasks.value.every(t => selectedIds.value.includes(t.task_id))
})

const isPartialSelected = computed(() => {
  return !isAllSelected.value && tasks.value.some(t => selectedIds.value.includes(t.task_id))
})

function toggleSelectAll() {
  if (isAllSelected.value) {
    // Deselect all visible
    const visibleIds = new Set(tasks.value.map(t => t.task_id))
    selectedIds.value = selectedIds.value.filter(id => !visibleIds.has(id))
  } else {
    // Select all visible
    const currentSet = new Set(selectedIds.value)
    for (const t of tasks.value) {
      currentSet.add(t.task_id)
    }
    selectedIds.value = [...currentSet]
  }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
function isActive(status: string) { return ['starting', 'recording', 'running', 'processing'].includes(status) }

function startPolling() {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => { coverCacheBust.value = Math.floor(Date.now() / 60000); loadTasks(); loadCounts(); loadStreamers() }, 5000)
}

function onVisibilityChange() {
  if (document.hidden) {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  } else {
    loadTasks(); loadCounts()
    startPolling()
  }
}

onMounted(async () => {
  try {
    const platforms = await getPlatforms()
    platformsData.value = platforms
  } catch (e) {
    console.warn('Failed to fetch platforms:', e)
  }
  loadTasks(); loadCounts(); loadStreamers()
  startPolling()
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (props.autoNew) openNewRecordDialog()
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

function getStatusFilter(): string | undefined {
  if (activeTab.value === 'all') return undefined
  if (activeTab.value === 'active') return 'starting,recording,running,processing'
  return 'stopped,failed,cancelled,completed' // inactive tab
}

async function loadTasks() {
  loading.value = true
  try {
    const params: Record<string, any> = { status: getStatusFilter(), page: page.value, size: pageSize.value, task_type: 'live' }
    if (activePlatform.value && activePlatform.value !== 'all') {
      params.platform = activePlatform.value
    }
    const data = await getTasks(params)
    // Sort by monitor start time (descending): active monitors first, most recently started on top
    const items = (data.items || []) as TaskInfo[]
    items.sort((a, b) => {
      const timeA = a.live_stats?.monitor_started_at || a.created_at || ''
      const timeB = b.live_stats?.monitor_started_at || b.created_at || ''
      return timeB.localeCompare(timeA)
    })
    tasks.value = items
    total.value = data.total || 0
  } catch { /* handled */ } finally { loading.value = false }
}

async function loadCounts() {
  try {
    const data = await getTasks({ page: 1, size: 1000, task_type: 'live' })
    const items = data.items || []
    allItems.value = items
    tabCounts.all = data.total || 0
    tabCounts.active = items.filter((t: TaskInfo) => isActive(t.status)).length
    tabCounts.inactive = items.filter((t: TaskInfo) => !isActive(t.status)).length
  } catch { /* handled */ }
}

function handleTabChange() { page.value = 1; loadTasks() }
function goToDetail(row: TaskInfo) { router.push(`/live/${row.task_id}`) }

function openNewRecordDialog() {
  newRecordUrl.value = ''; newRecordPlatform.value = ''; detectedPlatform.value = ''
  recordDuration.value = 0; showNewRecord.value = true
}

async function detectPlatform() {
  if (!newRecordUrl.value.trim()) {
    detectedPlatform.value = ''
    return
  }
  const platform = await detectPlatformFromUrl(newRecordUrl.value)
  if (platform) {
    detectedPlatform.value = platform
    newRecordPlatform.value = platform
  } else {
    detectedPlatform.value = ''
  }
}

async function handleCreateRecord() {
  if (!newRecordUrl.value.trim()) { ElMessage.warning(t('liveTask.enterUrl')); return }
  const supported = await isSupportedUrl(newRecordUrl.value)
  if (!supported) {
    ElMessage.warning(t('liveTask.unsupportedUrl'))
    return
  }
  creating.value = true
  try {
    const result = await createTask({
      url: newRecordUrl.value.trim(),
      platform: newRecordPlatform.value || undefined,
      task_type: 'live',
      record_duration: recordDuration.value,
    }) as any
    showNewRecord.value = false
    if (result.reused) {
      ElMessage.info(t('liveTask.recordReused'))
    } else {
      ElMessage.success(t('liveTask.recordCreated'))
    }
    router.push(`/live/${result.task_id}`)
  } catch { /* handled */ } finally { creating.value = false }
}

async function handleStop(row: TaskInfo) {
  try {
    await ElMessageBox.confirm(t('liveTask.confirmTurnOff'), t('liveTask.turnOff'), { type: 'warning' })
    await cancelTask(row.task_id); ElMessage.success(t('liveTask.turnedOff')); loadTasks(); loadCounts()
  } catch { /* user cancelled */ }
}

async function handleStart(row: TaskInfo) {
  try {
    await retryTask(row.task_id)
    ElMessage.success(t('liveTask.turnedOn'))
    router.push(`/live/${row.task_id}`)
  } catch { /* handled */ }
}

async function handleDelete(row: TaskInfo) {
  try {
    await ElMessageBox.confirm(t('liveTask.confirmDelete'), t('liveTask.deleteTask'), { type: 'warning' })
    await deleteTask(row.task_id); ElMessage.success(t('liveTask.taskDeleted')); loadTasks(); loadCounts()
  } catch { /* user cancelled */ }
}

function toggleSelect(task: TaskInfo) {
  const idx = selectedIds.value.indexOf(task.task_id)
  if (idx >= 0) selectedIds.value.splice(idx, 1)
  else selectedIds.value.push(task.task_id)
}

async function handleBatchDelete() {
  if (selectedIds.value.length === 0) return
  try {
    await ElMessageBox.confirm(
      t('liveTask.confirmBatchDelete', { count: selectedIds.value.length }),
      t('liveTask.deleteTask'),
      { type: 'warning' }
    )
    const result = await batchDeleteTasks(selectedIds.value)
    ElMessage.success(t('liveTask.batchDeleted', { count: result.deleted }))
    selectedIds.value = []
    loadTasks(); loadCounts()
  } catch { /* user cancelled */ }
}

function getPlatformLabel(platform: string) {
  return t(`platform.${platform}`, platform)
}

function formatTime(ts: string) { if (!ts) return '-'; const locale = i18n.global.locale.value === 'zh-CN' ? 'zh-CN' : 'en-US'; return new Date(ts).toLocaleString(locale) }

// ---- Streamer functions ----
async function loadStreamers() {
  try {
    streamers.value = await listStreamers()
  } catch { /* handled */ }
}

async function detectStreamerPlatform() {
  if (!newStreamerUrl.value.trim()) {
    detectedStreamerPlatform.value = ''
    return
  }
  const platform = await detectPlatformFromUrl(newStreamerUrl.value)
  detectedStreamerPlatform.value = platform || ''
}

async function handleAddStreamer() {
  if (!newStreamerUrl.value.trim()) { ElMessage.warning(t('liveTask.enterUrl')); return }
  const supported = await isSupportedUrl(newStreamerUrl.value)
  if (!supported) { ElMessage.warning(t('liveTask.unsupportedUrl')); return }
  addingStreamer.value = true
  try {
    await addStreamer({
      room_url: newStreamerUrl.value.trim(),
      platform: detectedStreamerPlatform.value || undefined,
      mode: newStreamerMode.value,
    })
    showAddStreamer.value = false
    newStreamerUrl.value = ''
    detectedStreamerPlatform.value = ''
    ElMessage.success(t('streamer.added'))
    loadStreamers()
  } catch (e: any) {
    ElMessage.error(e.message || t('common.failed'))
  } finally { addingStreamer.value = false }
}

async function handleStreamerAction(cmd: string, s: StreamerInfo) {
  if (cmd === 'enable') {
    await updateStreamer(s.streamer_id, { enabled: true })
    loadStreamers()
  } else if (cmd === 'disable') {
    await updateStreamer(s.streamer_id, { enabled: false })
    loadStreamers()
  } else if (cmd === 'mode-once') {
    await updateStreamer(s.streamer_id, { mode: 'once' })
    loadStreamers()
  } else if (cmd === 'mode-persistent') {
    await updateStreamer(s.streamer_id, { mode: 'persistent' })
    loadStreamers()
  } else if (cmd === 'delete') {
    try {
      await ElMessageBox.confirm(t('streamer.confirmDelete'), t('streamer.delete'), { type: 'warning' })
      await deleteStreamer(s.streamer_id)
      ElMessage.success(t('streamer.deleted'))
      loadStreamers()
    } catch { /* cancelled */ }
  }
}

function isStreamerWatched(url: string): boolean {
  return streamers.value.some(s => s.room_url === url)
}

async function handleWatchFromTask(task: TaskInfo) {
  try {
    await addStreamer({
      room_url: task.source_url,
      platform: task.platform || undefined,
      mode: 'persistent',
    })
    ElMessage.success(t('streamer.added'))
    loadStreamers()
  } catch (e: any) {
    ElMessage.error(e.message || t('common.failed'))
  }
}

async function handleUnwatchFromTask(task: TaskInfo) {
  const streamer = streamers.value.find(s => s.room_url === task.source_url)
  if (!streamer) return
  try {
    await ElMessageBox.confirm(t('streamer.confirmUnfollow'), t('streamer.unfollow'), { type: 'warning' })
    await deleteStreamer(streamer.streamer_id)
    ElMessage.success(t('streamer.unfollowed'))
    loadStreamers()
  } catch { /* cancelled */ }
}

async function handlePollNow() {
  pollLoading.value = true
  try {
    await pollStreamersNow()
    setTimeout(() => { loadStreamers(); pollLoading.value = false }, 3000)
  } catch { pollLoading.value = false }
}
</script>

<style scoped>
.live-task-list {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ========== Page Header ========== */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-title {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.5px;
}

.page-header-right {
  display: flex;
  align-items: center;
  gap: 10px;
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

/* ========== Tab Bar ========== */
.tab-bar {
  display: flex;
  gap: 4px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  padding: 4px;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.tab-item:hover {
  color: var(--text-primary);
  background: var(--glass-hover);
}

.tab-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.tab-item.active {
  background: var(--accent);
  color: #fff;
}

.tab-item.active .tab-count {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}

.tab-count {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--glass-bg);
  color: var(--text-tertiary);
  font-weight: 600;
  min-width: 20px;
  text-align: center;
}

/* ========== Task Card Grid ========== */
.task-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  min-height: 200px;
}

.task-card {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: box-shadow 0.2s var(--ease-out), border-color 0.2s var(--ease-out);
  animation: fadeInUp 0.3s var(--ease-out-expo) both;
  overflow: hidden;
  position: relative;
}

.task-card:hover {
  box-shadow: var(--shadow-md);
}

.task-card:active {
  transform: scale(0.985);
  transition: transform 80ms;
}

.task-card.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-subtle);
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ========== Card Cover ========== */
.card-cover {
  position: relative;
  width: 100%;
  padding-top: 56.25%; /* 16:9 */
  overflow: hidden;
  background: var(--bg-tertiary);
}

.card-cover .cover-img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: var(--bg-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover-placeholder-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-tertiary);
  letter-spacing: 2px;
}

.live-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  background: #ef4444;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  letter-spacing: 1px;
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.4);
  animation: livePulse 2s ease-in-out infinite;
}

@keyframes livePulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.card-checkbox-overlay {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
}

/* ========== Select All ========== */
.select-all-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.select-all-label {
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 500;
}

/* ========== Platform Pills ========== */
.platform-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.platform-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px;
  border-radius: 20px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.platform-pill:hover {
  color: var(--text-primary);
  background: var(--glass-hover);
}

.platform-pill:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.platform-pill.active {
  background: var(--accent-subtle);
  border-color: var(--accent);
  color: var(--accent);
}

.pill-count {
  font-size: 11px;
  opacity: 0.7;
}

/* ========== Card Header ========== */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px 0;
}

/* ========== Card Body ========== */
.card-body {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  flex: 1;
}

.platform-badge {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.card-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.platform-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.channel-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-url {
  color: var(--text-tertiary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ========== Card Footer ========== */
.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px 14px;
  border-top: 1px solid var(--glass-border);
  margin-top: 0;
  padding-top: 12px;
}

.card-time {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-tertiary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.time-icon {
  opacity: 0.5;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ========== Checkbox ========== */
.card-checkbox {
  flex-shrink: 0;
}

.modern-checkbox {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 2px solid var(--glass-border);
  background: transparent;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  transition: all 0.2s ease;
  position: relative;
}

.modern-checkbox:checked {
  background: var(--accent);
  border-color: transparent;
}

.modern-checkbox:checked::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 2px;
  width: 5px;
  height: 9px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.modern-checkbox:hover {
  border-color: var(--accent);
}

/* ========== Action Buttons ========== */
.action-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid transparent;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s var(--ease-out), background 0.15s var(--ease-out), border-color 0.15s var(--ease-out);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
}

.action-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.action-on {
  color: #16a34a;
  border-color: rgba(34, 197, 94, 0.3);
  background: rgba(34, 197, 94, 0.08);
}
.action-on:hover {
  background: #22c55e;
  color: #fff;
  border-color: #22c55e;
}

.action-off {
  color: var(--text-tertiary);
  border-color: var(--glass-border);
  background: rgba(100, 116, 139, 0.08);
}
.action-off:hover {
  background: var(--text-tertiary);
  color: #fff;
}

.action-danger {
  color: var(--status-danger);
  border-color: rgba(239, 68, 68, 0.2);
  background: rgba(239, 68, 68, 0.06);
}
.action-danger:hover {
  background: var(--status-danger);
  color: #fff;
  border-color: var(--status-danger);
}

/* ========== Monitor Indicator ========== */
.monitor-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  transition: color 0.2s var(--ease-out), background 0.2s var(--ease-out);
}

.indicator-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.monitor-indicator.is-on {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
  box-shadow: 0 0 12px rgba(34, 197, 94, 0.1);
}
.monitor-indicator.is-on .indicator-dot {
  background: #22c55e;
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.6), 0 0 16px rgba(34, 197, 94, 0.3);
  animation: statusPulse 1.5s ease-in-out infinite;
}

.monitor-indicator.is-off {
  background: rgba(100, 116, 139, 0.1);
  color: var(--text-tertiary);
}
.monitor-indicator.is-off .indicator-dot {
  background: var(--text-tertiary);
}

@keyframes statusPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* ========== Add Card ========== */
.add-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 180px;
  border: 2px dashed var(--glass-border);
  background: transparent;
  transition: all 0.25s ease;
}

.add-card:hover {
  border-color: var(--accent);
  background: var(--accent-subtle);
}

.add-text {
  font-size: 13px;
  color: var(--text-tertiary);
  font-weight: 500;
}

/* ========== Pagination ========== */
.pagination-wrapper {
  display: flex;
  justify-content: flex-end;
  padding: 8px 0;
}

/* ========== Dialog Form ========== */
.record-form {
  padding-top: 12px;
}

.platform-option {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-tip {
  margin-left: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

/* ========== Streamer Section ========== */
.streamer-section {
  background: var(--bg-secondary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  padding: 16px 20px;
}

.streamer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.streamer-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.streamer-header-actions {
  display: flex;
  gap: 8px;
}

.streamer-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--glass-border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s var(--ease-out), background 0.15s var(--ease-out);
}

.streamer-action-btn:hover {
  color: var(--text-primary);
  background: var(--glass-hover);
}

.streamer-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.streamer-action-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.streamer-action-btn.primary:hover {
  background: var(--accent-hover);
}

.streamer-strip {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.streamer-card {
  flex: 0 0 180px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-out), background 0.15s var(--ease-out);
  position: relative;
}

.streamer-card:hover {
  border-color: var(--text-tertiary);
}

.streamer-card.is-live {
  border-color: var(--status-success);
  background: rgba(34, 197, 94, 0.04);
}

.streamer-card.is-disabled {
  opacity: 0.5;
}

.streamer-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-live {
  background: var(--status-success);
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
  animation: statusPulse 1.5s ease-in-out infinite;
}

.dot-offline {
  background: var(--text-tertiary);
}

.streamer-info {
  flex: 1;
  min-width: 0;
}

.streamer-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.streamer-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.streamer-mode {
  font-size: 11px;
  color: var(--text-tertiary);
}

.streamer-card-actions {
  flex-shrink: 0;
}

.streamer-more-btn {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
}

.streamer-more-btn:hover {
  color: var(--text-primary);
  background: var(--glass-hover);
}

.streamer-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.streamer-empty-text {
  font-size: 13px;
  color: var(--text-tertiary);
}

/* Watch/Unwatch button on task cards */
.action-watch {
  color: var(--accent);
  border-color: rgba(240, 86, 56, 0.2);
  background: rgba(240, 86, 56, 0.06);
}
.action-watch:hover {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.action-unwatch {
  color: var(--accent);
  border-color: rgba(240, 86, 56, 0.3);
  background: rgba(240, 86, 56, 0.12);
}
.action-unwatch:hover {
  background: rgba(240, 86, 56, 0.2);
  color: var(--status-danger);
  border-color: var(--status-danger);
}

/* ========== Transitions ========== */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
