<template>
  <span class="status-badge" :class="[statusClass]">
    <span class="status-dot" :class="{ pulsing: isPulsing }"></span>
    <span class="status-text">{{ statusLabel }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  status: string
}>()

const statusLabel = computed(() => {
  const key = `status.${props.status}`
  return t(key, props.status)
})

const statusClassMap: Record<string, { class: string; pulse: boolean }> = {
  starting: { class: 'status-processing', pulse: true },
  recording: { class: 'status-processing', pulse: true },
  running: { class: 'status-processing', pulse: true },
  processing: { class: 'status-processing', pulse: true },
  completed: { class: 'status-success', pulse: false },
  stopped: { class: 'status-info', pulse: false },
  cancelled: { class: 'status-info', pulse: false },
  failed: { class: 'status-danger', pulse: false },
}

const statusClass = computed(() => statusClassMap[props.status]?.class || 'status-info')
const isPulsing = computed(() => statusClassMap[props.status]?.pulse || false)
</script>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* Success */
.status-success {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
}
.status-success .status-dot {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
}

/* Processing */
.status-processing {
  background: rgba(240, 86, 56, 0.12);
  color: #d94b26;
}
.status-processing .status-dot {
  background: #f05638;
  box-shadow: 0 0 6px rgba(240, 86, 56, 0.5);
}

/* Danger */
.status-danger {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}
.status-danger .status-dot {
  background: #ef4444;
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.5);
}

/* Info */
.status-info {
  background: rgba(100, 116, 139, 0.1);
  color: var(--text-secondary);
}
.status-info .status-dot {
  background: var(--text-secondary);
}

/* Pulse animation */
.status-dot.pulsing {
  animation: pulse-dot 1.5s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% {
    opacity: 1;
    box-shadow: 0 0 6px currentColor;
  }
  50% {
    opacity: 0.6;
    box-shadow: 0 0 12px currentColor;
  }
}
</style>
