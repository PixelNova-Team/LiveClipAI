<template>
  <div class="clip-manager">
    <!-- Header -->
    <div class="page-header">
      <div class="header-left">
        <h1 class="page-title">{{ t('clipManager.title') }}</h1>
      </div>
      <div class="header-right">
        <el-button
          v-if="allClips.length > 0"
          type="danger"
          plain
          round
          @click="handleClearAll"
        >
          <el-icon class="el-icon--left"><Delete /></el-icon>
          {{ t('clipManager.clearAll') }}
        </el-button>
        <el-input
          v-model="searchQuery"
          :placeholder="t('clipManager.clipTitle')"
          clearable
          class="search-input"
          @input="onFilterChange"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-select v-model="filterPlatform" clearable :placeholder="t('common.platform')" class="platform-filter" @change="onFilterChange">
          <el-option v-for="p in platformOptions" :key="p" :label="t(`platform.${p}`, p)" :value="p" />
        </el-select>
      </div>
    </div>

    <!-- Filter Tabs: 全部 | 待审核 | 待发布 | 已拒绝 | 已发布 -->
    <div class="filter-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key; onFilterChange()"
      >
        <span v-if="tab.dot" class="tab-dot" :class="tab.dot"></span>
        {{ tab.label }}
        <span v-if="tab.count > 0" class="tab-count">{{ tab.count }}</span>
      </button>
    </div>

    <!-- AI Review Stats Bar -->
    <div v-if="hasAnyReview" class="ai-stats-bar glass-card">
      <div class="ai-stats-left">
        <span class="ai-stats-icon">AI</span>
        <span class="ai-stats-text">{{ t('clipManager.aiReview') }}</span>
      </div>
      <div class="ai-stats-right">
        <span class="ai-stat approved">
          <span class="ai-stat-dot dot-green"></span>
          {{ pendingPublishCount }} {{ t('clipManager.passed') }}
        </span>
        <span class="ai-stat rejected">
          <span class="ai-stat-dot dot-red"></span>
          {{ rejectedCount }} {{ t('clipManager.rejected') }}
        </span>
        <span v-if="pendingReviewCount > 0" class="ai-stat pending">
          <span class="ai-stat-dot dot-gray"></span>
          {{ pendingReviewCount }} {{ t('clipManager.awaitingReview') }}
        </span>
        <span v-if="pendingPublishCount + rejectedCount > 0" class="ai-stat rate">
          {{ t('clipManager.passRate') }} {{ approvalRate }}%
        </span>
      </div>
    </div>

    <!-- Clip Grid -->
    <div v-loading="loading" v-if="loading || filteredClips.length > 0" class="clip-grid">
      <div
        v-for="clip in filteredClips"
        :key="clip.slice_id"
        class="clip-card glass-card"
        :class="getCardClass(clip)"
        @click="openDetail(clip)"
      >
        <div class="clip-cover">
          <img
            v-if="clip.cover_path"
            :src="getCoverUrl(clip.slice_id)"
            :alt="clip.selected_title || 'cover'"
            class="cover-img"
            @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'"
          />
          <div v-else class="cover-placeholder"></div>
          <!-- Rejected overlay -->
          <div v-if="clip.ai_approved === 0" class="rejected-overlay">
            <el-icon :size="24"><CircleClose /></el-icon>
          </div>
          <span class="duration-badge">{{ formatDuration(clip.duration) }}</span>
          <span class="score-badge" :class="getScoreClass(clip)" :title="t('clipManager.scoreTip')">
            <el-icon :size="10" style="margin-right: 2px"><TrendCharts /></el-icon>
            {{ getViralScore(clip) }}
          </span>
          <!-- Status badge: published > ai status -->
          <span v-if="publishedSet.has(clip.slice_id)" class="status-badge badge-published">
            <el-icon :size="10" style="margin-right: 2px"><CircleCheck /></el-icon>
            {{ t('clipManager.published') }}
          </span>
          <span v-else-if="clip.ai_approved != null" class="status-badge" :class="getAiStatusClass(clip)">
            <el-icon :size="10" style="margin-right: 2px">
              <CircleCheck v-if="clip.ai_approved === 1" />
              <CircleClose v-else />
            </el-icon>
            {{ clip.ai_approved === 1 ? t('clipManager.pendingPublish') : t('clipManager.aiRejected') }}
          </span>
          <span v-else class="status-badge badge-pending-review">
            {{ t('clipManager.pendingReview') }}
          </span>
        </div>
        <div class="clip-info">
          <h3 class="clip-title">{{ clip.selected_title || t('taskDetail.unnamed') }}</h3>
          <p v-if="clip.ai_review_reason" class="clip-ai-reason">{{ clip.ai_review_reason }}</p>
          <div class="clip-meta">
            <span v-if="clip.platform" class="meta-platform">{{ t(`platform.${clip.platform}`, clip.platform) }}</span>
            <span v-if="clip.created_at" class="meta-date">{{ formatDate(clip.created_at) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <div v-if="!loading && filteredClips.length === 0" class="empty-state glass-card">
      <el-icon :size="48" color="var(--text-tertiary)"><VideoCamera /></el-icon>
      <p>{{ t('clipManager.noClips') }}</p>
    </div>

    <!-- Clip Detail Dialog -->
    <el-dialog
      v-model="detailVisible"
      :title="t('clipManager.editClip')"
      width="680px"
      style="max-width: 92vw"
      :close-on-click-modal="false"
      class="clip-detail-dialog"
      destroy-on-close
    >
      <div v-if="selectedClip" class="detail-body">
        <div class="detail-player">
          <VideoPlayer :src="getPreviewUrl(selectedClip.slice_id)" width="100%" max-height="320px" />
        </div>

        <!-- Status Banner -->
        <div v-if="publishedSet.has(selectedClip.slice_id)" class="ai-review-banner banner-published">
          <div class="banner-header">
            <el-icon :size="18"><CircleCheck /></el-icon>
            <span class="banner-status">{{ t('clipManager.published') }}</span>
          </div>
        </div>
        <div v-else-if="selectedClip.ai_approved != null" class="ai-review-banner" :class="selectedClip.ai_approved === 1 ? 'banner-approved' : 'banner-rejected'">
          <div class="banner-header">
            <el-icon :size="18">
              <CircleCheck v-if="selectedClip.ai_approved === 1" />
              <CircleClose v-else />
            </el-icon>
            <span class="banner-status">{{ selectedClip.ai_approved === 1 ? t('clipManager.pendingPublish') : t('clipManager.aiRejected') }}</span>
          </div>
          <p v-if="selectedClip.ai_review_reason" class="banner-reason">{{ selectedClip.ai_review_reason }}</p>
        </div>

        <el-form label-width="80px" class="detail-form">
          <el-form-item :label="t('clipManager.clipTitle')">
            <el-input v-model="editForm.title" />
          </el-form-item>
          <el-form-item :label="t('clipManager.clipDescription')">
            <el-input v-model="editForm.description" type="textarea" :rows="3" />
          </el-form-item>
          <el-form-item :label="t('clipManager.clipTags')">
            <el-select
              v-model="editForm.tags"
              multiple
              filterable
              allow-create
              default-first-option
              placeholder=""
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item v-if="selectedClip.cover_path" :label="t('taskDetail.preview')">
            <img :src="getSliceCoverUrl(selectedClip.slice_id)" class="detail-cover-preview" />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <div class="detail-footer">
          <div class="footer-left">
            <el-button type="danger" @click="handleDelete">
              <el-icon class="el-icon--left"><Delete /></el-icon>
              {{ t('clipManager.delete') }}
            </el-button>
            <el-button @click="handleDownloadDebug" :loading="debugLoading">
              <el-icon class="el-icon--left"><Download /></el-icon>
              {{ t('clipManager.downloadDebug') }}
            </el-button>
            <el-button
              v-if="selectedClip && selectedClip.ai_approved == null"
              type="warning"
              :loading="aiReviewLoading"
              @click="handleAiReview"
            >
              <el-icon class="el-icon--left"><MagicStick /></el-icon>
              {{ t('clipManager.triggerReview') }}
            </el-button>
            <el-button
              v-if="selectedClip && selectedClip.ai_approved === 0"
              type="success"
              @click="handleManualApprove"
            >
              <el-icon class="el-icon--left"><CircleCheck /></el-icon>
              {{ t('clipManager.approveSlice') }}
            </el-button>
          </div>
          <div class="footer-right">
            <el-button @click="detailVisible = false">{{ t('common.cancel') }}</el-button>
            <el-button @click="handleSave">{{ t('common.save') }}</el-button>
            <el-button type="primary" @click="handlePublishClick">
              <el-icon class="el-icon--left"><Promotion /></el-icon>
              {{ publishedSet.has(selectedClip?.slice_id || '') ? t('publishCenter.republish') : t('clipManager.publish') }}
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- Publish Dialog -->
    <PublishDialog
      v-model="publishDialogVisible"
      :slice="selectedClip"
      @published="onPublished"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, VideoCamera, Delete, Promotion, TrendCharts, Download, CircleCheck, CircleClose, MagicStick } from '@element-plus/icons-vue'
import { getAllSlices, getSlicePreviewUrl, getSliceCoverUrl, getSliceThumbUrl, deleteSlice, updateSlice, clearAllSlices, getSliceDebugInfo, triggerAiReview } from '@/api/slices'
import type { SliceInfo } from '@/api/slices'
import { getPublishHistory } from '@/api/publish'
import { getPlatforms } from '@/api/plugins'
import VideoPlayer from '@/components/VideoPlayer.vue'
import PublishDialog from '@/components/PublishDialog.vue'

const { t } = useI18n()

const allClips = ref<SliceInfo[]>([])
const publishedSet = ref<Set<string>>(new Set())
const loading = ref(false)
const searchQuery = ref('')
const filterPlatform = ref('')
const activeTab = ref('all')
const detailVisible = ref(false)
const publishDialogVisible = ref(false)
const selectedClip = ref<SliceInfo | null>(null)
const editForm = ref({
  title: '',
  description: '',
  tags: [] as string[],
})

const debugLoading = ref(false)
const aiReviewLoading = ref(false)

const platformOptions = ref<string[]>([])

// Counts for tabs
const pendingReviewCount = computed(() => allClips.value.filter(c => c.ai_approved == null).length)
const pendingPublishCount = computed(() => allClips.value.filter(c => c.ai_approved === 1 && !publishedSet.value.has(c.slice_id)).length)
const rejectedCount = computed(() => allClips.value.filter(c => c.ai_approved === 0).length)
const publishedCount = computed(() => allClips.value.filter(c => publishedSet.value.has(c.slice_id)).length)
const hasAnyReview = computed(() => pendingPublishCount.value + rejectedCount.value > 0)
const approvalRate = computed(() => {
  const total = pendingPublishCount.value + rejectedCount.value
  return total > 0 ? Math.round(pendingPublishCount.value / total * 100) : 0
})

const tabs = computed(() => [
  { key: 'all', label: t('clipManager.all'), count: allClips.value.length, dot: '' },
  { key: 'pending_review', label: t('clipManager.pendingReview'), count: pendingReviewCount.value, dot: 'dot-gray' },
  { key: 'pending_publish', label: t('clipManager.pendingPublish'), count: pendingPublishCount.value, dot: 'dot-orange' },
  { key: 'rejected', label: t('clipManager.aiRejected'), count: rejectedCount.value, dot: 'dot-red' },
  { key: 'published', label: t('clipManager.published'), count: publishedCount.value, dot: 'dot-green' },
])

const filteredClips = computed(() => {
  let list = [...allClips.value]

  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(c => (c.selected_title || '').toLowerCase().includes(q))
  }
  if (filterPlatform.value) {
    list = list.filter(c => c.platform === filterPlatform.value)
  }
  if (activeTab.value === 'pending_review') {
    list = list.filter(c => c.ai_approved == null)
  } else if (activeTab.value === 'pending_publish') {
    list = list.filter(c => c.ai_approved === 1 && !publishedSet.value.has(c.slice_id))
  } else if (activeTab.value === 'rejected') {
    list = list.filter(c => c.ai_approved === 0)
  } else if (activeTab.value === 'published') {
    list = list.filter(c => publishedSet.value.has(c.slice_id))
  }
  return list
})

onMounted(async () => {
  // Load platform options from plugins
  try {
    const platforms = await getPlatforms()
    platformOptions.value = platforms.map(p => p.name)
  } catch (e) {
    console.warn('Failed to load platforms:', e)
  }

  // Load clips
  loadClips()
})

async function loadClips() {
  loading.value = true
  try {
    const [slices] = await Promise.all([getAllSlices()])
    allClips.value = slices

    // Load publish history to determine which clips are published
    try {
      const history = await getPublishHistory({ size: 500 })
      const records = (history as any)?.items || (Array.isArray(history) ? history : [])
      const published = new Set<string>()
      for (const r of records) {
        if (r.status === 'published' || r.status === 'success') {
          published.add(r.slice_id)
        }
      }
      publishedSet.value = published
    } catch {
      // publish history may not be available
    }
  } catch {
    // handled by interceptor
  } finally {
    loading.value = false
  }
}

function getCoverUrl(sliceId: string) {
  return getSliceThumbUrl(sliceId)
}

function getPreviewUrl(sliceId: string) {
  return getSlicePreviewUrl(sliceId)
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function getViralScore(clip: SliceInfo): string {
  if (clip.peak_score != null && clip.peak_score > 0) {
    return Math.round(clip.peak_score * 100) + '%'
  }
  return '--'
}

function getScoreClass(clip: SliceInfo): string {
  const score = clip.peak_score || 0
  if (score >= 0.7) return 'score-green'
  if (score >= 0.4) return 'score-yellow'
  return 'score-gray'
}

function getCardClass(clip: SliceInfo): string {
  if (publishedSet.value.has(clip.slice_id)) return 'card-published'
  if (clip.ai_approved === 1) return 'card-approved'
  if (clip.ai_approved === 0) return 'card-rejected'
  return ''
}

function getAiStatusClass(clip: SliceInfo): string {
  if (clip.ai_approved === 1) return 'badge-approved'
  if (clip.ai_approved === 0) return 'badge-rejected'
  return ''
}

function openDetail(clip: SliceInfo) {
  selectedClip.value = clip
  editForm.value = {
    title: clip.selected_title || '',
    description: clip.description || '',
    tags: [],
  }
  detailVisible.value = true
}

async function handleSave() {
  if (!selectedClip.value) return
  try {
    await updateSlice(selectedClip.value.slice_id, {
      title: editForm.value.title,
      description: editForm.value.description,
    })
    selectedClip.value.selected_title = editForm.value.title
    selectedClip.value.description = editForm.value.description
    ElMessage.success(t('common.saved'))
    loadClips()
  } catch {
    ElMessage.error(t('common.saveFailed'))
  }
}

function handlePublishClick() {
  detailVisible.value = false
  publishDialogVisible.value = true
}

async function handleDelete() {
  if (!selectedClip.value) return
  try {
    await ElMessageBox.confirm(
      t('taskDetail.confirmDeleteSlice'),
      t('taskDetail.deleteSliceTitle'),
      { type: 'warning' }
    )
    await deleteSlice(selectedClip.value.slice_id)
    ElMessage.success(t('taskDetail.sliceDeleted'))
    detailVisible.value = false
    loadClips()
  } catch {
    // cancelled or error
  }
}

async function handleDownloadDebug() {
  if (!selectedClip.value) return
  debugLoading.value = true
  try {
    const info = await getSliceDebugInfo(selectedClip.value.slice_id)
    if (info.error) {
      ElMessage.error(info.error)
      return
    }

    const lines: string[] = [
      `=== LiveClipAI Slice Debug Info ===`,
      `Slice ID: ${info.sliceId}`,
      `Task ID: ${info.taskId}`,
      `Time Range: ${info.startTime.toFixed(1)}s ~ ${info.endTime.toFixed(1)}s (${info.duration.toFixed(1)}s)`,
      `Subtitle File: ${info.subtitlePath || '(none)'}`,
      `Generated: ${new Date().toISOString()}`,
      ``,
    ]

    if (info.subtitleContent) {
      lines.push(`=== SUBTITLE FILE CONTENT (.ass) ===`, info.subtitleContent, ``)
    } else {
      lines.push(`=== NO SUBTITLE FILE ===`, ``)
    }

    lines.push(`=== PROCESSING LOGS ===`, info.logContent)

    const content = lines.join('\n')
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `debug_${info.sliceId.slice(0, 8)}.txt`
    a.click()
    URL.revokeObjectURL(url)

    ElMessage.success(t('clipManager.debugDownloaded'))
  } catch (e: any) {
    ElMessage.error(e.message || 'Download failed')
  } finally {
    debugLoading.value = false
  }
}

async function handleManualApprove() {
  if (!selectedClip.value) return
  try {
    await updateSlice(selectedClip.value.slice_id, { ai_approved: 1 })
    selectedClip.value.ai_approved = 1
    ElMessage.success(t('clipManager.aiApproved'))
    loadClips()
  } catch {
    ElMessage.error(t('common.saveFailed'))
  }
}

async function handleAiReview() {
  if (!selectedClip.value) return
  aiReviewLoading.value = true
  try {
    const result = await triggerAiReview(selectedClip.value.slice_id)
    if (result.success) {
      ElMessage.success(t('clipManager.reviewComplete'))
      loadClips()
      detailVisible.value = false
    } else {
      ElMessage.error(result.error || t('common.failed'))
    }
  } catch (e: any) {
    ElMessage.error(e?.message || t('common.failed'))
  } finally {
    aiReviewLoading.value = false
  }
}

function onPublished() {
  loadClips()
}

async function handleClearAll() {
  try {
    await ElMessageBox.confirm(
      t('clipManager.clearAllConfirm'),
      t('clipManager.clearAllTitle'),
      { type: 'warning' }
    )
    await clearAllSlices()
    allClips.value = []
    ElMessage.success(t('clipManager.clearAllDone'))
  } catch {
    // cancelled or error
  }
}

// onFilterChange is intentionally empty — reactive computed handles filtering.
function onFilterChange() {}
</script>

<style scoped>
.clip-manager {
  max-width: 1200px;
  margin: 0 auto;
}

/* Header */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  gap: 16px;
  flex-wrap: wrap;
}

.page-title {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.5px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.search-input {
  width: 200px;
}

:deep(.search-input .el-input__wrapper) {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  box-shadow: none;
  color: var(--text-primary);
}

:deep(.search-input .el-input__inner) {
  color: var(--text-primary);
}

:deep(.platform-filter .el-input__wrapper) {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  box-shadow: none;
  color: var(--text-primary);
}

:deep(.platform-filter .el-input__inner) {
  color: var(--text-primary);
}

.platform-filter {
  width: 140px;
}

/* Filter Tabs */
.filter-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.tab-btn:hover {
  background: var(--glass-hover);
  color: var(--text-primary);
}

.tab-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.tab-btn.active {
  background: var(--accent-subtle);
  border-color: var(--accent);
  color: var(--accent);
}

.tab-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tab-count {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
}

.tab-btn.active .tab-count {
  background: var(--accent-subtle);
}

.dot-green { background: #22c55e; box-shadow: 0 0 6px rgba(34, 197, 94, 0.4); }
.dot-red { background: #ef4444; box-shadow: 0 0 6px rgba(239, 68, 68, 0.4); }
.dot-orange { background: #f59e0b; box-shadow: 0 0 6px rgba(245, 158, 11, 0.4); }
.dot-gray { background: #94a3b8; }

/* AI Stats Bar */
.ai-stats-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  margin-bottom: 20px;
  border-radius: var(--radius-md);
  gap: 16px;
  flex-wrap: wrap;
}

.ai-stats-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-stats-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 20px;
  border-radius: 4px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.5px;
}

.ai-stats-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.ai-stats-right {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.ai-stat {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.ai-stat-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.ai-stat.rate {
  font-weight: 600;
  color: var(--text-primary);
  padding-left: 8px;
  border-left: 1px solid var(--glass-border);
}

/* Clip Grid */
.clip-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 20px;
}

.clip-card {
  cursor: pointer;
  overflow: hidden;
  transition: box-shadow 0.2s var(--ease-out);
  animation: fadeInUp 0.3s var(--ease-out-expo) both;
  position: relative;
}

.clip-card:hover {
  box-shadow: var(--shadow-md);
}

.clip-card:active {
  transform: scale(0.98);
  transition: transform 80ms;
}

.card-approved {
  border-left: 3px solid #f59e0b;
}

.card-rejected {
  border-left: 3px solid #ef4444;
  opacity: 0.75;
}

.card-rejected:hover {
  opacity: 1;
}

.card-published {
  border-left: 3px solid #22c55e;
}

/* Cover */
.clip-cover {
  position: relative;
  width: 100%;
  padding-top: 56.25%; /* 16:9 */
  overflow: hidden;
  background: var(--bg-tertiary);
}

.cover-img {
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
  background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
}

.duration-badge {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  backdrop-filter: blur(4px);
}

.score-badge {
  position: absolute;
  bottom: 8px;
  right: 8px;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  backdrop-filter: blur(4px);
  display: inline-flex;
  align-items: center;
  cursor: help;
}

.score-green {
  background: rgba(34, 197, 94, 0.8);
  color: #fff;
}

.score-yellow {
  background: rgba(245, 158, 11, 0.8);
  color: #fff;
}

.score-gray {
  background: rgba(100, 116, 139, 0.6);
  color: #fff;
}

.status-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  backdrop-filter: blur(4px);
  display: inline-flex;
  align-items: center;
}

.badge-approved {
  background: rgba(245, 158, 11, 0.85);
  color: #fff;
}

.badge-rejected {
  background: rgba(239, 68, 68, 0.85);
  color: #fff;
}

.badge-published {
  background: rgba(34, 197, 94, 0.85);
  color: #fff;
}

.badge-pending-review {
  background: rgba(148, 163, 184, 0.7);
  color: #fff;
}

.rejected-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.7);
  z-index: 1;
}

/* Clip Info */
.clip-info {
  padding: 12px 14px 14px;
}

.clip-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clip-ai-reason {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: italic;
}

.clip-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.meta-platform {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  gap: 12px;
  color: var(--text-tertiary);
  font-size: 14px;
}

/* Detail Dialog */
:deep(.clip-detail-dialog .el-dialog) {
  background: var(--bg-secondary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
}

:deep(.clip-detail-dialog .el-dialog__header) {
  color: var(--text-primary);
}

:deep(.clip-detail-dialog .el-dialog__title) {
  color: var(--text-primary);
}

:deep(.clip-detail-dialog .el-dialog__body) {
  padding: 16px 24px;
}

.detail-player {
  margin-bottom: 20px;
  border-radius: var(--radius-md);
  overflow: hidden;
}

.detail-form {
  margin-top: 16px;
}

:deep(.detail-form .el-form-item__label) {
  color: var(--text-secondary);
}

:deep(.detail-form .el-input__wrapper),
:deep(.detail-form .el-textarea__inner) {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  box-shadow: none;
  color: var(--text-primary);
}

:deep(.detail-form .el-input__inner) {
  color: var(--text-primary);
}

:deep(.detail-form .el-textarea__inner) {
  color: var(--text-primary);
}

/* Review/Status Banner in Detail Dialog */
.ai-review-banner {
  margin-bottom: 16px;
  padding: 14px 18px;
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.banner-approved {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: #f59e0b;
}

.banner-rejected {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

.banner-published {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: #22c55e;
}

.banner-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 14px;
}

.banner-status {
  color: inherit;
}

.banner-reason {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin: 0;
  padding-left: 26px;
}

.detail-cover-preview {
  max-width: 200px;
  border-radius: var(--radius-sm);
}

.detail-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.footer-left {
  display: flex;
  gap: 8px;
}

.footer-right {
  display: flex;
  gap: 8px;
}
</style>
