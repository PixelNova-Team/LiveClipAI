<template>
  <div class="analysis-panel" :class="['level-' + level]">
    <!-- Header: title + recording duration + state -->
    <div class="ap-header">
      <div class="ap-header-left">
        <div class="ap-logo-pulse">
          <span class="ap-logo-ring"></span>
          <span class="ap-logo-ring ap-logo-ring--delay"></span>
          <span class="ap-logo-core"></span>
        </div>
        <span class="ap-title">{{ t('liveAnalysis.title') }}</span>
        <span class="ap-state-badge" :class="['state-' + stateKey]">
          <span class="ap-state-dot"></span>
          {{ stateLabel }}
        </span>
      </div>
      <div class="ap-header-right">
        <span class="ap-elapsed">{{ liveDuration }}</span>
        <span class="ap-cycle" v-if="stats.cycle">#{{ stats.cycle }}</span>
      </div>
    </div>

    <!-- Score bar -->
    <div class="ap-score-section" v-if="stats.cycle">
      <div class="ap-score-header">
        <span class="ap-score-label">{{ t('liveAnalysis.exciteLabel') }}</span>
        <span class="ap-score-num" :class="['text-' + level]">{{ scorePercent }}<small>%</small></span>
      </div>
      <div class="ap-score-track">
        <div v-show="scorePercent > 0" class="ap-score-glow" :class="['glow-' + level]" :style="{ width: scorePercent + '%' }"></div>
        <div v-show="scorePercent > 0" class="ap-score-fill" :class="['fill-' + level]" :style="{ width: scorePercent + '%' }"></div>
        <div class="ap-score-threshold" :style="{ left: thresholdPercent + '%' }">
          <span class="ap-threshold-line"></span>
          <span class="ap-threshold-label">{{ t('liveAnalysis.triggerLine') }}</span>
        </div>
      </div>
      <div class="ap-score-marks">
        <span>{{ t('liveAnalysis.levelCalm') }}</span>
        <span>{{ t('liveAnalysis.levelActive') }}</span>
        <span class="mark-hot">{{ t('liveAnalysis.levelHot') }}</span>
      </div>
    </div>

    <!-- Signal cards -->
    <div class="ap-signals" v-if="stats.cycle">
      <!-- Danmaku -->
      <div class="ap-signal" :class="{ 'signal-off': !stats.danmaku_connected && !stats.has_danmaku }">
        <div class="ap-sig-header">
          <span class="ap-sig-icon sig-danmaku"><el-icon :size="14"><ChatDotSquare /></el-icon></span>
          <span class="ap-sig-title">{{ t('liveAnalysis.sigDanmaku') }}</span>
          <span class="ap-sig-badge" v-if="stats.has_danmaku">{{ stats.danmaku_count || 0 }}{{ t('liveAnalysis.msgUnit') }}</span>
        </div>
        <template v-if="stats.has_danmaku">
          <div class="ap-sig-score-row">
            <div class="ap-sig-bar"><div v-show="danmakuPercent > 0" class="ap-sig-bar-fill bar-danmaku" :style="{ width: danmakuPercent + '%' }"></div></div>
            <span class="ap-sig-score">{{ danmakuPercent }}</span>
          </div>
          <!-- Danmaku sub-signals -->
          <div class="ap-sub-features">
            <div class="ap-sub" v-for="f in danmakuSignals" :key="f.key">
              <span class="ap-sub-label">{{ f.label }}</span>
              <div class="ap-sub-bar"><div class="ap-sub-fill" :style="{ width: getSignal(f.key) + '%', background: f.color }"></div></div>
            </div>
          </div>
        </template>
        <template v-else-if="stats.danmaku_connected">
          <div class="ap-sig-hint">
            {{ t('liveAnalysis.danmakuWaiting') }}
            <span v-if="stats.danmaku_count > 0" class="ap-sig-hint-count">
              ({{ t('liveAnalysis.totalReceived', { count: stats.danmaku_count }) }})
            </span>
          </div>
        </template>
        <template v-else>
          <div class="ap-sig-off-row">
            <span class="ap-sig-off-text">{{ t('liveAnalysis.danmakuOff') }}</span>
            <button class="ap-retry-btn" @click="$emit('retryDanmaku')" :disabled="retrying">
              {{ retrying ? t('liveAnalysis.danmakuRetrying') : t('liveAnalysis.danmakuRetry') }}
            </button>
          </div>
        </template>
      </div>

      <!-- Audio -->
      <div class="ap-signal">
        <div class="ap-sig-header">
          <span class="ap-sig-icon sig-audio"><el-icon :size="14"><Headset /></el-icon></span>
          <span class="ap-sig-title">{{ t('liveAnalysis.sigAudioExcitement') }}</span>
        </div>
        <div class="ap-sig-score-row">
          <div class="ap-sig-bar"><div v-show="audioPercent > 0" class="ap-sig-bar-fill bar-audio" :style="{ width: audioPercent + '%' }"></div></div>
          <span class="ap-sig-score">{{ audioPercent }}</span>
        </div>
        <!-- Audio sub-features -->
        <div class="ap-sub-features" v-if="stats.audio_details">
          <div class="ap-sub" v-for="f in audioFeats" :key="f.key">
            <span class="ap-sub-label">{{ f.label }}</span>
            <div class="ap-sub-bar"><div class="ap-sub-fill" :style="{ width: getAudioFeat(f.key) + '%', background: f.color }"></div></div>
          </div>
        </div>
      </div>

      <!-- Gift & Resonance — always visible -->
      <div class="ap-signal">
        <div class="ap-sig-header">
          <span class="ap-sig-icon sig-gift"><el-icon :size="14"><Present /></el-icon></span>
          <span class="ap-sig-title">{{ t('liveAnalysis.sigGift') }}</span>
          <span class="ap-sig-badge" v-if="stats.gift_count > 0">{{ stats.gift_count }}</span>
          <span class="ap-sig-badge ap-resonance-badge" v-if="stats.resonance_bonus > 0">
            <span class="ap-resonance-spark"></span>
            +{{ Math.round(stats.resonance_bonus * 100) }}%
          </span>
        </div>
        <div class="ap-gift-row">
          <div class="ap-sig-score-row" style="flex:1">
            <div class="ap-sig-bar"><div v-show="giftPercent > 0" class="ap-sig-bar-fill bar-gift" :style="{ width: giftPercent + '%' }"></div></div>
            <span class="ap-sig-score">{{ giftPercent }}</span>
          </div>
          <span class="ap-resonance-label" v-if="stats.resonance_bonus > 0">{{ t('liveAnalysis.resonance') }}</span>
        </div>
      </div>
    </div>

    <!-- Waiting state -->
    <div class="ap-waiting" v-if="!stats.cycle">
      <div class="ap-wave"><span></span><span></span><span></span><span></span><span></span></div>
      <span>{{ t('liveAnalysis.waiting') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChatDotSquare, Headset, Present } from '@element-plus/icons-vue'

const props = defineProps<{
  stats: Record<string, any>
  retrying?: boolean
  startTime?: string
}>()

defineEmits<{
  retryDanmaku: []
}>()

const { t } = useI18n()

// Real-time recording duration (updates every second)
const liveDuration = ref('00:00')
let durationTimer: ReturnType<typeof setInterval> | null = null

function updateDuration(): void {
  if (!props.startTime) {
    liveDuration.value = '00:00'
    return
  }
  const start = new Date(props.startTime).getTime()
  const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000))
  liveDuration.value = formatElapsed(elapsed)
}

onMounted(() => {
  updateDuration()
  durationTimer = setInterval(updateDuration, 1000)
})

onUnmounted(() => {
  if (durationTimer) clearInterval(durationTimer)
})

const scorePercent = computed(() => Math.round((props.stats.total_score || 0) * 100))
const thresholdPercent = computed(() => Math.round((props.stats.threshold || 0.6) * 100))
const danmakuPercent = computed(() => Math.round((props.stats.danmaku_score || 0) * 100))
const audioPercent = computed(() => Math.round((props.stats.audio_excitement || 0) * 100))
const giftPercent = computed(() => Math.round((props.stats.gift_score || 0) * 100))
// AI scoring removed from real-time loop — AI now reviews post-slice only

const level = computed(() => {
  const score = props.stats.total_score || 0
  const threshold = props.stats.threshold || 0.6
  const state = props.stats.state || 'idle'
  if (state === 'burst') return 'burst'
  if (state === 'heating') return 'high'
  if (score >= threshold * 0.6) return 'medium'
  if (score >= threshold * 0.2) return 'low'
  return 'calm'
})

const stateKey = computed(() => props.stats.state || 'idle')
const stateLabel = computed(() => {
  const s = props.stats.state
  if (s === 'burst') return t('liveAnalysis.state_burst')
  if (s === 'slicing') return t('liveAnalysis.state_slicing')
  if (s === 'heating') return t('liveAnalysis.state_heating')
  if (s === 'warmup') return t('liveAnalysis.state_warmup')
  return t('liveAnalysis.state_idle')
})


const danmakuSignals = computed(() => [
  { key: 'danmaku_acceleration', label: t('liveAnalysis.sigAccel'), color: '#60a5fa' },
  { key: 'repeat_score', label: t('liveAnalysis.sigRepeat'), color: '#a78bfa' },
  { key: 'emotion_score', label: t('liveAnalysis.sigEmotion'), color: '#fbbf24' },
])

const audioFeats = computed(() => [
  { key: 'rms', label: t('liveAnalysis.featRms'), color: '#4ecdc4' },
  { key: 'loudness', label: t('liveAnalysis.featLoudness'), color: '#60a5fa' },
  { key: 'spectralCentroid', label: t('liveAnalysis.featCentroid'), color: '#a78bfa' },
  { key: 'surge', label: t('liveAnalysis.sigSurge'), color: '#f87171' },
])

function getAudioFeat(key: string): number {
  if (key === 'surge') return Math.round((props.stats.audio_surge || 0) * 100)
  return Math.round(((props.stats.audio_details as any)?.[key] || 0) * 100)
}

function getSignal(key: string): number {
  return Math.round((props.stats[key] || 0) * 100)
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

</script>

<style scoped>
.analysis-panel {
  --card-bg: rgba(0, 0, 0, 0.03);
  --card-border: rgba(0, 0, 0, 0.06);
  --bar-bg: rgba(0, 0, 0, 0.06);
  --text-1: var(--text-primary);
  --text-2: var(--text-secondary);
  --text-3: var(--text-tertiary);

  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  padding: 20px;
  transition: border-color 0.4s, box-shadow 0.4s;
  position: relative;
  overflow: hidden;
}

/* Ambient glow strip at the top */
.analysis-panel::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--accent), var(--accent), transparent);
  opacity: 0.4;
  transition: opacity 0.4s;
}

.level-medium::before { background: linear-gradient(90deg, transparent, #eab308, #f97316, transparent); opacity: 0.5; }
.level-high::before { background: linear-gradient(90deg, transparent, #f97316, #ef4444, transparent); opacity: 0.7; }
.level-burst::before { background: linear-gradient(90deg, transparent, #ef4444, #f97316, #ef4444, transparent); opacity: 1; animation: glow-sweep 2s linear infinite; }

@keyframes glow-sweep {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

/* Level-based glow */
.level-medium { border-color: rgba(234, 179, 8, 0.3); }
.level-high { border-color: rgba(249, 115, 22, 0.4); box-shadow: 0 0 20px rgba(249, 115, 22, 0.1); }
.level-burst {
  border-color: rgba(239, 68, 68, 0.5);
  box-shadow: 0 0 30px rgba(239, 68, 68, 0.15);
  animation: panel-glow 1.5s ease-in-out infinite;
}
@keyframes panel-glow {
  0%, 100% { box-shadow: 0 0 20px rgba(239, 68, 68, 0.1); }
  50% { box-shadow: 0 0 40px rgba(239, 68, 68, 0.25); }
}

/* ===== Header ===== */
.ap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
  flex-wrap: wrap;
  gap: 8px;
}

.ap-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ap-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Animated pulse logo */
.ap-logo-pulse {
  position: relative;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ap-logo-core {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  z-index: 1;
}

.ap-logo-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(34, 197, 94, 0.4);
  animation: ring-pulse 2.5s ease-out infinite;
}

.ap-logo-ring--delay {
  animation-delay: 1.2s;
}

@keyframes ring-pulse {
  0% { transform: scale(0.5); opacity: 0.8; }
  100% { transform: scale(2); opacity: 0; }
}

.ap-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
}

.ap-elapsed {
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, 'SF Mono', monospace;
  color: var(--text-1);
  background: var(--accent);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.ap-cycle {
  font-size: 11px;
  color: var(--text-3);
  font-family: ui-monospace, monospace;
}

/* State badge */
.ap-state-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(100, 116, 139, 0.1);
  color: var(--text-3);
  transition: all 0.3s;
}

.ap-state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.state-idle .ap-state-dot { animation: dot-blink 2s ease-in-out infinite; }
.state-warmup { color: #8b5cf6; background: rgba(139, 92, 246, 0.12); }
.state-warmup .ap-state-dot { animation: dot-blink 2s ease-in-out infinite; }
.state-heating { color: #f97316; background: rgba(249, 115, 22, 0.12); }
.state-heating .ap-state-dot { animation: dot-blink 1s ease-in-out infinite; }
.state-burst { color: #ef4444; background: rgba(239, 68, 68, 0.15); font-weight: 700; box-shadow: 0 0 12px rgba(239, 68, 68, 0.2); }
.state-burst .ap-state-dot { animation: dot-blink 0.5s ease-in-out infinite; }
.state-slicing { color: #3b82f6; background: rgba(59, 130, 246, 0.15); font-weight: 600; }
.state-slicing .ap-state-dot { animation: dot-blink 0.8s ease-in-out infinite; }
.state-cooldown { color: #3b82f6; background: rgba(59, 130, 246, 0.1); }

@keyframes dot-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* ===== Score Bar ===== */
.ap-score-section {
  margin-bottom: 18px;
}

.ap-score-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}

.ap-score-label {
  font-size: 12px;
  color: var(--text-3);
}

.ap-score-num {
  font-size: 28px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  transition: color 0.3s;
}

.ap-score-num small {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-3);
}

.text-calm { color: var(--text-3); }
.text-low { color: #3b82f6; }
.text-medium { color: #eab308; }
.text-high { color: #f97316; }
.text-burst { color: #ef4444; text-shadow: 0 0 16px rgba(239, 68, 68, 0.5); }

.ap-score-track {
  position: relative;
  height: 22px;
  background: var(--bar-bg);
  border-radius: 11px;
  overflow: visible;
}

/* Glow layer behind the bar fill */
.ap-score-glow {
  position: absolute;
  top: -2px;
  left: 0;
  bottom: -2px;
  border-radius: 11px;
  filter: blur(8px);
  opacity: 0.35;
  transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
  max-width: 100%;
  pointer-events: none;
}

.glow-calm { background: #94a3b8; }
.glow-low { background: #3b82f6; }
.glow-medium { background: #eab308; }
.glow-high { background: #f97316; }
.glow-burst { background: #ef4444; opacity: 0.5; }

.ap-score-fill {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  border-radius: 11px;
  transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
  max-width: 100%;
  min-width: 22px;
}

.fill-calm { background: linear-gradient(90deg, #94a3b8, #64748b); }
.fill-low { background: linear-gradient(90deg, #60a5fa, #3b82f6); }
.fill-medium { background: linear-gradient(90deg, #fbbf24, #eab308); }
.fill-high { background: linear-gradient(90deg, #fb923c, #f97316); }
.fill-burst { background: linear-gradient(90deg, #f87171, #ef4444); animation: bar-flash 1s ease-in-out infinite; }

@keyframes bar-flash {
  0%, 100% { box-shadow: 0 0 8px rgba(239, 68, 68, 0.3); }
  50% { box-shadow: 0 0 16px rgba(239, 68, 68, 0.6); }
}

.ap-score-threshold {
  position: absolute;
  top: -4px;
  bottom: -4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  transform: translateX(-50%);
  z-index: 2;
}

.ap-threshold-line {
  width: 2px;
  flex: 1;
  background: repeating-linear-gradient(to bottom, var(--text-1) 0px, var(--text-1) 3px, transparent 3px, transparent 6px);
  opacity: 0.7;
}

.ap-threshold-label {
  font-size: 9px;
  color: var(--text-3);
  white-space: nowrap;
  margin-top: 2px;
}

.ap-score-marks {
  display: flex;
  justify-content: space-between;
  padding: 4px 4px 0;
  font-size: 10px;
  color: var(--text-3);
}

.mark-hot { color: #ef4444; font-weight: 600; }

/* ===== Signal Cards ===== */
.ap-signals {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.ap-signal {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  padding: 14px;
  transition: border-color 0.3s, background 0.3s, transform 0.2s, box-shadow 0.3s;
}

.ap-signal:hover {
  border-color: rgba(255, 255, 255, 0.12);
  background: var(--glass-hover);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

.signal-off { opacity: 0.45; }

.ap-sig-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}

.ap-sig-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  flex-shrink: 0;
}

.sig-danmaku { background: rgba(59, 130, 246, 0.12); color: #3b82f6; }
.sig-audio { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
.sig-gift { background: rgba(249, 115, 22, 0.12); color: #f97316; }
.ap-sig-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  flex: 1;
}

.ap-sig-badge {
  font-size: 10px;
  color: var(--text-3);
  background: var(--bar-bg);
  padding: 1px 6px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
  transition: all 0.3s;
}

.ap-resonance-badge {
  color: #f97316;
  background: rgba(249, 115, 22, 0.12);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.ap-resonance-spark {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #f97316;
  animation: dot-blink 1s ease-in-out infinite;
}

.ap-sig-score-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ap-sig-bar {
  flex: 1;
  height: 6px;
  background: var(--bar-bg);
  border-radius: 3px;
  overflow: hidden;
}

.ap-sig-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
  min-width: 6px;
}

.bar-danmaku { background: linear-gradient(90deg, #60a5fa, #3b82f6); }
.bar-audio { background: linear-gradient(90deg, #4ade80, #22c55e); }
.bar-gift { background: linear-gradient(90deg, #fb923c, #f97316); }

.ap-gift-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ap-resonance-label {
  font-size: 10px;
  font-weight: 600;
  color: #f97316;
  white-space: nowrap;
}

.ap-sig-score {
  font-size: 18px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  min-width: 30px;
  text-align: right;
}

.ap-sig-hint {
  font-size: 11px;
  color: var(--text-3);
  padding: 4px 0;
}

.ap-sig-off-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0;
}

.ap-sig-off-text {
  font-size: 11px;
  color: var(--text-3);
  font-style: italic;
}

.ap-retry-btn {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  color: var(--text-2);
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.ap-retry-btn:hover:not(:disabled) {
  color: var(--text-1);
  border-color: var(--text-3);
}

.ap-retry-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Sub-features */
.ap-sub-features {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--card-border);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
}

.ap-sub {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ap-sub-label {
  font-size: 10px;
  color: var(--text-3);
  width: 24px;
  flex-shrink: 0;
}

.ap-sub-bar {
  flex: 1;
  height: 3px;
  background: var(--bar-bg);
  border-radius: 2px;
  overflow: hidden;
}

.ap-sub-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
  opacity: 0.8;
  min-width: 4px;
}

/* ===== Waiting ===== */
.ap-waiting {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 20px 0 4px;
  color: var(--text-3);
  font-size: 13px;
}

.ap-wave {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 22px;
}

.ap-wave span {
  display: block;
  width: 3px;
  height: 8px;
  background: var(--accent);
  border-radius: 2px;
  animation: wave-anim 1.2s ease-in-out infinite;
}

.ap-wave span:nth-child(2) { animation-delay: 0.1s; }
.ap-wave span:nth-child(3) { animation-delay: 0.2s; }
.ap-wave span:nth-child(4) { animation-delay: 0.3s; }
.ap-wave span:nth-child(5) { animation-delay: 0.4s; }

@keyframes wave-anim {
  0%, 40%, 100% { height: 8px; opacity: 0.4; }
  20% { height: 20px; opacity: 1; }
}

/* ===== Responsive ===== */
@media (max-width: 768px) {
  .ap-header { flex-direction: column; align-items: flex-start; }
  .ap-signals { grid-template-columns: 1fr; }
}
@media (min-width: 769px) and (max-width: 960px) {
  .ap-signals { grid-template-columns: 1fr 1fr; }
}
</style>
