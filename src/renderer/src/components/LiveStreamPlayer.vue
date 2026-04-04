<template>
  <div class="live-player-wrap" @mouseenter="showControls = true" @mouseleave="showControls = false">
    <video ref="videoRef" class="live-video" muted></video>

    <!-- Danmaku overlay -->
    <div class="danmaku-layer" v-if="showDanmaku">
      <div
        v-for="d in activeDanmaku"
        :key="d.id"
        class="danmaku-item"
        :style="{ top: d.top + '%', animationDuration: d.duration + 's' }"
      >
        <span class="danmaku-user" v-if="d.user">{{ d.user }}</span>
        {{ d.text }}
      </div>
    </div>

    <!-- Loading overlay -->
    <div v-if="loading && !error" class="live-player-overlay">
      <el-icon class="spin-icon" :size="32"><Loading /></el-icon>
      <span>{{ t('livePlayer.connecting') }}</span>
    </div>

    <!-- Error overlay -->
    <div v-if="error" class="live-player-overlay live-player-error">
      <el-icon :size="32"><VideoCamera /></el-icon>
      <span>{{ t('livePlayer.loadFailed') }}</span>
      <el-button size="small" round @click="manualRetry" style="margin-top: 8px;">
        {{ t('livePlayer.retry') }}
      </el-button>
    </div>

    <!-- LIVE badge -->
    <div class="live-player-badge" v-if="!error && playing">
      <span class="live-badge-dot"></span>
      LIVE
    </div>

    <!-- Controls bar -->
    <transition name="controls-fade">
      <div v-show="showControls || !playing" class="live-controls">
        <button class="ctrl-btn" @click="togglePlay" :title="playing ? t('livePlayer.pause') : t('livePlayer.play')" :aria-label="playing ? t('livePlayer.pause') : t('livePlayer.play')">
          <el-icon :size="20">
            <VideoPlay v-if="!playing" />
            <VideoPause v-else />
          </el-icon>
        </button>
        <button class="ctrl-btn" @click="toggleMute" :title="muted ? t('livePlayer.unmute') : t('livePlayer.mute')" :aria-label="muted ? t('livePlayer.unmute') : t('livePlayer.mute')">
          <el-icon :size="18">
            <Microphone v-if="!muted" />
            <Mute v-else />
          </el-icon>
        </button>
        <button class="ctrl-btn" :class="{ active: showDanmaku }" @click="showDanmaku = !showDanmaku" :title="showDanmaku ? 'Hide Danmaku' : 'Show Danmaku'" :aria-label="showDanmaku ? 'Hide Danmaku' : 'Show Danmaku'" :aria-pressed="showDanmaku">
          <el-icon :size="18"><ChatDotRound /></el-icon>
        </button>
        <div class="ctrl-spacer"></div>
        <span class="ctrl-live-tag" v-if="playing">LIVE</span>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loading, VideoCamera, VideoPlay, VideoPause, Microphone, Mute, ChatDotRound } from '@element-plus/icons-vue'
import mpegts from 'mpegts.js'

const { t } = useI18n()

interface DanmakuItem {
  text: string
  user?: string
  ts: number
}

const props = defineProps<{
  src: string
  danmaku?: DanmakuItem[]
}>()

const videoRef = ref<HTMLVideoElement>()
const loading = ref(true)
const error = ref(false)
const playing = ref(false)
const muted = ref(true)
const showControls = ref(false)
const showDanmaku = ref(true)

// Danmaku rendering state
interface ActiveDanmaku {
  id: number
  text: string
  user: string
  top: number
  duration: number
}
const activeDanmaku = ref<ActiveDanmaku[]>([])
let danmakuIdCounter = 0
let lastSeenDanmakuTs = 0

// Track occupied rows to avoid overlap
const DANMAKU_ROWS = 12
const rowFreeAt: number[] = new Array(DANMAKU_ROWS).fill(0)

function findFreeRow(): number {
  const now = Date.now()
  // Find the row that has been free the longest
  let bestRow = 0
  let bestTime = rowFreeAt[0]
  for (let i = 1; i < DANMAKU_ROWS; i++) {
    if (rowFreeAt[i] < bestTime) {
      bestTime = rowFreeAt[i]
      bestRow = i
    }
  }
  rowFreeAt[bestRow] = now + 2000 // reserve for 2 seconds
  return bestRow
}

watch(() => props.danmaku, (newDanmaku) => {
  if (!newDanmaku || !showDanmaku.value) return
  for (const d of newDanmaku) {
    if (d.ts <= lastSeenDanmakuTs) continue
    lastSeenDanmakuTs = d.ts
    const row = findFreeRow()
    const id = ++danmakuIdCounter
    const duration = 8 + Math.random() * 4 // 8-12 seconds to cross
    activeDanmaku.value.push({
      id,
      text: d.text,
      user: d.user || '',
      top: (row / DANMAKU_ROWS) * 80 + 5, // 5%-85% vertical range
      duration,
    })
    // Remove after animation completes
    setTimeout(() => {
      const idx = activeDanmaku.value.findIndex(x => x.id === id)
      if (idx >= 0) activeDanmaku.value.splice(idx, 1)
    }, duration * 1000 + 500)
  }
}, { deep: true })

let player: mpegts.Player | null = null
let stallTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let liveEdgeTimer: ReturnType<typeof setInterval> | null = null
let connectTimer: ReturnType<typeof setTimeout> | null = null
let userPaused = false
let reconnectAttempts = 0
let lastProgressTime = 0

const STALL_CHECK_INTERVAL = 5000   // check for stalls every 5s
const LIVE_EDGE_INTERVAL = 30000    // seek to live edge every 30s (was 15s — too frequent)
const RECONNECT_DELAY_BASE = 3000
const MAX_RECONNECT_ATTEMPTS = 5
const MAX_LATENCY_BEFORE_SEEK = 15  // only seek if >15s behind live edge (was 6 — too aggressive)
const CONNECT_TIMEOUT = 15000       // if no canplay within 15s, treat as failed

function clearTimers() {
  if (stallTimer) { clearInterval(stallTimer); stallTimer = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (liveEdgeTimer) { clearInterval(liveEdgeTimer); liveEdgeTimer = null }
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
}

/**
 * Seek the video to the live edge of the buffered range.
 * This prevents latency from building up and causing freezes.
 */
function seekToLiveEdge() {
  const video = videoRef.value
  if (!video || userPaused || !playing.value) return

  const buffered = video.buffered
  if (buffered.length === 0) return

  const liveEdge = buffered.end(buffered.length - 1)
  const currentLatency = liveEdge - video.currentTime

  if (currentLatency > MAX_LATENCY_BEFORE_SEEK) {
    // Seek to 1s before live edge to keep smooth playback
    video.currentTime = liveEdge - 1
    console.debug(`Live edge seek: latency was ${currentLatency.toFixed(1)}s`)
  }
}

function startStallDetection() {
  if (stallTimer) clearInterval(stallTimer)
  if (liveEdgeTimer) clearInterval(liveEdgeTimer)

  if (!videoRef.value || userPaused) return

  lastProgressTime = Date.now()

  // Periodic stall check
  stallTimer = setInterval(() => {
    if (!videoRef.value || userPaused) return
    const now = Date.now()
    // If no timeupdate for STALL_CHECK_INTERVAL, consider stalled
    if (now - lastProgressTime > STALL_CHECK_INTERVAL + 2000) {
      console.warn('Live stream stalled, attempting recovery...')
      attemptRecovery()
    }
  }, STALL_CHECK_INTERVAL)

  // Periodic live edge seeking to prevent latency buildup
  liveEdgeTimer = setInterval(seekToLiveEdge, LIVE_EDGE_INTERVAL)
}

/**
 * Try lightweight recovery before full reconnect:
 * 1. Seek to live edge
 * 2. If that fails, do full reconnect
 */
function attemptRecovery() {
  const video = videoRef.value
  if (!video || userPaused) return

  const buffered = video.buffered
  if (buffered.length > 0) {
    const liveEdge = buffered.end(buffered.length - 1)
    // There's buffered data ahead — just seek to it
    if (liveEdge - video.currentTime > 1) {
      video.currentTime = liveEdge - 0.5
      lastProgressTime = Date.now()
      console.debug('Recovery: seeked to live edge')
      return
    }
  }

  // No buffered data ahead — need full reconnect
  scheduleReconnect()
}

function scheduleReconnect() {
  if (userPaused) return
  clearTimers()
  reconnectAttempts++
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    error.value = true
    loading.value = false
    playing.value = false
    return
  }
  loading.value = true
  const delay = Math.min(RECONNECT_DELAY_BASE * reconnectAttempts, 15000)
  console.debug(`Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`)
  reconnectTimer = setTimeout(() => {
    createPlayer()
  }, delay)
}

function createPlayer() {
  destroyPlayer()
  if (!videoRef.value || !props.src) return

  loading.value = true
  error.value = false
  playing.value = false
  userPaused = false

  if (!mpegts.isSupported()) {
    error.value = true
    loading.value = false
    return
  }

  // Detect stream type from URL or query param hint
  let streamType: string = 'flv'
  try {
    const u = new URL(props.src, 'http://localhost')
    const fmt = u.searchParams.get('format')
    if (fmt === 'hls' || props.src.includes('.m3u8')) streamType = 'mse'
    else if (fmt === 'mpegts') streamType = 'mpegts'
  } catch { /* ignore */ }

  player = mpegts.createPlayer({
    type: streamType,
    isLive: true,
    url: props.src,
    hasAudio: true,
    hasVideo: true,
  }, {
    enableWorker: false,                     // disable Worker to avoid cross-origin issues with proxy URLs
    enableStashBuffer: true,
    stashInitialSize: 1024 * 384,            // 384KB initial buffer
    liveBufferLatencyChasing: true,
    liveBufferLatencyMaxLatency: 10,         // only chase when >10s behind (relaxed)
    liveBufferLatencyMinRemain: 2.0,         // keep 2s buffer for smooth playback
    lazyLoad: false,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 30,      // keep 30s backward
    autoCleanupMinBackwardDuration: 10,      // start cleanup at 10s
    fixAudioTimestampGap: true,              // fix audio gaps that cause freezing
  })

  player.attachMediaElement(videoRef.value)

  player.on(mpegts.Events.ERROR, (errorType: string, errorDetail: string, info: { msg?: string } | undefined) => {
    console.warn('mpegts error:', errorType, errorDetail, info)
    if (userPaused) {
      error.value = true
      loading.value = false
      playing.value = false
      return
    }
    // NETWORK_ERROR is usually recoverable (CDN hiccup, proxy restart)
    if (errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
      scheduleReconnect()
    } else {
      attemptRecovery()
    }
  })

  player.on(mpegts.Events.MEDIA_INFO, () => {
    console.debug('Media info received')
  })

  const video = videoRef.value

  video.addEventListener('canplay', onCanPlay)
  video.addEventListener('waiting', onWaiting)
  video.addEventListener('playing', onPlaying)
  video.addEventListener('pause', onPause)
  video.addEventListener('timeupdate', onTimeUpdate)
  video.addEventListener('stalled', onStalled)
  video.addEventListener('error', onVideoError)

  player.load()

  // Connection timeout: if no canplay within CONNECT_TIMEOUT, trigger reconnect
  connectTimer = setTimeout(() => {
    if (loading.value && !playing.value && !userPaused) {
      console.warn(`Connection timeout after ${CONNECT_TIMEOUT}ms`)
      scheduleReconnect()
    }
  }, CONNECT_TIMEOUT)
}

function onCanPlay() {
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
  loading.value = false
  reconnectAttempts = 0
  const video = videoRef.value
  if (!video) return
  video.play().then(() => {
    playing.value = true
    startStallDetection()
  }).catch(() => {
    playing.value = false
    loading.value = false
  })
}

function onWaiting() {
  // Only show loading if stuck for more than a brief moment
  // (short waiting events are normal during live playback)
}

function onPlaying() {
  loading.value = false
  playing.value = true
  lastProgressTime = Date.now()
}

function onPause() {
  playing.value = false
  if (userPaused) clearTimers()
}

function onTimeUpdate() {
  lastProgressTime = Date.now()
}

function onStalled() {
  console.debug('Video stalled event')
  if (!userPaused) {
    // Give it a moment before attempting recovery
    setTimeout(() => {
      if (videoRef.value && !userPaused && Date.now() - lastProgressTime > 5000) {
        attemptRecovery()
      }
    }, 3000)
  }
}

function onVideoError() {
  console.warn('Video element error')
  if (!userPaused) attemptRecovery()
}

function destroyPlayer() {
  clearTimers()
  const video = videoRef.value
  if (video) {
    video.removeEventListener('canplay', onCanPlay)
    video.removeEventListener('waiting', onWaiting)
    video.removeEventListener('playing', onPlaying)
    video.removeEventListener('pause', onPause)
    video.removeEventListener('timeupdate', onTimeUpdate)
    video.removeEventListener('stalled', onStalled)
    video.removeEventListener('error', onVideoError)
  }
  if (player) {
    try {
      player.pause()
      player.unload()
      player.detachMediaElement()
      player.destroy()
    } catch { /* ignore */ }
    player = null
  }
  playing.value = false
}

function togglePlay() {
  if (!videoRef.value) return
  if (error.value) {
    manualRetry()
    return
  }
  if (playing.value) {
    userPaused = true
    videoRef.value.pause()
  } else {
    userPaused = false
    // Seek to live edge when resuming
    seekToLiveEdge()
    videoRef.value.play().then(() => {
      startStallDetection()
    }).catch(() => {})
  }
}

function manualRetry() {
  userPaused = false
  reconnectAttempts = 0
  createPlayer()
}

function toggleMute() {
  if (!videoRef.value) return
  muted.value = !muted.value
  videoRef.value.muted = muted.value
}

onMounted(() => {
  if (props.src) createPlayer()
})

watch(() => props.src, (newSrc) => {
  if (newSrc) createPlayer()
  else destroyPlayer()
})

onBeforeUnmount(() => {
  clearTimers()
  destroyPlayer()
})
</script>

<style scoped>
.live-player-wrap {
  position: relative;
  background: #0a0a0a;
  border-radius: 8px;
  overflow: hidden;
  aspect-ratio: 16 / 9;
}

.live-video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
}

.live-player-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 13px;
  background: rgba(0, 0, 0, 0.6);
  z-index: 2;
}

.live-player-error {
  color: rgba(255, 255, 255, 0.5);
}

.spin-icon {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.live-player-badge {
  position: absolute;
  top: 10px;
  left: 10px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 4px;
  background: rgba(255, 50, 50, 0.85);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  z-index: 1;
}

.live-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fff;
  animation: pulse-badge 1.5s ease-in-out infinite;
}

@keyframes pulse-badge {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* Controls bar */
.live-controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
  z-index: 3;
}

.controls-fade-enter-active,
.controls-fade-leave-active {
  transition: opacity 0.3s ease;
}
.controls-fade-enter-from,
.controls-fade-leave-to {
  opacity: 0;
}

.ctrl-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  cursor: pointer;
  transition: background 0.2s;
}

.ctrl-btn:hover {
  background: rgba(255, 255, 255, 0.3);
}

.ctrl-btn:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.8);
  outline-offset: 2px;
}

.ctrl-spacer {
  flex: 1;
}

.ctrl-live-tag {
  font-size: 10px;
  font-weight: 700;
  color: #ff4d4f;
  letter-spacing: 1px;
  padding: 2px 8px;
  border: 1px solid rgba(255, 77, 79, 0.5);
  border-radius: 3px;
}

.ctrl-btn.active {
  background: rgba(64, 158, 255, 0.4);
}

/* Danmaku overlay */
.danmaku-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 1;
}

.danmaku-item {
  position: absolute;
  right: 0;
  white-space: nowrap;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8), -1px -1px 2px rgba(0, 0, 0, 0.5);
  animation: danmaku-scroll linear forwards;
  will-change: transform;
  pointer-events: none;
}

.danmaku-user {
  color: rgba(255, 200, 100, 0.9);
  margin-right: 6px;
  font-size: 12px;
  font-weight: 400;
}

@keyframes danmaku-scroll {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(calc(-100vw - 100%));
  }
}
</style>
