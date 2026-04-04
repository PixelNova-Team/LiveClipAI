<template>
  <div class="settings-page">
    <div class="page-header">
      <div>
        <h2 class="page-title">{{ t('settings.title') }}</h2>
        <p class="page-desc">{{ t('settings.subtitle') }}</p>
      </div>
    </div>

    <!-- Floating save bar at bottom -->
    <transition name="float-up">
      <div class="floating-save-bar" v-if="hasChanges">
        <div class="floating-save-content">
          <el-icon><WarningFilled /></el-icon>
          <span>{{ t('settings.unsavedChanges') }}</span>
          <div class="floating-save-actions">
            <el-button round @click="resetAll">{{ t('settings.discard') }}</el-button>
            <el-button type="primary" round @click="saveAll" :loading="saving">
              <el-icon><Check /></el-icon>
              {{ t('settings.saveSettings') }}
            </el-button>
          </div>
        </div>
      </div>
    </transition>

    <div v-loading="loadingConfig" class="config-sections">
      <!-- AI Config -->
      <div class="config-card glass-card animate-in" style="--delay: 0">
        <div class="config-card-header" @click="toggleSection('ai')">
          <div class="config-header-left">
            <div class="config-icon-wrap ai-icon">
              <el-icon :size="20" color="#fff"><MagicStick /></el-icon>
            </div>
            <div class="config-header-text">
              <h3 class="ai-title">
                <span class="ai-sparkle">✦</span>
                {{ t('settings.aiConfig') }}
                <el-tag size="small" effect="dark" round class="ai-badge">AI</el-tag>
              </h3>
              <span class="config-subtitle">{{ t('settings.aiSubtitle') }}</span>
            </div>
          </div>
          <el-icon class="collapse-arrow" :class="{ rotated: sections.ai }"><ArrowDown /></el-icon>
        </div>
        <el-collapse-transition>
          <div v-show="sections.ai" class="config-body">
            <el-form label-position="top" class="config-form">
              <el-row :gutter="24">
                <el-col :span="24">
                  <el-form-item :label="t('settings.activeProvider')">
                    <el-select v-model="form.ai.active_provider" style="width: 100%">
                      <el-option :label="t('settings.providerQwen')" value="qwen" />
                      <el-option :label="t('settings.providerOpenai')" value="openai" />
                      <el-option :label="t('settings.providerClaude')" value="claude" />
                      <el-option :label="t('settings.providerGemini')" value="gemini" />
                      <el-option :label="t('settings.providerZhipu')" value="zhipu" />
                      <el-option :label="t('settings.providerLocal')" value="local" />
                    </el-select>
                  </el-form-item>
                </el-col>
              </el-row>

              <!-- Active provider config -->
              <div class="provider-section active-provider" v-if="activeProvider">
                <div class="provider-header">
                  <span class="provider-name">{{ t('settings.providerConfig', { name: getProviderLabel(form.ai.active_provider) }) }}</span>
                  <el-tag size="small" type="success" effect="dark">{{ t('settings.currentlyUsed') }}</el-tag>
                </div>
                <el-row :gutter="16">
                  <el-col :span="8">
                    <el-form-item :label="t('settings.apiUrl')">
                      <el-input v-model="activeProvider.base_url" :placeholder="getProviderDefault(form.ai.active_provider, 'url')" />
                    </el-form-item>
                  </el-col>
                  <el-col :span="8">
                    <el-form-item :label="t('settings.apiKey')">
                      <el-input v-model="activeProvider.api_key" :placeholder="maskedProviders.has(form.ai.active_provider) ? t('settings.apiKeyConfigured') : 'sk-...'" show-password />
                    </el-form-item>
                  </el-col>
                  <el-col :span="8">
                    <el-form-item :label="t('settings.modelName')">
                      <el-input v-model="activeProvider.model" :placeholder="getProviderDefault(form.ai.active_provider, 'model')" />
                    </el-form-item>
                  </el-col>
                </el-row>
              </div>


            </el-form>
          </div>
        </el-collapse-transition>
      </div>

      <!-- ASR (Speech Recognition) Config -->
      <div class="config-card glass-card animate-in" style="--delay: 1">
        <div class="config-card-header" @click="toggleSection('whisper')">
          <div class="config-header-left">
            <div class="config-icon-wrap whisper-icon">
              <el-icon :size="20" color="#fff"><Microphone /></el-icon>
            </div>
            <div class="config-header-text">
              <h3>{{ t('settings.asrConfig') }}</h3>
              <span class="config-subtitle">{{ t('settings.asrSubtitle') }}</span>
            </div>
          </div>
          <el-icon class="collapse-arrow" :class="{ rotated: sections.whisper }"><ArrowDown /></el-icon>
        </div>
        <el-collapse-transition>
          <div v-show="sections.whisper" class="config-body">
            <el-form label-position="top" class="config-form">
              <!-- ASR Provider Selector -->
              <el-form-item :label="t('settings.asrProvider')" style="margin-bottom: 16px;">
                <el-radio-group v-model="form.asr.provider" @change="onAsrProviderChange">
                  <el-radio-button value="whisper-local">
                    Whisper ({{ t('settings.asrLocal') }})
                  </el-radio-button>
                  <el-radio-button value="paraformer">
                    Paraformer (DashScope)
                  </el-radio-button>
                  <el-radio-button value="volcengine">
                    {{ t('settings.asrVolcengine') }}
                  </el-radio-button>
                </el-radio-group>
              </el-form-item>

              <!-- Whisper Local Config -->
              <div v-if="form.asr.provider === 'whisper-local'" class="provider-section" :class="{ 'active-provider': whisperLocal.ready }">
                <div class="provider-header">
                  <span class="provider-name">{{ t('settings.whisperLocal') }}</span>
                  <el-tag v-if="whisperLocal.ready" type="success" size="small" round effect="dark">{{ t('settings.whisperReady') }}</el-tag>
                  <el-button v-else size="small" round :loading="whisperSetupLoading" @click="handleWhisperSetup">
                    {{ t('settings.whisperInstall') }}
                  </el-button>
                </div>
                <div class="whisper-local-desc">{{ t('settings.whisperLocalDesc') }}</div>
                <el-form-item :label="t('settings.whisperModelSelect')" style="margin-top: 8px; margin-bottom: 4px;">
                  <el-select v-model="form.whisperLocalModel" size="small" style="width: 320px;" @change="onWhisperModelChange">
                    <el-option v-for="m in whisperLocal.availableModels" :key="m.value" :value="m.value">
                      <span>{{ m.label }}</span>
                      <el-tag v-if="m.downloaded" type="success" size="small" style="margin-left: 8px;">{{ t('settings.whisperDownloaded') }}</el-tag>
                    </el-option>
                  </el-select>
                </el-form-item>
                <div v-if="downloadedModels.length > 0" class="whisper-local-info" style="margin-top: 4px;">
                  <div v-for="m in downloadedModels" :key="m.value" style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                    <span style="font-size: 12px;">{{ m.label }}</span>
                    <el-button
                      v-if="m.value !== form.whisperLocalModel"
                      size="small" type="danger" text
                      @click="handleDeleteModel(m.value, m.label)"
                    >{{ t('common.delete') }}</el-button>
                    <el-tag v-else size="small" type="info">{{ t('settings.whisperInUse') }}</el-tag>
                  </div>
                </div>
                <template v-if="whisperSetupLoading">
                  <el-progress :percentage="whisperSetupProgress" :format="() => whisperSetupStage" style="margin-top: 8px;" />
                </template>
                <template v-if="whisperLocal.ready">
                  <div class="whisper-local-info">
                    <span>{{ t('settings.whisperBinary') }}: {{ whisperLocal.binaryPath }}</span>
                  </div>
                </template>
              </div>

              <!-- Paraformer (DashScope) Config -->
              <div v-if="form.asr.provider === 'paraformer'" class="provider-section active-provider">
                <div class="provider-header">
                  <span class="provider-name">Paraformer ({{ t('settings.asrParaformerDesc') }})</span>
                </div>
                <div class="whisper-local-desc">{{ t('settings.asrParaformerHint') }}</div>
                <el-row :gutter="16" style="margin-top: 8px;">
                  <el-col :span="16">
                    <el-form-item label="DashScope API Key">
                      <el-input v-model="form.asr.paraformer.api_key" placeholder="sk-..." show-password />
                    </el-form-item>
                  </el-col>
                </el-row>
              </div>

              <!-- Volcengine ASR Config -->
              <div v-if="form.asr.provider === 'volcengine'" class="provider-section active-provider">
                <div class="provider-header">
                  <span class="provider-name">{{ t('settings.asrVolcengine') }}</span>
                </div>
                <div class="whisper-local-desc">{{ t('settings.asrVolcengineHint') }}</div>
                <el-row :gutter="16" style="margin-top: 8px;">
                  <el-col :span="12">
                    <el-form-item label="App ID">
                      <el-input v-model="form.asr.volcengine.app_id" placeholder="App ID" />
                    </el-form-item>
                  </el-col>
                  <el-col :span="12">
                    <el-form-item label="Access Token">
                      <el-input v-model="form.asr.volcengine.access_token" placeholder="Access Token" show-password />
                    </el-form-item>
                  </el-col>
                </el-row>
              </div>

              <!-- Legacy API Whisper (fallback, hidden if new ASR is configured) -->
              <div v-if="form.asr.provider === 'whisper-local'" class="provider-section" :class="{ 'active-provider': form.ai.whisper?.enabled }" style="margin-top: 12px;">
                <div class="provider-header">
                  <span class="provider-name">{{ t('settings.whisperApi') }}</span>
                  <el-switch v-model="form.ai.whisper.enabled" size="small" />
                </div>
                <template v-if="form.ai.whisper?.enabled">
                  <div style="margin-bottom: 12px; font-size: 12px; color: var(--el-text-color-secondary);">
                    {{ t('settings.whisperApiDesc') }}
                  </div>
                  <el-row :gutter="16">
                    <el-col :span="8">
                      <el-form-item :label="t('settings.apiUrl')">
                        <el-input v-model="form.ai.whisper.base_url" placeholder="https://api.groq.com/openai/v1" />
                      </el-form-item>
                    </el-col>
                    <el-col :span="8">
                      <el-form-item :label="t('settings.apiKey')">
                        <el-input v-model="form.ai.whisper.api_key" placeholder="sk-..." show-password />
                      </el-form-item>
                    </el-col>
                    <el-col :span="8">
                      <el-form-item :label="t('settings.modelName')">
                        <el-autocomplete
                          v-model="form.ai.whisper.model"
                          :fetch-suggestions="whisperModelSuggestions"
                          placeholder="whisper-large-v3-turbo"
                          style="width: 100%"
                          :trigger-on-focus="true"
                        />
                      </el-form-item>
                    </el-col>
                  </el-row>
                </template>
              </div>
            </el-form>
          </div>
        </el-collapse-transition>
      </div>

      <!-- Slice Config -->
      <div class="config-card glass-card animate-in" style="--delay: 2">
        <div class="config-card-header" @click="toggleSection('slice')">
          <div class="config-header-left">
            <div class="config-icon-wrap slice-icon">
              <el-icon :size="20" color="#fff"><ScaleToOriginal /></el-icon>
            </div>
            <div class="config-header-text">
              <h3>{{ t('settings.sliceConfig') }}</h3>
              <span class="config-subtitle">{{ t('settings.sliceSubtitle') }}</span>
            </div>
          </div>
          <el-icon class="collapse-arrow" :class="{ rotated: sections.slice }"><ArrowDown /></el-icon>
        </div>
        <el-collapse-transition>
          <div v-show="sections.slice" class="config-body">
            <el-form label-position="top" class="config-form">
              <el-row :gutter="24">
                <el-col :span="8">
                  <el-form-item :label="t('settings.minDuration')">
                    <el-input-number v-model="form.slice.min_duration" :min="5" :max="form.slice.max_duration - 1" style="width: 100%" />
                    <div class="form-help">{{ t('settings.minDurationHelp') }}</div>
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item :label="t('settings.maxDuration')">
                    <el-input-number v-model="form.slice.max_duration" :min="30" :max="600" style="width: 100%" />
                    <div class="form-help">{{ t('settings.maxDurationHelp') }}</div>
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item :label="t('settings.maxConcurrentSlices')">
                    <el-input-number v-model="form.slice.max_concurrent_slices" :min="1" :max="5" :step="1" style="width: 100%" />
                    <div class="form-help">{{ t('settings.maxConcurrentSlicesHelp') }}</div>
                  </el-form-item>
                </el-col>
              </el-row>
              <!-- Duration validation warning -->
              <div v-if="durationWarning" class="duration-warning">
                <el-icon><WarningFilled /></el-icon>
                <span>{{ durationWarning }}</span>
              </div>

              <el-row :gutter="24">
                <el-col :span="12">
                  <el-form-item :label="t('settings.burstThreshold')">
                    <el-slider v-model="form.slice.burst_threshold" :min="0.3" :max="1" :step="0.05" show-input :show-input-controls="false" />
                    <div class="form-help">{{ t('settings.burstThresholdDesc') }}</div>
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item :label="t('settings.outputDir')">
                    <el-input v-model="form.slice.output_dir" placeholder="./output/slices" />
                  </el-form-item>
                </el-col>
              </el-row>

              <el-row :gutter="24">
                <el-col :span="12">
                  <el-form-item :label="t('settings.outputResolution')">
                    <el-select v-model="form.slice.resolution" :placeholder="t('settings.originalResolution')" clearable style="width: 100%">
                      <el-option label="4K (3840×2160)" value="3840x2160" />
                      <el-option label="2K (2560×1440)" value="2560x1440" />
                      <el-option label="1080p (1920×1080)" value="1920x1080" />
                      <el-option label="720p (1280×720)" value="1280x720" />
                      <el-option label="480p (854×480)" value="854x480" />
                    </el-select>
                    <div class="form-help">{{ t('settings.outputResolutionHelp') }}</div>
                  </el-form-item>
                </el-col>
              </el-row>
            </el-form>
          </div>
        </el-collapse-transition>
      </div>

      <!-- Publish Settings -->
      <div class="config-card glass-card animate-in" style="--delay: 3">
        <div class="config-card-header" @click="toggleSection('publish')">
          <div class="config-header-left">
            <div class="config-icon-wrap publish-icon">
              <el-icon :size="20" color="#fff"><Promotion /></el-icon>
            </div>
            <div class="config-header-text">
              <h3>{{ t('settings.publishConfig') }}</h3>
              <span class="config-subtitle">{{ t('settings.publishSubtitle') }}</span>
            </div>
          </div>
          <el-icon class="collapse-arrow" :class="{ rotated: sections.publish }"><ArrowDown /></el-icon>
        </div>
        <el-collapse-transition>
          <div v-show="sections.publish" class="config-body">
            <el-form label-position="top" class="config-form">
              <el-row :gutter="24">
                <el-col :span="12">
                  <el-form-item :label="t('settings.autoPublish')">
                    <el-switch v-model="form.publish.auto_publish" />
                    <div class="form-help">{{ t('settings.autoPublishDesc') }}</div>
                  </el-form-item>
                </el-col>
                <el-col :span="12" v-if="form.publish.auto_publish">
                  <el-form-item :label="t('settings.defaultPlatforms')">
                    <el-select v-model="form.publish.default_platforms" multiple style="width: 100%">
                      <el-option
                        v-for="p in authedPublishPlatforms"
                        :key="p.name"
                        :label="p.label"
                        :value="p.name"
                      />
                    </el-select>
                    <div class="form-help">{{ t('settings.defaultPlatformsDesc') }}</div>
                    <div v-if="publishPlatforms.length > 0 && authedPublishPlatforms.length === 0" class="form-help" style="color: var(--el-color-warning);">
                      {{ t('settings.noAuthedPlatform') }}
                    </div>
                  </el-form-item>
                </el-col>
              </el-row>
              <div v-if="form.publish.auto_publish && form.publish.default_platforms.length === 0" class="publish-no-platform-hint">
                <el-icon :size="14"><WarningFilled /></el-icon>
                <span>{{ t('settings.noPublishPlatform') }}</span>
              </div>
              <el-row :gutter="24" v-if="form.publish.auto_publish">
                <el-col :span="12">
                  <el-form-item :label="t('settings.showPublishWindow')">
                    <el-switch v-model="form.publish.show_publish_window" />
                    <div class="form-help">{{ t('settings.showPublishWindowDesc') }}</div>
                  </el-form-item>
                </el-col>
              </el-row>
              <el-row :gutter="24" v-if="form.publish.auto_publish">
                <el-col :span="12">
                  <el-form-item :label="t('settings.defaultDescription')">
                    <el-input
                      v-model="form.publish.default_description"
                      type="textarea"
                      :rows="2"
                      :placeholder="t('settings.defaultDescriptionPlaceholder')"
                    />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item :label="t('settings.defaultTags')">
                    <el-select
                      v-model="form.publish.default_tags"
                      multiple
                      filterable
                      allow-create
                      default-first-option
                      style="width: 100%"
                      :placeholder="t('settings.defaultTagsPlaceholder')"
                    />
                  </el-form-item>
                </el-col>
              </el-row>
            </el-form>
          </div>
        </el-collapse-transition>
      </div>

      <!-- Platform Auth -->
      <div class="config-card glass-card animate-in" style="--delay: 4" v-if="availablePlatforms.length > 0">
        <div class="config-card-header" @click="toggleSection('platformAuth')">
          <div class="config-header-left">
            <div class="config-icon-wrap platform-auth-icon">
              <el-icon :size="20" color="#fff"><Iphone /></el-icon>
            </div>
            <div class="config-header-text">
              <h3>{{ t('settings.platformAuthTitle') }}</h3>
              <span class="config-subtitle">{{ t('settings.platformAuthSubtitle') }}</span>
            </div>
          </div>
          <el-icon class="collapse-arrow" :class="{ rotated: sections.platformAuth }"><ArrowDown /></el-icon>
        </div>
        <el-collapse-transition>
          <div v-show="sections.platformAuth" class="config-body">
            <div class="publish-auth-hint">
              <el-icon :size="16"><Iphone /></el-icon>
              <span>{{ t('settings.publishAuthHint') }}</span>
            </div>
            <el-row :gutter="16">
              <el-col :span="8" v-for="p in availablePlatforms" :key="p.name">
                <div class="publish-platform-card" :class="{ 'is-logged-in': platformAuth[p.name] }">
                  <div class="publish-platform-header">
                    <span class="publish-platform-name">{{ p.label }}</span>
                    <el-tag
                      :type="platformAuth[p.name] ? 'success' : 'info'"
                      size="small"
                      effect="plain"
                      round
                    >
                      {{ platformAuth[p.name] ? t('settings.tokenConfigured') : t('settings.tokenNotConfigured') }}
                    </el-tag>
                  </div>
                  <div class="qr-login-area">
                    <div v-if="platformAuth[p.name]" class="qr-logged-in">
                      <el-icon :size="40" color="var(--status-success)"><CircleCheckFilled /></el-icon>
                      <span class="qr-logged-text">{{ t('settings.tokenConfigured') }}</span>
                      <el-button type="danger" text size="small" @click="handleLogout(p.name)">
                        {{ t('settings.qrLogout') }}
                      </el-button>
                    </div>
                    <div v-else-if="qrState[p.name]?.active" class="qr-code-box">
                      <div class="qr-loading">
                        <el-icon :size="24" class="is-loading"><Loading /></el-icon>
                        <span>{{ t('settings.qrBrowserDesc') }}</span>
                      </div>
                    </div>
                    <div v-else class="qr-login-trigger">
                      <el-button type="primary" plain round @click="startQRLogin(p.name)">
                        <el-icon><Iphone /></el-icon>
                        {{ t('settings.qrLogin') }}
                      </el-button>
                    </div>
                  </div>
                </div>
              </el-col>
            </el-row>
          </div>
        </el-collapse-transition>
      </div>

      <!-- Cache Management -->
      <div class="config-card glass-card animate-in" style="--delay: 5">
        <div class="config-card-header" @click="toggleSection('cache')">
          <div class="config-header-left">
            <div class="config-icon-wrap cache-icon">
              <el-icon :size="20" color="#fff"><FolderDelete /></el-icon>
            </div>
            <div class="config-header-text">
              <h3>{{ t('settings.cacheConfig') }}</h3>
              <span class="config-subtitle">{{ t('settings.cacheSubtitle') }}</span>
            </div>
          </div>
          <el-icon class="collapse-arrow" :class="{ rotated: sections.cache }"><ArrowDown /></el-icon>
        </div>
        <el-collapse-transition>
          <div v-show="sections.cache" class="config-body">
            <div v-if="cacheLoading" class="cache-loading">
              <el-icon class="is-loading"><Loading /></el-icon>
              {{ t('settings.cacheLoading') }}
            </div>
            <template v-else>
              <!-- Overview cards -->
              <div class="cache-overview">
                <div class="cache-stat-card">
                  <div class="cache-stat-icon temp-bg"><el-icon :size="22"><Files /></el-icon></div>
                  <div class="cache-stat-info">
                    <div class="cache-stat-label">{{ t('settings.tempFiles') }}</div>
                    <div class="cache-stat-value">{{ formatBytes(cacheStats.temp?.total_size || 0) }}</div>
                    <div class="cache-stat-desc">{{ t('settings.fileCount', { count: cacheStats.temp?.file_count || 0 }) }}</div>
                  </div>
                  <el-button size="small" type="warning" plain round @click="handleClear('temp')" :loading="clearing">
                    {{ t('settings.clearTemp') }}
                  </el-button>
                </div>
                <div class="cache-stat-card">
                  <div class="cache-stat-icon cache-bg"><el-icon :size="22"><Coin /></el-icon></div>
                  <div class="cache-stat-info">
                    <div class="cache-stat-label">{{ t('settings.cacheFiles') }}</div>
                    <div class="cache-stat-value">{{ formatBytes(cacheStats.cache?.total_size || 0) }}</div>
                    <div class="cache-stat-desc">{{ t('settings.fileCount', { count: cacheStats.cache?.file_count || 0 }) }}</div>
                  </div>
                  <el-button size="small" type="warning" plain round @click="handleClear('cache')" :loading="clearing">
                    {{ t('settings.clearCache') }}
                  </el-button>
                </div>
                <div class="cache-stat-card">
                  <div class="cache-stat-icon output-bg"><el-icon :size="22"><VideoPlay /></el-icon></div>
                  <div class="cache-stat-info">
                    <div class="cache-stat-label">{{ t('settings.outputFiles') }}</div>
                    <div class="cache-stat-value">{{ formatBytes(cacheStats.output?.total_size || 0) }}</div>
                    <div class="cache-stat-desc">{{ t('settings.fileCount', { count: cacheStats.output?.file_count || 0 }) }}</div>
                  </div>
                  <el-button size="small" type="warning" plain round @click="handleClear('output')" :loading="clearing">
                    {{ t('settings.clearOutput') }}
                  </el-button>
                </div>
              </div>

              <!-- Task temp dirs -->
              <div v-if="cacheStats.temp?.task_dirs?.length" class="task-dirs-section">
                <h4 class="sub-title">{{ t('settings.taskDirs') }}</h4>
                <div class="task-dir-list">
                  <div v-for="dir in cacheStats.temp.task_dirs" :key="dir.name" class="task-dir-item">
                    <div class="task-dir-info">
                      <span class="task-dir-name">{{ dir.name }}</span>
                      <span class="task-dir-size">{{ formatBytes(dir.size) }}</span>
                      <span class="task-dir-count">{{ t('settings.fileCount', { count: dir.file_count }) }}</span>
                    </div>
                    <el-button size="small" text type="danger" @click="handleClear('temp/' + dir.name)" :loading="clearing">
                      {{ t('settings.clearSpecific') }}
                    </el-button>
                  </div>
                </div>
              </div>

              <!-- Recording segments (cache dir) -->
              <div v-if="cacheStats.cache?.task_dirs?.length" class="task-dirs-section">
                <h4 class="sub-title">{{ t('settings.recordingSegments') }}</h4>
                <div class="task-dir-list">
                  <div v-for="dir in cacheStats.cache.task_dirs" :key="dir.name" class="task-dir-item">
                    <div class="task-dir-info">
                      <span class="task-dir-name">{{ dir.name }}</span>
                      <span class="task-dir-size">{{ formatBytes(dir.size) }}</span>
                      <span class="task-dir-count">{{ t('settings.fileCount', { count: dir.file_count }) }}</span>
                    </div>
                    <el-button size="small" text type="danger" @click="handleClear('cache/' + dir.name)" :loading="clearing">
                      {{ t('settings.clearSpecific') }}
                    </el-button>
                  </div>
                </div>
              </div>

              <!-- Slice storage -->
              <div v-if="cacheStats.slices" class="task-dirs-section">
                <h4 class="sub-title">
                  {{ t('settings.sliceStorage') }}
                  <span class="sub-title-desc">— {{ formatBytes(cacheStats.slices.total_size) }}, {{ t('settings.sliceCount', { count: cacheStats.slices.total_count }) }}</span>
                </h4>
                <div v-if="cacheStats.slices.tasks?.length" class="task-dir-list">
                  <div v-for="st in cacheStats.slices.tasks" :key="st.task_id" class="task-dir-item">
                    <div class="task-dir-info">
                      <PlatformIcon :platform="st.platform" size="sm" />
                      <span class="task-dir-name slice-task-title">{{ st.title }}</span>
                      <span class="task-dir-size">{{ formatBytes(st.size) }}</span>
                      <span class="task-dir-count">{{ t('settings.sliceCount', { count: st.slice_count }) }}</span>
                      <el-tag v-if="isActiveStatus(st.status)" size="small" type="warning" effect="light">{{ t('settings.activeTask') }}</el-tag>
                    </div>
                    <el-button size="small" text type="danger" @click="handleClearTaskSlices(st.task_id)" :loading="clearing">
                      {{ t('settings.clearTaskSlices') }}
                    </el-button>
                  </div>
                </div>
                <div v-else class="no-data-hint">{{ t('settings.noSliceData') }}</div>
                <div v-if="cacheStats.slices.tasks?.length" class="slice-batch-actions">
                  <el-button type="warning" plain round size="small" @click="handleClearFinishedSlices" :loading="clearing">
                    {{ t('settings.clearFinishedSlices') }}
                  </el-button>
                </div>
              </div>

              <!-- Clear options -->
              <div class="cache-actions-section">
                <h4 class="sub-title">{{ t('settings.cleanupOptions') }}</h4>
                <div class="cache-actions">
                  <el-button plain type="warning" round @click="handleClear('all')" :loading="clearing">
                    <el-icon><Delete /></el-icon>
                    {{ t('settings.clearAll') }}
                  </el-button>
                  <el-button type="danger" round @click="handleFullCleanup" :loading="clearing" v-if="!fullCleanupMode">
                    <el-icon><Delete /></el-icon>
                    {{ t('settings.deepCleanup') }}
                  </el-button>
                </div>

                <!-- Full cleanup confirmation -->
                <el-alert
                  v-if="fullCleanupMode"
                  type="error"
                  :closable="false"
                  title="⚠️ 完全清理模式"
                  description="此操作将清理应用的所有内容，包括：缓存文件、数据库、认证信息、任务历史。执行后应用将恢复初始状态。"
                  style="margin-top: 16px; margin-bottom: 12px;"
                />
                <div v-if="fullCleanupMode" class="full-cleanup-actions">
                  <el-checkbox v-model="confirmFullCleanup">确认清理所有数据</el-checkbox>
                  <div class="full-cleanup-buttons">
                    <el-button plain @click="fullCleanupMode = false">取消</el-button>
                    <el-button type="danger" @click="confirmFullCleanupAction" :disabled="!confirmFullCleanup" :loading="clearing">
                      确认清理
                    </el-button>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </el-collapse-transition>
      </div>

      <!-- Language Config -->
      <div class="config-card glass-card animate-in" style="--delay: 6">
        <div class="config-card-header" @click="toggleSection('lang')">
          <div class="config-header-left">
            <div class="config-icon-wrap lang-icon">
              <el-icon :size="20" color="#fff"><ChatDotRound /></el-icon>
            </div>
            <div class="config-header-text">
              <h3>{{ t('settings.language') }}</h3>
              <span class="config-subtitle">{{ t('settings.languageSubtitle') }}</span>
            </div>
          </div>
          <el-icon class="collapse-arrow" :class="{ rotated: sections.lang }"><ArrowDown /></el-icon>
        </div>
        <el-collapse-transition>
          <div v-show="sections.lang" class="config-body">
            <el-form label-position="top" class="config-form">
              <el-row :gutter="24">
                <el-col :span="8">
                  <el-form-item :label="t('settings.selectLanguage')">
                    <el-select v-model="currentLocale" style="width: 100%" @change="handleLocaleChange">
                      <el-option :label="t('settings.langZh')" value="zh-CN" />
                      <el-option :label="t('settings.langEn')" value="en" />
                    </el-select>
                  </el-form-item>
                </el-col>
              </el-row>
            </el-form>
          </div>
        </el-collapse-transition>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ScaleToOriginal, MagicStick, Microphone,
  ArrowDown, Check, RefreshLeft, WarningFilled, ChatDotRound,
  FolderDelete, Files, Coin, VideoPlay, Delete, Loading,
  Promotion, Iphone, CircleCheckFilled,
} from '@element-plus/icons-vue'
import { getAllConfig, updateConfig, getCacheStats, clearCache, clearTaskSlices, clearFinishedSlices } from '@/api/config'
import { getPlatforms } from '@/api/publish'
import ipc from '@/api/client'
import { loginWithBrowser, getAuthStatus, logout as authLogout } from '@/api/auth'
import PlatformIcon from '@/components/PlatformIcon.vue'
import { setLocale } from '@/i18n'
import i18n from '@/i18n'
const { t } = useI18n()

const loadingConfig = ref(true)
const saving = ref(false)
const originalJson = ref('')
const cacheLoading = ref(false)
const cacheStats = ref<any>({})
const clearing = ref(false)
const fullCleanupMode = ref(false)
const confirmFullCleanup = ref(false)

// ========== QR Code Login ==========
interface QRLoginState {
  active: boolean
  loading: boolean
  qrImageUrl: string
  pollParams: Record<string, string>
  status: 'waiting' | 'scanned' | 'expired' | 'success'
  pollTimer: ReturnType<typeof setInterval> | null
}

const platformAuth = reactive<Record<string, boolean>>({})
const qrState = reactive<Record<string, QRLoginState>>({})

function initQRState(): QRLoginState {
  return { active: false, loading: false, qrImageUrl: '', pollParams: {}, status: 'waiting', pollTimer: null }
}

async function loadAuthStatuses() {
  for (const p of availablePlatforms.value) {
    try {
      const res = await getAuthStatus(p.name)
      platformAuth[p.name] = res.authenticated
    } catch {
      platformAuth[p.name] = false
    }
  }
}

async function startQRLogin(platform: string) {
  qrState[platform] = { ...initQRState(), active: true, loading: true }

  try {
    const res = await loginWithBrowser(platform)
    qrState[platform].loading = false
    qrState[platform].active = false

    if (res.success) {
      platformAuth[platform] = true
      ElMessage.success(t('settings.qrSuccess', { platform }))
    } else {
      ElMessage.warning(t('settings.qrFailed'))
    }
  } catch {
    qrState[platform].loading = false
    qrState[platform].active = false
    ElMessage.warning(t('settings.qrFailed'))
  }
}

async function handleLogout(platform: string) {
  try {
    await ElMessageBox.confirm(
      t('settings.logoutConfirm', { platform }),
      t('settings.logoutTitle'),
      { type: 'warning' }
    )
    await authLogout(platform)
    platformAuth[platform] = false
    ElMessage.success(t('settings.logoutSuccess'))
  } catch { /* cancelled */ }
}

// Clean up poll timers on unmount
onUnmounted(() => {
  for (const state of Object.values(qrState)) {
    if (state.pollTimer) clearInterval(state.pollTimer)
  }
})

const currentLocale = ref(i18n.global.locale.value as string)

function handleLocaleChange(locale: string) {
  setLocale(locale)
  currentLocale.value = locale
}

const sections = reactive({
  ai: false,
  whisper: false,
  slice: false,
  publish: false,
  platformAuth: false,
  cache: false,
  lang: false,
})

interface PlatformItem {
  name: string
  label: string
}
const availablePlatforms = ref<PlatformItem[]>([])
const publishPlatforms = ref<PlatformItem[]>([])

const form = reactive({
  ai: {
    active_provider: 'qwen',
    providers: {} as Record<string, { base_url: string; api_key: string; model: string }>,
    whisper: { enabled: false, base_url: '', api_key: '', model: 'whisper-large-v3-turbo' },
  },
  slice: {
    min_duration: 15,
    max_duration: 180,
    burst_threshold: 0.6,
    heating_threshold: 0.35,
    danmaku_weight: 0.45,
    audio_weight: 0.25,
    ai_weight: 0.30,
    max_concurrent_slices: 1,
    output_dir: './output/slices',
    resolution: '',
  },
  live: {
    analysis_interval: 1,
    custom_keywords: {} as Record<string, number>,
  },
  publish: {
    auto_publish: false,
    auto_publish_threshold: 0.8,
    default_platforms: [] as string[],
    show_publish_window: false,
    default_description: '',
    default_tags: ['直播切片', '精彩时刻'] as string[],
  },
  asr: {
    provider: 'whisper-local',
    paraformer: { api_key: '' },
    volcengine: { app_id: '', access_token: '' },
  },
  whisperLocalModel: 'large-v3-turbo',
})

// Publish platforms filtered by auth status
const authedPublishPlatforms = computed(() => {
  return publishPlatforms.value.filter(p => platformAuth[p.name])
})

const durationWarning = computed(() => {
  const min = form.slice.min_duration
  const max = form.slice.max_duration
  if (min >= max) {
    return t('settings.durationErrorMinMax')
  }
  const diff = max - min
  if (diff <= 10) {
    return t('settings.durationWarnTooClose', { diff })
  }
  return ''
})

const hasChanges = computed(() => {
  return JSON.stringify(form) !== originalJson.value
})

const activeProvider = computed(() => {
  const name = form.ai.active_provider
  return form.ai.providers[name] || { base_url: '', api_key: '', model: '' }
})

function ensureAllProviders() {
  const allProviders = ['qwen', 'openai', 'claude', 'gemini', 'zhipu', 'local']
  for (const name of allProviders) {
    if (!form.ai.providers[name]) {
      form.ai.providers[name] = {
        base_url: getProviderDefault(name, 'url'),
        api_key: '',
        model: getProviderDefault(name, 'model'),
      }
    }
  }
}

// ---- Whisper Local ----
const whisperLocal = reactive({
  ready: false, hasBinary: false, hasModel: false,
  binaryPath: '', modelPath: '', modelName: '', modelLabel: '',
  availableModels: [] as Array<{ value: string; label: string; sizeMB: number; downloaded: boolean }>,
})
const whisperSetupLoading = ref(false)
const whisperSetupProgress = ref(0)
const whisperSetupStage = ref('')

async function loadWhisperStatus() {
  try {
    const status = await ipc.invoke<any>('whisper:status')
    Object.assign(whisperLocal, status)
  } catch { /* ignore */ }
}

async function onAsrProviderChange(val: string) {
  try {
    await updateConfig({ asr: { ...form.asr, provider: val } })
  } catch { /* ignore */ }
}

async function handleWhisperSetup() {
  whisperSetupLoading.value = true
  whisperSetupProgress.value = 0
  whisperSetupStage.value = t('settings.whisperCompiling')
  try {
    const result = await ipc.invoke<any>('whisper:setup')
    if (result.success) {
      ElMessage.success(t('settings.whisperInstallOk'))
      await loadWhisperStatus()
    } else {
      ElMessage.error(result.error || t('common.failed'))
    }
  } catch (e: any) {
    ElMessage.error(e.message || t('common.failed'))
  } finally {
    whisperSetupLoading.value = false
  }
}

const downloadedModels = computed(() => {
  return whisperLocal.availableModels.filter(m => m.downloaded)
})

async function handleDeleteModel(modelName: string, label: string) {
  try {
    await ElMessageBox.confirm(
      `${t('settings.whisperDeleteConfirm')} ${label}`,
      { type: 'warning' },
    )
    const result = await ipc.invoke<any>('whisper:delete-model', modelName)
    if (result.success) {
      ElMessage.success(t('common.success'))
      await loadWhisperStatus()
    } else {
      ElMessage.error(result.error || t('common.failed'))
    }
  } catch { /* cancelled */ }
}

async function onWhisperModelChange(val: string) {
  form.whisperLocalModel = val
  // Save just the model selection immediately
  try {
    await updateConfig({ whisperLocalModel: val })
  } catch { /* ignore */ }
  // Reload status — model file may not exist for the new selection
  await loadWhisperStatus()
}

// Listen for download progress from main process
ipc.on('whisper:progress', (data: any) => {
  whisperSetupProgress.value = data.percent || 0
  if (data.stage === 'downloading_model') {
    whisperSetupStage.value = `${t('settings.whisperDownloading')} ${data.downloaded || 0}/${data.total || 0}MB`
  } else if (data.stage === 'compiling') {
    whisperSetupStage.value = t('settings.whisperCompiling')
  } else if (data.stage === 'cloning') {
    whisperSetupStage.value = t('settings.whisperCompiling')
  }
})

const whisperModels = [
  { value: 'whisper-large-v3-turbo', label: 'whisper-large-v3-turbo (Groq)' },
  { value: 'whisper-large-v3', label: 'whisper-large-v3 (Groq)' },
  { value: 'whisper-1', label: 'whisper-1 (OpenAI)' },
  { value: 'distil-whisper-large-v3-en', label: 'distil-whisper-large-v3-en (Groq)' },
]

function whisperModelSuggestions(query: string, cb: (results: any[]) => void) {
  const results = query
    ? whisperModels.filter(m => m.value.toLowerCase().includes(query.toLowerCase()))
    : whisperModels
  cb(results)
}

function getProviderDefault(name: string, field: string) {
  const urls: Record<string, string> = {
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    openai: 'https://api.openai.com/v1',
    claude: 'https://api.anthropic.com',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    local: 'http://localhost:11434/v1',
  }
  const models: Record<string, string> = {
    qwen: 'qwen-vl-max',
    openai: 'gpt-4o',
    claude: 'claude-sonnet-4-20250514',
    gemini: 'gemini-2.5-flash',
    zhipu: 'glm-4v-flash',
    local: 'llava',
  }
  if (field === 'url') return urls[name] || ''
  return models[name] || ''
}

function toggleSection(key: keyof typeof sections) {
  sections[key] = !sections[key]
  if (key === 'cache' && sections.cache && !cacheStats.value.temp) {
    loadCacheStats()
  }
}

function getProviderLabel(name: string) {
  const key = `settings.provider${name.charAt(0).toUpperCase() + name.slice(1)}`
  const label = t(key)
  return label !== key ? label : name
}

// Track which providers have a key configured on the server (but masked)
const maskedProviders = ref<Set<string>>(new Set())

onMounted(async () => {
  loadWhisperStatus()
  try {
    const data = await getAllConfig()
    if (data.ai) {
      form.ai.active_provider = data.ai.active_provider || 'qwen'
      form.ai.providers = data.ai.providers || {}
      if (data.ai.whisper) {
        form.ai.whisper = {
          enabled: data.ai.whisper.enabled || false,
          base_url: data.ai.whisper.base_url || '',
          api_key: data.ai.whisper.api_key || '',
          model: data.ai.whisper.model || 'whisper-large-v3-turbo',
        }
        if (form.ai.whisper.api_key && form.ai.whisper.api_key.includes('****')) {
          form.ai.whisper.api_key = ''
        }
      }
      // Clear masked keys from form
      for (const [name, provider] of Object.entries(form.ai.providers)) {
        const p = provider as { api_key?: string }
        if (p.api_key && p.api_key.includes('****')) {
          maskedProviders.value.add(name)
          p.api_key = ''
        }
      }
    }
    if (data.slice) {
      Object.assign(form.slice, data.slice)
    }
    if (data.live) {
      form.live.analysis_interval = data.live.analysis_interval ?? 1
      form.live.custom_keywords = data.live.custom_keywords ?? {}
    }
    if (data.publish) {
      form.publish.auto_publish = data.publish.auto_publish ?? false
      form.publish.auto_publish_threshold = data.publish.auto_publish_threshold ?? 0.8
      form.publish.default_platforms = data.publish.default_platforms ?? []
      form.publish.show_publish_window = data.publish.show_publish_window ?? false
      form.publish.default_description = data.publish.default_description ?? ''
      form.publish.default_tags = data.publish.default_tags ?? ['直播切片', '精彩时刻']
    }
    if (data.asr) {
      form.asr.provider = data.asr.provider || 'whisper-local'
      if (data.asr.paraformer) Object.assign(form.asr.paraformer, data.asr.paraformer)
      if (data.asr.volcengine) Object.assign(form.asr.volcengine, data.asr.volcengine)
    }
    if (data.whisperLocalModel) {
      form.whisperLocalModel = data.whisperLocalModel
    }
    ensureAllProviders()
    originalJson.value = JSON.stringify(form)
  } catch {
    ElMessage.error(t('settings.configLoadFailed'))
  } finally {
    loadingConfig.value = false
  }
  // Load publish platforms for dropdown
  try {
    publishPlatforms.value = await getPlatforms()
  } catch { /* ignore */ }
  // Load all platforms for login section
  try {
    availablePlatforms.value = await ipc.invoke<PlatformItem[]>('platforms:list')
    await loadAuthStatuses()
  } catch { /* ignore */ }
})

function resetAll() {
  const original = JSON.parse(originalJson.value)
  Object.assign(form.ai, original.ai)
  Object.assign(form.slice, original.slice)
  Object.assign(form.live, original.live)
  Object.assign(form.publish, original.publish)
  ElMessage.info(t('settings.resetDone'))
}

async function saveAll() {
  if (form.slice.min_duration >= form.slice.max_duration) {
    ElMessage.error(t('settings.durationErrorMinMax'))
    return
  }
  saving.value = true
  try {
    // Auto-derive thresholds from burst_threshold
    const bt = form.slice.burst_threshold
    form.slice.heating_threshold = Math.round(Math.max(0.15, bt * 0.6) * 20) / 20
    // Sync auto-publish threshold with burst threshold
    form.publish.auto_publish_threshold = bt

    await updateConfig({
      ai: form.ai,
      slice: form.slice,
      live: form.live,
      publish: form.publish,
      asr: form.asr,
      whisperLocalModel: form.whisperLocalModel,
    })
    originalJson.value = JSON.stringify(form)
    ElMessage.success(t('settings.configSaved'))
  } catch {
    ElMessage.error(t('settings.configSaveFailed'))
  } finally {
    saving.value = false
  }
}

// ========== Cache Management ==========
async function loadCacheStats() {
  cacheLoading.value = true
  try {
    cacheStats.value = await getCacheStats()
  } catch {
    cacheStats.value = {}
  } finally {
    cacheLoading.value = false
  }
}

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i]
}

const activeStatuses = new Set(['starting', 'recording', 'running', 'processing'])
function isActiveStatus(status: string) { return activeStatuses.has(status) }

async function handleClearTaskSlices(taskId: string) {
  try {
    await ElMessageBox.confirm(t('settings.clearSlicesConfirm'), t('settings.clearSlicesTitle'), { type: 'warning' })
    clearing.value = true
    const result = await clearTaskSlices(taskId)
    ElMessage.success(t('settings.clearSuccess', { size: formatBytes(result.freed || 0) }))
    await loadCacheStats()
  } catch (e: any) {
    if (e !== 'cancel' && e?.toString() !== 'cancel') ElMessage.error(t('settings.clearFailed'))
  } finally { clearing.value = false }
}

async function handleClearFinishedSlices() {
  try {
    await ElMessageBox.confirm(t('settings.clearSlicesConfirm'), t('settings.clearSlicesTitle'), { type: 'warning' })
    clearing.value = true
    const result = await clearFinishedSlices()
    ElMessage.success(t('settings.clearSuccess', { size: formatBytes(result.freed || 0) }))
    await loadCacheStats()
  } catch (e: any) {
    if (e !== 'cancel' && e?.toString() !== 'cancel') ElMessage.error(t('settings.clearFailed'))
  } finally { clearing.value = false }
}

async function handleClear(target: string) {
  try {
    await ElMessageBox.confirm(
      t('settings.clearConfirmDesc'),
      t('settings.clearConfirm'),
      { type: 'warning', confirmButtonText: t('settings.clearSpecific'), cancelButtonText: t('settings.discard') }
    )
    clearing.value = true
    const result = await clearCache(target, true)
    ElMessage.success(t('settings.clearSuccess', { size: formatBytes(result.freed || 0) }))
    await loadCacheStats()
  } catch (e: any) {
    if (e !== 'cancel' && e?.toString() !== 'cancel') {
      ElMessage.error(t('settings.clearFailed'))
    }
  } finally {
    clearing.value = false
  }
}

function handleFullCleanup() {
  fullCleanupMode.value = true
  confirmFullCleanup.value = false
}

async function confirmFullCleanupAction() {
  try {
    clearing.value = true
    // 1. 清理应用缓存（所有内容）
    const result = await clearCache('all', false)
    ElMessage.success(t('settings.clearSuccess', { size: formatBytes(result.freed || 0) }))
    await loadCacheStats()
    fullCleanupMode.value = false
    confirmFullCleanup.value = false
    ElMessage.info('应用已完全清理。部分功能需要重新配置。')
  } catch (e: any) {
    if (e !== 'cancel' && e?.toString() !== 'cancel') {
      ElMessage.error(t('settings.clearFailed'))
    }
  } finally {
    clearing.value = false
  }
}

</script>

<style scoped>
.settings-page {
  max-width: 960px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 24px;
}

.page-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.page-desc {
  font-size: 14px;
  color: var(--text-secondary);
}

/* Floating save bar */
.floating-save-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
  padding: 12px 24px;
  background: rgba(30, 30, 30, 0.85);
  backdrop-filter: blur(16px);
  border-top: 1px solid rgba(245, 158, 11, 0.3);
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.3);
}

.floating-save-content {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.floating-save-content > .el-icon {
  font-size: 18px;
  color: var(--status-warning);
}

.floating-save-content > span {
  flex: 1;
  font-weight: 500;
  color: var(--status-warning);
  font-size: 14px;
}

.floating-save-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

.float-up-enter-active {
  transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.3s ease;
}
.float-up-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.float-up-enter-from,
.float-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

/* Config card */
.config-card {
  margin-bottom: 16px;
  overflow: hidden;
  border-left: 3px solid transparent;
  transition: box-shadow 0.3s ease, border-left-color 0.3s ease, border-color 0.3s ease;
}

/* 卡片左侧线条颜色与图标保持一致 */
.config-card:nth-child(1) { border-left-color: var(--accent); } /* AI Config */
.config-card:nth-child(2) { border-left-color: #0ea5e9; } /* ASR Config */
.config-card:nth-child(3) { border-left-color: #3b82f6; } /* Slice Config */
.config-card:nth-child(4) { border-left-color: #ec4899; } /* Publish Config */
.config-card:nth-child(5) { border-left-color: #10b981; } /* Platform Auth */
.config-card:nth-child(6) { border-left-color: #f59e0b; } /* Cache Management */
.config-card:nth-child(7) { border-left-color: #8b5cf6; } /* Language */

.config-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.config-card-header:hover {
  background: rgba(255, 255, 255, 0.03);
}

.config-header-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.config-icon-wrap {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

.config-card:hover .config-icon-wrap {
  transform: translateY(-3px) rotate(2deg) scale(1.05);
  animation: float 2s ease-in-out infinite;
}

@keyframes float {
  0%, 100% {
    transform: translateY(-3px) rotate(2deg) scale(1.05);
  }
  50% {
    transform: translateY(-6px) rotate(-2deg) scale(1.05);
  }
}

.lang-icon { background: linear-gradient(135deg, #8b5cf6, #a78bfa); }
.ai-icon { background: var(--accent); box-shadow: 0 2px 12px rgba(240, 86, 56, 0.4); }
.whisper-icon { background: linear-gradient(135deg, #0ea5e9, #38bdf8); box-shadow: 0 2px 12px rgba(14, 165, 233, 0.4); }

.whisper-local-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.whisper-local-info {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 6px;
  font-family: monospace;
}
.publish-icon { background: linear-gradient(135deg, #ec4899, #f472b6); }
.slice-icon { background: linear-gradient(135deg, #3b82f6, #60a5fa); }
.cache-icon { background: linear-gradient(135deg, #f59e0b, #fbbf24); }
.platform-auth-icon { background: linear-gradient(135deg, #10b981, #34d399); }

.ai-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-sparkle {
  color: var(--accent);
  font-size: 14px;
  animation: sparkle 2s ease-in-out infinite;
}

@keyframes sparkle {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

.ai-badge {
  background: var(--accent) !important;
  border: none !important;
  font-size: 10px !important;
  font-weight: 700 !important;
  letter-spacing: 1px;
  padding: 0 8px !important;
}

.config-header-text h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.config-subtitle {
  font-size: 12px;
  color: var(--text-tertiary);
}

.collapse-arrow {
  font-size: 16px;
  color: var(--text-tertiary);
  transition: transform 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55);
}

.collapse-arrow.rotated {
  transform: rotate(180deg);
}

.config-body {
  padding: 4px 24px 24px;
  border-top: 1px solid var(--glass-border);
}

.config-form {
  padding-top: 16px;
}

/* Provider section */
.provider-section {
  padding: 16px 20px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
  border: 1px solid var(--glass-border);
  transition: border-color 0.2s ease;
}

.provider-section:hover {
  border-color: rgba(255, 255, 255, 0.15);
}

.provider-section.active-provider {
  border-color: var(--accent);
  background: var(--accent-subtle);
  position: relative;
  overflow: hidden;
}

.provider-section.active-provider::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.05), transparent);
  animation: shimmer 3s ease-in-out infinite;
}

@keyframes shimmer {
  0% { left: -100%; }
  50%, 100% { left: 100%; }
}

.provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.provider-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

/* Weights */
.sub-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.sub-desc {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 16px;
}

.form-help {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
}

.threshold-sync-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}

.threshold-sync-hint .form-help {
  margin-top: 0;
  font-size: 12px;
  font-weight: 400;
}

/* Publish auth hint */
.publish-auth-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(59, 130, 246, 0.06);
  border: 1px solid rgba(59, 130, 246, 0.12);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--accent);
  line-height: 1.5;
}

.publish-platform-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: 16px;
  transition: all 0.3s ease;
  min-height: 200px;
  display: flex;
  flex-direction: column;
}

.publish-platform-card:hover {
  border-color: rgba(240, 86, 56, 0.2);
}

.publish-platform-card.is-logged-in {
  border-color: rgba(34, 197, 94, 0.25);
  background: rgba(34, 197, 94, 0.03);
}

.publish-platform-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.publish-platform-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  text-transform: capitalize;
}

/* QR Login Area */
.qr-login-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.qr-login-trigger {
  text-align: center;
  padding: 20px 0;
}

.qr-logged-in {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
}

.qr-logged-text {
  font-size: 14px;
  font-weight: 500;
  color: var(--status-success);
}

.qr-code-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.qr-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.publish-no-platform-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding: 8px 12px;
  background: rgba(245, 158, 11, 0.06);
  border: 1px solid rgba(245, 158, 11, 0.15);
  border-radius: var(--radius-md);
  font-size: 12px;
  color: var(--status-warning);
}

/* Duration validation warning */
.duration-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: var(--radius-sm);
  color: var(--status-danger);
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 16px;
  animation: shake 0.5s ease;
}

/* Animations */
.animate-in {
  animation: card-in 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  animation-delay: calc(var(--delay) * 0.1s);
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(30px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes shake {
  0%, 100% { transform: translateX(0) rotate(0deg); }
  10% { transform: translateX(-6px) rotate(-1deg); }
  20% { transform: translateX(6px) rotate(1deg); }
  30% { transform: translateX(-6px) rotate(-1deg); }
  40% { transform: translateX(6px) rotate(1deg); }
  50% { transform: translateX(-4px) rotate(-0.5deg); }
  60% { transform: translateX(4px) rotate(0.5deg); }
  70% { transform: translateX(-2px) rotate(-0.25deg); }
  80% { transform: translateX(2px) rotate(0.25deg); }
  90% { transform: translateX(-1px) rotate(0deg); }
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.3s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* ========== Cache Management ========== */
.cache-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-secondary);
  font-size: 14px;
}

.cache-overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.cache-stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
}

.cache-stat-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
}

.temp-bg { background: linear-gradient(135deg, #fa8c16, #ffa940); }
.cache-bg { background: linear-gradient(135deg, #722ed1, #9254de); }
.output-bg { background: linear-gradient(135deg, #52c41a, #73d13d); }

.cache-stat-info {
  flex: 1;
  min-width: 0;
}

.cache-stat-label {
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: 600;
  letter-spacing: 0.3px;
  white-space: nowrap;
}

.cache-stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.3;
}

.cache-stat-desc {
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.task-dirs-section {
  margin-top: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--glass-border);
}

.task-dir-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task-dir-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--radius-sm);
  border: 1px solid var(--glass-border);
  transition: background 0.15s;
}

.task-dir-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.task-dir-info {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}

.task-dir-name {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 8px;
  border-radius: 4px;
}

.task-dir-size {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.task-dir-count {
  font-size: 12px;
  color: var(--text-tertiary);
}

.slice-task-title {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub-title-desc {
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: 400;
}

.no-data-hint {
  font-size: 13px;
  color: var(--text-tertiary);
  padding: 12px 0;
  text-align: center;
}

.slice-batch-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}

.cache-actions-section {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--glass-border);
}

.cache-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.full-cleanup-actions {
  margin-top: 12px;
  padding: 12px;
  background: rgba(239, 68, 68, 0.05);
  border-radius: var(--radius-md);
  border: 1px solid rgba(239, 68, 68, 0.2);
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.full-cleanup-buttons {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

</style>
