<template>
  <div class="publish-center">
    <!-- Header -->
    <div class="page-header">
      <h1 class="page-title">{{ t('publishCenter.title') }}</h1>
    </div>

    <!-- Tab Layout -->
    <el-tabs v-model="activeTab" class="publish-tabs">
      <!-- Pending Tab -->
      <el-tab-pane name="pending">
        <template #label>
          <span class="tab-label">
            <span class="column-dot dot-pending"></span>
            {{ t('publishCenter.pending') }}
            <span class="tab-count">{{ pendingClips.length }}</span>
          </span>
        </template>
        <div class="tab-content">
          <div v-if="pendingClips.length > 0" class="cards-grid">
            <div
              v-for="clip in pendingClips"
              :key="clip.slice_id"
              class="publish-card glass-card"
            >
              <div class="card-cover">
                <img
                  v-if="clip.cover_path"
                  :src="getCoverUrl(clip.slice_id)"
                  :alt="clip.selected_title || ''"
                  class="cover-img"
                  @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'"
                />
                <div v-else class="cover-placeholder"></div>
                <span class="duration-badge">{{ formatDuration(clip.duration) }}</span>
              </div>
              <div class="card-info">
                <h3 class="card-title">{{ clip.selected_title || t('taskDetail.unnamed') }}</h3>
                <div class="card-meta">
                  <span v-if="clip.platform" class="meta-tag">{{ t(`platform.${clip.platform}`, clip.platform) }}</span>
                </div>
              </div>
              <div class="card-actions">
                <el-button size="small" @click="openEdit(clip)">
                  <el-icon><Edit /></el-icon>
                </el-button>
                <el-button size="small" type="primary" @click="openPublishFor(clip)">
                  <el-icon class="el-icon--left"><Promotion /></el-icon>
                  {{ t('clipManager.publish') }}
                </el-button>
              </div>
            </div>
          </div>
          <div v-else class="column-empty">
            {{ t('publishCenter.noItems') }}
          </div>
          <div v-if="pendingClips.length > 0" class="tab-footer">
            <el-button
              type="primary"
              class="batch-btn"
              @click="handleBatchPublish"
              :loading="batchPublishing"
            >
              <el-icon class="el-icon--left"><Promotion /></el-icon>
              {{ t('publishCenter.batchPublish') }}
            </el-button>
          </div>
        </div>
      </el-tab-pane>

      <!-- Publishing Tab -->
      <el-tab-pane name="publishing">
        <template #label>
          <span class="tab-label">
            <span class="column-dot dot-publishing"></span>
            {{ t('publishCenter.publishing') }}
            <span class="tab-count">{{ publishingItems.length }}</span>
          </span>
        </template>
        <div class="tab-content">
          <div v-if="publishingItems.length > 0" class="cards-grid">
            <div
              v-for="item in publishingItems"
              :key="item.id"
              class="publish-card glass-card publishing-card"
            >
              <div class="card-cover">
                <div class="cover-placeholder"></div>
                <div class="publishing-overlay">
                  <el-icon class="spinning" :size="24"><Loading /></el-icon>
                </div>
              </div>
              <div class="card-info">
                <h3 class="card-title">{{ item.title || t('taskDetail.unnamed') }}</h3>
                <div class="card-meta">
                  <span class="meta-tag">{{ item.platform }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="column-empty">
            {{ t('publishCenter.noItems') }}
          </div>
        </div>
      </el-tab-pane>

      <!-- Published Tab -->
      <el-tab-pane name="published">
        <template #label>
          <span class="tab-label">
            <span class="column-dot dot-published"></span>
            {{ t('publishCenter.published') }}
            <span class="tab-count">{{ publishedItems.length }}</span>
          </span>
        </template>
        <div class="tab-content">
          <div v-if="publishedItems.length > 0" class="cards-grid">
            <div
              v-for="item in publishedItems"
              :key="item.id"
              class="publish-card glass-card published-card"
              @click="openPublishedClip(item)"
              style="cursor: pointer"
            >
              <div class="card-cover">
                <img
                  v-if="item.slice_id"
                  :src="getCoverUrl(item.slice_id)"
                  :alt="item.title || ''"
                  class="cover-img"
                  @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'"
                />
                <div v-else class="cover-placeholder published-gradient"></div>
                <div class="published-check">
                  <el-icon :size="20" color="#fff"><CircleCheck /></el-icon>
                </div>
              </div>
              <div class="card-info">
                <h3 class="card-title">{{ item.title || t('taskDetail.unnamed') }}</h3>
                <div class="card-meta">
                  <span class="meta-tag">{{ item.platform }}</span>
                  <span v-if="item.published_at" class="meta-date">
                    {{ t('publishCenter.publishedAt') }} {{ formatDate(item.published_at) }}
                  </span>
                </div>
              </div>
              <div class="card-actions">
                <el-button v-if="item.url" size="small" type="primary" text @click.stop="openLink(item.url)">
                  {{ t('publishCenter.viewOnPlatform') }}
                  <el-icon class="el-icon--right"><TopRight /></el-icon>
                </el-button>
                <el-button size="small" text @click.stop="openPublishFor(findClipById(item.slice_id))">
                  <el-icon class="el-icon--left"><Promotion /></el-icon>
                  {{ t('publishCenter.republish') }}
                </el-button>
              </div>
            </div>
          </div>
          <div v-else class="column-empty">
            {{ t('publishCenter.noItems') }}
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- Publish Dialog -->
    <PublishDialog
      v-model="publishDialogVisible"
      :slice="selectedClip"
      @published="onPublished"
    />

    <!-- Batch Publish Platform Dialog -->
    <el-dialog
      v-model="batchDialogVisible"
      :title="t('publishCenter.batchPublish')"
      width="400px"
      style="max-width: 92vw"
      class="batch-dialog"
    >
      <el-form label-width="80px">
        <el-form-item :label="t('clipManager.selectPlatform')">
          <el-select v-model="batchPlatform" :placeholder="t('publish.platformPlaceholder')" style="width: 100%">
            <el-option v-for="p in platforms" :key="p.name" :label="p.label" :value="p.name" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="batchPublishing" @click="doBatchPublish">
          {{ t('publishCenter.batchPublish') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Edit, Promotion, Loading, CircleCheck, TopRight } from '@element-plus/icons-vue'
import { getAllSlices, getSliceThumbUrl } from '@/api/slices'
import type { SliceInfo } from '@/api/slices'
import { getPlatforms, getPublishHistory, batchPublish } from '@/api/publish'
import PublishDialog from '@/components/PublishDialog.vue'

interface PublishRecord {
  id: string
  slice_id: string
  title: string
  platform: string
  status: string
  url?: string
  published_at?: string
}

const { t } = useI18n()

const activeTab = ref('pending')
const allSlices = ref<SliceInfo[]>([])
const pendingClips = ref<SliceInfo[]>([])
const publishingItems = ref<PublishRecord[]>([])
const publishedItems = ref<PublishRecord[]>([])
const publishDialogVisible = ref(false)
const batchDialogVisible = ref(false)
const batchPublishing = ref(false)
const batchPlatform = ref('')
const selectedClip = ref<SliceInfo | null>(null)
interface PlatformOption { name: string; label: string }
const platforms = ref<PlatformOption[]>([])

onMounted(() => {
  loadData()
  loadPlatforms()
})

async function loadPlatforms() {
  try {
    const list = await getPlatforms()
    platforms.value = list.map((p: any) => ({ name: p.name, label: p.label || p.name }))
  } catch {
    platforms.value = []
  }
}

async function loadData() {
  try {
    // Load all slices
    const slices = await getAllSlices()
    allSlices.value = slices
    pendingClips.value = slices

    // Try to load publish history
    try {
      const history = await getPublishHistory({ size: 100 })
      const records = (history as any)?.items || (Array.isArray(history) ? history : [])
      const publishedSliceIds = new Set<string>()

      for (const r of records) {
        const record: PublishRecord = {
          id: r.id || r.publish_id || r.slice_id,
          slice_id: r.slice_id,
          title: r.title || '',
          platform: r.platform || '',
          status: r.status || 'published',
          url: r.url || r.video_url || '',
          published_at: r.published_at || r.created_at || '',
        }

        if (record.status === 'publishing' || record.status === 'processing') {
          publishingItems.value.push(record)
          publishedSliceIds.add(record.slice_id)
        } else if (record.status === 'published' || record.status === 'success') {
          publishedItems.value.push(record)
          publishedSliceIds.add(record.slice_id)
        }
        // 'cancelled' and 'failed' records are NOT added to publishedSliceIds,
        // so those clips remain in the pending list for retry
      }

      // Remove only truly published/publishing clips from pending
      pendingClips.value = pendingClips.value.filter(c => !publishedSliceIds.has(c.slice_id))
    } catch {
      // Publish history API may not be available yet
    }
  } catch {
    // handled by interceptor
  }
}

function getCoverUrl(sliceId: string) {
  return getSliceThumbUrl(sliceId)
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString()
}

function openEdit(clip: SliceInfo) {
  selectedClip.value = clip
  publishDialogVisible.value = true
}

function openPublishFor(clip: SliceInfo | null) {
  if (!clip) return
  selectedClip.value = clip
  publishDialogVisible.value = true
}

function handleBatchPublish() {
  batchPlatform.value = ''
  batchDialogVisible.value = true
}

async function doBatchPublish() {
  if (!batchPlatform.value) {
    ElMessage.warning(t('publish.platformRequired'))
    return
  }
  batchPublishing.value = true
  try {
    const ids = pendingClips.value.map(c => c.slice_id)
    await batchPublish({ slice_ids: ids, platform: batchPlatform.value })
    ElMessage.success(t('publish.published'))
    batchDialogVisible.value = false
    // Reload data
    publishingItems.value = []
    publishedItems.value = []
    await loadData()
  } catch {
    // handled by interceptor
  } finally {
    batchPublishing.value = false
  }
}

function findClipById(sliceId: string): SliceInfo | null {
  return allSlices.value.find(c => c.slice_id === sliceId) || null
}

function openPublishedClip(item: PublishRecord) {
  const clip = findClipById(item.slice_id)
  if (clip) {
    selectedClip.value = clip
    publishDialogVisible.value = true
  }
}

function onPublished() {
  publishingItems.value = []
  publishedItems.value = []
  loadData()
}

function openLink(url: string) {
  window.open(url, '_blank')
}
</script>

<style scoped>
.publish-center {
  max-width: 1200px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 28px;
}

.page-title {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.5px;
}

/* Tabs Styling */
.publish-tabs {
  --el-tabs-header-height: 48px;
}

:deep(.publish-tabs > .el-tabs__header) {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg, 12px);
  padding: 4px;
  margin-bottom: 20px;
}

:deep(.publish-tabs > .el-tabs__header .el-tabs__nav-wrap::after) {
  display: none;
}

:deep(.publish-tabs > .el-tabs__header .el-tabs__active-bar) {
  display: none;
}

:deep(.publish-tabs > .el-tabs__header .el-tabs__item) {
  height: 40px;
  line-height: 40px;
  border-radius: var(--radius-md, 8px);
  color: var(--text-secondary);
  font-weight: 500;
  font-size: 14px;
  padding: 0 20px;
  transition: all 0.25s ease;
  border-bottom: none;
}

:deep(.publish-tabs > .el-tabs__header .el-tabs__item:hover) {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.04);
}

:deep(.publish-tabs > .el-tabs__header .el-tabs__item.is-active) {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.08);
  font-weight: 600;
}

:deep(.publish-tabs > .el-tabs__content) {
  overflow: visible;
}

/* Tab Label */
.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.tab-count {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary);
  font-weight: 500;
  min-width: 20px;
  text-align: center;
}

/* Status Dots */
.column-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-pending {
  background: var(--status-warning);
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.4);
}

.dot-publishing {
  background: var(--accent);
  box-shadow: 0 0 8px rgba(240, 86, 56, 0.4);
  animation: statusPulse 1.5s ease infinite;
}

.dot-published {
  background: var(--status-success);
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
}

/* Tab Content */
.tab-content {
  min-height: 300px;
}

/* Cards Grid */
.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

/* auto-fill handles responsive columns automatically */

/* Empty State */
.column-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 60px 16px;
  color: var(--text-tertiary);
  font-size: 14px;
}

/* Tab Footer */
.tab-footer {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--glass-border);
  display: flex;
  justify-content: flex-end;
}

.batch-btn {
  min-width: 160px;
}

/* Publish Card */
.publish-card {
  overflow: hidden;
  animation: fadeInUp 0.3s ease both;
}

.card-cover {
  position: relative;
  width: 100%;
  padding-top: 50%;
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

.published-gradient {
  background: linear-gradient(135deg, rgba(34, 197, 94, 0.15), var(--bg-tertiary));
}

.duration-badge {
  position: absolute;
  bottom: 6px;
  left: 6px;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 5px;
  border-radius: 3px;
}

.publishing-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
}

.spinning {
  animation: spin 1.2s linear infinite;
  color: var(--accent);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.published-check {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(34, 197, 94, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Card Info */
.card-info {
  padding: 10px 12px 6px;
}

.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  flex-wrap: wrap;
}

.meta-tag {
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
}

.meta-date {
  color: var(--text-tertiary);
}

/* Card Actions */
.card-actions {
  padding: 6px 12px 10px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

/* Batch Dialog */
:deep(.batch-dialog .el-dialog) {
  background: var(--bg-secondary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
}

:deep(.batch-dialog .el-dialog__title) {
  color: var(--text-primary);
}

:deep(.batch-dialog .el-form-item__label) {
  color: var(--text-secondary);
}

:deep(.batch-dialog .el-select .el-input__wrapper) {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  box-shadow: none;
}
</style>
