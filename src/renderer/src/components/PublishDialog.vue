<template>
  <el-dialog
    v-model="visible"
    :title="t('publish.title')"
    width="560px"
    style="max-width: 92vw"
    :close-on-click-modal="false"
    @close="handleClose"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
      <el-form-item :label="t('publish.videoTitle')" prop="title">
        <el-input v-model="form.title" :placeholder="t('publish.titlePlaceholder')" />
      </el-form-item>
      <el-form-item :label="t('publish.description')" prop="description">
        <el-input v-model="form.description" type="textarea" :rows="3" :placeholder="t('publish.descPlaceholder')" />
      </el-form-item>
      <el-form-item :label="t('publish.tags')" prop="tags">
        <el-select
          v-model="form.tags"
          multiple
          filterable
          allow-create
          default-first-option
          :placeholder="t('publish.tagsPlaceholder')"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item :label="t('publish.platform')" prop="platform">
        <el-select v-model="form.platform" :placeholder="t('publish.platformPlaceholder')" style="width: 100%">
          <el-option
            v-for="p in filteredPlatforms"
            :key="p.name"
            :label="p.label"
            :value="p.name"
          />
        </el-select>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="publishing" @click="handlePublish">
        {{ t('publish.publishBtn') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { publishSliceById, getPublishPlatforms } from '@/api/publish'
import type { SliceInfo } from '@/api/slices'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
  slice: SliceInfo | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  published: []
}>()

const visible = ref(props.modelValue)
const formRef = ref<FormInstance>()
const publishing = ref(false)
const platforms = ref<{ name: string; label: string; available: boolean }[]>([])

const form = reactive({
  title: '',
  description: '',
  tags: [] as string[],
  platform: '',
})

const rules = computed<FormRules>(() => ({
  title: [{ required: true, message: t('publish.titleRequired'), trigger: 'blur' }],
  platform: [{ required: true, message: t('publish.platformRequired'), trigger: 'change' }],
}))

watch(() => props.modelValue, (val) => {
  visible.value = val
  if (val && props.slice) {
    form.title = props.slice.selected_title || ''
    form.description = props.slice.description || ''
    form.tags = props.slice.tags || []
    // Auto-select platform: prefer the slice's source platform if it's a valid publisher,
    // otherwise default to the first available publisher
    const publisherNames = platforms.value.map(p => p.name)
    const slicePlatform = props.slice.platform || ''
    form.platform = publisherNames.includes(slicePlatform)
      ? slicePlatform
      : (platforms.value.length > 0 ? platforms.value[0].name : '')
  }
})

watch(visible, (val) => {
  emit('update:modelValue', val)
})

// Filter platforms: prioritize the slice's source platform, show all as options
const filteredPlatforms = computed(() => {
  const slicePlatform = props.slice?.platform
  if (!slicePlatform || !platforms.value.length) return platforms.value
  // Put the source platform first, mark others as available too
  const sorted = [...platforms.value].sort((a, b) => {
    if (a.name === slicePlatform) return -1
    if (b.name === slicePlatform) return 1
    return 0
  })
  return sorted
})

onMounted(async () => {
  try {
    platforms.value = await getPublishPlatforms()
  } catch {
    platforms.value = []
  }
})

function handleClose() {
  formRef.value?.resetFields()
}

async function handlePublish() {
  if (!formRef.value || !props.slice) return
  await formRef.value.validate()
  publishing.value = true
  try {
    // Close dialog immediately — publish runs in background via browser window.
    visible.value = false
    ElMessage.info(t('publish.browserOpening'))

    // This call opens a browser window and waits for completion.
    const result = await publishSliceById(props.slice.slice_id, {
      platform: form.platform,
      title: form.title,
      description: form.description,
      tags: form.tags,
    })

    if (result?.success) {
      ElMessage.success(t('publish.published'))
    } else if (result?.error === 'cancelled') {
      ElMessage.info(t('common.cancel'))
    } else {
      ElMessage.warning(result?.error || t('publish.failed'))
    }
  } catch (e: any) {
    ElMessage.error(e?.message || t('publish.failed'))
  } finally {
    publishing.value = false
    // Always refresh clip list after publish attempt to update status
    emit('published')
  }
}
</script>
