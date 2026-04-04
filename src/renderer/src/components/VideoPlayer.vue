<template>
  <div class="video-player">
    <video
      ref="videoRef"
      :src="src"
      controls
      :style="{ width: width, maxHeight: maxHeight }"
      @error="onError"
    >
      {{ t('player.notSupported') }}
    </video>
    <div v-if="error" class="video-error">
      <el-icon :size="40"><VideoCamera /></el-icon>
      <p>{{ t('player.loadFailed') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { VideoCamera } from '@element-plus/icons-vue'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  src: string
  width?: string
  maxHeight?: string
}>(), {
  width: '100%',
  maxHeight: '400px',
})

const videoRef = ref<HTMLVideoElement>()
const error = ref(false)
const retried = ref(false)

// Reset error state when src changes
watch(() => props.src, () => {
  error.value = false
  retried.value = false
})

function onError() {
  // Retry once after a short delay (file may still be finalizing)
  if (!retried.value) {
    retried.value = true
    setTimeout(() => {
      if (videoRef.value) {
        videoRef.value.src = props.src
        videoRef.value.load()
      }
    }, 1500)
    return
  }
  error.value = true
}
</script>

<style scoped>
.video-player {
  position: relative;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
}

.video-player video {
  display: block;
}

.video-error {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #999;
  background: #1a1a1a;
}
</style>
