import https from 'https'
import http from 'http'
import { URL } from 'url'
import { readFileSync, existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { getConfig } from './config'
import { getFFmpegPath, detectSpeechSegments } from './ffmpeg'
import { isWhisperLocalReady, transcribeLocal } from './whisper-local'
import { getLogger } from './utils/logger'
import { mt } from './i18n'

const logger = getLogger('ai-client')

interface ProviderConfig {
  base_url: string
  api_key: string
  model: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

/**
 * Get the active AI provider config from the multi-provider settings.
 */
function getProviderConfig(): ProviderConfig | null {
  const config = getConfig() as any
  const ai = config.ai || {}

  // New multi-provider format: ai.active_provider + ai.providers
  if (ai.providers && ai.active_provider) {
    const provider = ai.providers[ai.active_provider]
    if (provider?.api_key) return provider
  }

  // Legacy format: ai.api_key + ai.base_url + ai.model
  if (ai.api_key) {
    return {
      base_url: ai.base_url || 'https://api.openai.com/v1',
      api_key: ai.api_key,
      model: ai.model || 'gpt-4o-mini',
    }
  }

  return null
}

/**
 * Check if AI is configured and ready.
 */
export function isAiConfigured(): boolean {
  return getProviderConfig() !== null
}

/**
 * Call the configured LLM (OpenAI-compatible API).
 */
async function chatCompletion(
  messages: ChatMessage[],
  options?: { temperature?: number; max_tokens?: number }
): Promise<string> {
  const provider = getProviderConfig()
  if (!provider) throw new Error('AI not configured')

  const baseUrl = provider.base_url.replace(/\/+$/, '')
  const url = `${baseUrl}/chat/completions`

  const body = JSON.stringify({
    model: provider.model,
    messages,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.max_tokens ?? 1024,
  })

  logger.info(`AI request: model=${provider.model}, url=${url}`)

  let result: string
  try {
    result = await httpPost(url, body, {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.api_key}`,
    })
  } catch (e: any) {
    throw new Error(mt('error.aiRequestFailed', { model: provider.model, message: e.message }))
  }

  let json: any
  try {
    json = JSON.parse(result)
  } catch {
    throw new Error(mt('error.aiNonJson', { detail: result.slice(0, 200) }))
  }

  if (json.error) {
    const errMsg = json.error.message || JSON.stringify(json.error)
    throw new Error(mt('error.aiApiError', { model: provider.model, message: errMsg }))
  }
  const content = json.choices?.[0]?.message?.content || ''
  if (!content) {
    throw new Error(mt('error.aiEmptyContent', { detail: JSON.stringify(json).slice(0, 200) }))
  }
  logger.info(`AI response: ${content.slice(0, 150)}`)
  return content
}

// ──────────────────────────────────────────────
// Highlight detection (called during heating state)
// ──────────────────────────────────────────────

export interface AiDetectionResult {
  frameScore: number    // 0-1, visual excitement from frame analysis
  textScore: number     // 0-1, semantic excitement from danmaku analysis
  reason: string        // brief AI reasoning
}

/**
 * Analyze a video frame for visual excitement (vision model).
 * Returns a 0-1 score. Called only in heating state to save tokens.
 */
export async function analyzeFrame(framePath: string): Promise<{ score: number; reason: string }> {
  if (!isAiConfigured()) throw new Error(mt('error.aiNotConfigured'))

  const provider = getProviderConfig()!
  logger.info(`analyzeFrame: model=${provider.model}, base_url=${provider.base_url}`)

  const dataUrl = imageToDataUrl(framePath)

  const response = await chatCompletion(
    [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `你是直播内容分析AI。分析这张直播截图的精彩程度。

评判标准:
- 画面是否有明显的高潮/精彩时刻(动作场面、表情反应、舞台效果、比赛关键时刻等)
- 弹幕/礼物特效是否密集(说明观众很兴奋)
- 画面构图是否适合做短视频封面
- 画面是否清晰(非模糊/过曝/黑屏)

请严格按JSON格式回复(不要输出其他内容):
{"score": 0.0到1.0的数字, "reason": "一句话说明原因"}`,
        },
        {
          type: 'image_url',
          image_url: { url: dataUrl },
        },
      ],
    }],
    { temperature: 0.3, max_tokens: 100 },
  )

  const parsed = extractJson(response)
  const score = Math.max(0, Math.min(1, Number(parsed.score) || 0))
  logger.info(`AI frame analysis: score=${score.toFixed(2)}, reason=${parsed.reason || ''}`)
  return { score, reason: parsed.reason || '' }
}

/**
 * Analyze danmaku messages for semantic excitement (text model).
 * Returns a 0-1 score. Called only in heating state to save tokens.
 */
export async function analyzeDanmakuSemantic(
  messages: string[],
): Promise<{ score: number; reason: string }> {
  if (!isAiConfigured()) throw new Error(mt('error.aiNotConfigured'))
  if (messages.length === 0) throw new Error(mt('error.noDanmaku'))

  const provider = getProviderConfig()!
  logger.info(`analyzeDanmakuSemantic: model=${provider.model}, messages=${messages.length}`)

  const sample = messages.slice(-30).join('\n')

  const response = await chatCompletion(
    [{
      role: 'user',
      content: `你是直播弹幕分析AI。分析以下弹幕消息的整体兴奋程度。

弹幕消息(最近30条):
${sample}

评判标准:
- 观众是否在集体兴奋/惊叹/欢呼
- 是否有大量重复的兴奋表达(说明集体高潮)
- 弹幕内容是否表明正在发生精彩/意外/搞笑/感动的事
- 综合判断这个时刻是否值得切片保存

请严格按JSON格式回复(不要输出其他内容):
{"score": 0.0到1.0的数字, "reason": "一句话说明弹幕反映了什么"}`,
    }],
    { temperature: 0.3, max_tokens: 100 },
  )

  const parsed = extractJson(response)
  const score = Math.max(0, Math.min(1, Number(parsed.score) || 0))
  logger.info(`AI danmaku analysis: score=${score.toFixed(2)}, reason=${parsed.reason || ''}`)
  return { score, reason: parsed.reason || '' }
}

// ──────────────────────────────────────────────
// AI-driven slice boundary optimization
// ──────────────────────────────────────────────

export interface SliceBoundary {
  startOffset: number   // recommended start (seconds from recording start)
  endOffset: number     // recommended end
  reason: string        // why these boundaries were chosen
}

/**
 * Use AI to determine optimal slice boundaries for content completeness.
 * The AI analyzes danmaku timeline to find natural start/end points
 * (e.g. start of a play, end of a reaction) within the allowed duration range.
 */
export async function optimizeSliceBoundary(
  burst: { startTime: number; endTime: number; peakScore: number },
  danmaku: Array<{ text: string; userName: string; timestamp: number; type: string }>,
  opts: {
    minDuration: number
    maxDuration: number
    preBuffer: number
    postBuffer: number
    liveTitle: string
    recordingElapsed: number
  },
): Promise<SliceBoundary | null> {
  if (!isAiConfigured()) return null

  // Build a timestamped danmaku timeline for AI context
  // Convert absolute timestamps to relative seconds from a reference point
  const burstMid = (burst.startTime + burst.endTime) / 2
  const windowStart = Math.max(0, burstMid - opts.maxDuration)
  const windowEnd = Math.min(opts.recordingElapsed, burstMid + opts.maxDuration)

  // Filter danmaku within the analysis window and convert to relative time strings
  const refTime = danmaku.length > 0 ? Math.min(...danmaku.map(m => m.timestamp)) : Date.now()
  const timeline = danmaku
    .filter(m => m.text && m.type === 'chat')
    .slice(-60) // last 60 messages for context
    .map(m => {
      const relSec = (m.timestamp - refTime) / 1000
      const mm = Math.floor(relSec / 60)
      const ss = Math.floor(relSec % 60)
      return `[${mm}:${String(ss).padStart(2, '0')}] ${m.userName}: ${m.text}`
    })
    .join('\n')

  if (!timeline) return null

  const burstDuration = burst.endTime - burst.startTime

  try {
    const response = await chatCompletion(
      [{
        role: 'user',
        content: `你是直播切片编辑专家。根据弹幕时间线，为这个高光片段确定最佳的切片起止时间。

直播标题: ${opts.liveTitle || '直播'}
高能时段: ${burst.startTime.toFixed(0)}s ~ ${burst.endTime.toFixed(0)}s (峰值 ${Math.round(burst.peakScore * 100)}%)
录制已进行: ${opts.recordingElapsed.toFixed(0)}s

弹幕时间线:
${timeline}

要求:
- 切片必须包含完整的事件（有铺垫、有高潮、有结尾/反应）
- 不要在说话/事件进行到一半时切断
- 时长必须在 ${opts.minDuration}秒 ~ ${opts.maxDuration}秒 之间
- 高能时段 (${burst.startTime.toFixed(0)}s~${burst.endTime.toFixed(0)}s) 必须包含在内
- 从弹幕推断：事件是什么时候自然开始的？观众反应是什么时候结束的？
- 宁可多留几秒让内容完整，也不要为了短而截断

请严格按JSON格式回复:
{"start": 起始秒数, "end": 结束秒数, "reason": "一句话说明为什么选这个范围"}`,
      }],
      { temperature: 0.3, max_tokens: 100 },
    )

    const parsed = extractJson(response)

    let start = Number(parsed.start)
    let end = Number(parsed.end)

    if (isNaN(start) || isNaN(end) || end <= start) {
      logger.warn(`AI boundary invalid: start=${parsed.start}, end=${parsed.end}`)
      return null
    }

    // Enforce constraints
    start = Math.max(0, start)
    end = Math.min(opts.recordingElapsed, end)

    // Must contain the burst window
    start = Math.min(start, burst.startTime)
    end = Math.max(end, burst.endTime)

    // Clamp to min/max duration
    let dur = end - start
    if (dur < opts.minDuration) {
      // Expand symmetrically, then compensate if start hits 0
      const deficit = opts.minDuration - dur
      start = Math.max(0, start - deficit / 2)
      end = start + opts.minDuration
      // Don't exceed recording length
      if (end > opts.recordingElapsed) {
        end = opts.recordingElapsed
        start = Math.max(0, end - opts.minDuration)
      }
      dur = end - start
    }
    if (dur > opts.maxDuration) {
      // Keep centered on burst peak
      const center = (burst.startTime + burst.endTime) / 2
      start = Math.max(0, center - opts.maxDuration / 2)
      end = start + opts.maxDuration
      dur = opts.maxDuration
    }

    logger.info(`AI optimized boundary: ${start.toFixed(1)}s ~ ${end.toFixed(1)}s (${dur.toFixed(1)}s) — ${parsed.reason}`)
    return { startOffset: start, endOffset: end, reason: parsed.reason || '' }
  } catch (e: any) {
    logger.warn(`AI boundary optimization failed: ${e.message}`)
    return null
  }
}

// ──────────────────────────────────────────────
// Content profile auto-detection
// ──────────────────────────────────────────────
// Public API: title, description, cover selection
// ──────────────────────────────────────────────

export interface SliceContext {
  platform: string
  streamerName: string
  liveTitle: string
  danmakuTexts: string[]       // danmaku messages during burst
  giftNames: string[]          // gift names during burst
  clipDuration: number          // seconds
  peakScore: number             // 0-1
  /** Optional video frame paths for visual context in content generation */
  framePaths?: string[]
  /** ASR transcript text (what the streamer/people actually said) */
  transcript?: string
}

export interface SliceContentResult {
  title: string
  description: string
  coverText: string          // short hook text for cover overlay
  candidateTitles: string[]
  tags: string[]             // AI-generated tags for publishing
  aiApproved: boolean | null  // null = AI not configured
  aiReviewReason: string      // why AI approved/rejected
}

/**
 * Generate title, description, and cover text for a slice using AI.
 * coverText is a short hook/teaser specifically designed for the cover image overlay.
 */
export async function generateSliceContent(ctx: SliceContext): Promise<SliceContentResult> {
  if (!isAiConfigured()) {
    return fallbackContent(ctx)
  }

  const danmakuSample = ctx.danmakuTexts.slice(0, 20).join('、')
  const giftSample = ctx.giftNames.length > 0 ? `\n礼物: ${[...new Set(ctx.giftNames)].join('、')}` : ''
  const hasFrames = ctx.framePaths && ctx.framePaths.length > 0
  const hasTranscript = ctx.transcript && ctx.transcript.trim().length > 10
  const streamerInfo = ctx.streamerName ? `主播: ${ctx.streamerName}` : ''
  const liveTitleInfo = ctx.liveTitle ? `直播标题: ${ctx.liveTitle}` : ''

  const prompt = `你是专业抖音短视频运营助手，擅长爆款标题和文案。
请根据我提供的视频内容，生成符合抖音平台风格的标题、封面文案和视频描述。

## 视频信息
${streamerInfo}
${liveTitleInfo}
- 片段时长: ${Math.floor(ctx.clipDuration)}秒
- 弹幕热度: ${Math.round(ctx.peakScore * 100)}%
${hasTranscript ? `\n## 语音转录（主播/视频中说的话）\n${ctx.transcript!.slice(0, 500)}` : ''}
- 弹幕内容: ${danmakuSample || '(无弹幕)'}${giftSample}
${hasFrames ? '\n以下是该片段的关键帧截图，请仔细观察画面中正在发生什么（人物表情、动作、场景、文字等）。' : ''}

## 只输出JSON，不要输出任何其他内容
\`\`\`json
{
  "titles": ["标题1", "标题2", "标题3"],
  "cover_text": "封面文案",
  "description": "视频描述/文案",
  "tags": ["标签1", "标签2", "标签3", "标签4", "标签5"],
  "approved": true,
  "review_reason": "一句话说明为什么值得/不值得保留"
}
\`\`\`

## 核心原则
- 弹幕只是帮你推断视频里发生了什么的线索，最终输出面向没看过直播的普通观众
- 风格贴合抖音用户习惯，不生硬、不广告化
- 有吸引力、有悬念、有情绪或有价值，适合上热门

## 标题要求（titles）
- 5-20字，3个备选，带1-2个合适的表情符号（🔥😱💀🤣😂❤️等）
- 有悬念感、情绪张力，让人忍不住点进来
- 口语化、接地气，像在给朋友安利一个视频
- 抓住视频中最戏剧性的一个瞬间或反转

### 好标题示例：
- "他说这把稳了的时候，我就知道要完😂"
- "这操作我看了三遍都没看懂🔥"
- "开局就送，结局谁都没想到💀"
- "全场最佳就这一波，太顶了😱"

### 绝对禁止：
- ❌ 提及"弹幕""直播间""观众刷屏"等元素
- ❌ 标题党套路："震惊""万万没想到""竟然""不转不是中国人"
- ❌ 超过20字的长标题

## 封面文案（cover_text）
- 3-8个字，叠加在封面图上的大字
- 制造好奇心，让人想点进来
- 可以是疑问句、感叹句、或反转暗示
- ⚠️ 禁止使用emoji表情符号（封面渲染不支持emoji）
- 好的例子："这也能赢？" "教科书操作" "反转来了" "绷不住了"

## 描述/文案（description）
- 30-100字，口语化、易共鸣
- 第一句用一句话概括最吸引人的看点
- 中间补充有趣细节，制造代入感
- 结尾引导互动（提问、引导点赞/评论/收藏/关注本账号）
- 引导关注时说"关注我"或"点个关注"，不要说"关注主播"
- 示例结尾："你们觉得这波操作几分？" "有同款经历的扣1" "点个关注不迷路❤️"

## 标签（tags）
- 3-5个精准抖音热门标签，纯文字不加#
- 结合视频内容 + 热门话题
- 必须包含主播名/游戏名等具体关键词
- 示例：["直播切片", "${ctx.streamerName || '主播'}", "游戏名", "搞笑", "高光时刻"]

## 审核（approved）
- true: 有明确事件/操作/搞笑/感人/震撼内容，适合短视频传播
- false: 纯日常闲聊、无明确看点、画面模糊无意义`

  try {
    logger.info(`Generating AI content: danmaku=${ctx.danmakuTexts.length}, frames=${ctx.framePaths?.length || 0}, duration=${ctx.clipDuration.toFixed(0)}s`)

    // Build message content — include video frames if available for visual context
    let messageContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>

    if (hasFrames) {
      const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
      parts.push({ type: 'text', text: prompt })
      for (const framePath of ctx.framePaths!) {
        try {
          const dataUrl = imageToDataUrl(framePath)
          parts.push({ type: 'image_url', image_url: { url: dataUrl } })
        } catch { /* skip unreadable frames */ }
      }
      messageContent = parts
    } else {
      messageContent = prompt
    }

    const content = await chatCompletion(
      [{ role: 'user', content: messageContent }],
      { temperature: 0.8, max_tokens: 1024 },
    )

    // Parse JSON from response — models often add extra text, markdown, or thinking
    const parsed = extractJson(content)

    const titles: string[] = (parsed.titles || []).filter((t: string) => t && t.length > 0)
    const description: string = parsed.description || ''
    const coverText: string = parsed.cover_text || ''
    const tags: string[] = (parsed.tags || []).filter((t: string) => t && t.length > 0)
    // Default approved=true when AI successfully generates content.
    // The AI was able to analyze the clip and produce a title — that implies
    // the content has value. Only explicit approved=false should block.
    const aiApproved: boolean | null = parsed.approved === false ? false : true
    const aiReviewReason: string = parsed.review_reason || ''

    if (titles.length === 0) {
      logger.warn('AI returned empty titles, using fallback')
      return fallbackContent(ctx)
    }

    logger.info(`AI generated title: "${titles[0]}", cover: "${coverText}", tags: [${tags.join(', ')}], approved=${aiApproved}, reason="${aiReviewReason}", desc: "${description.slice(0, 50)}..."`)

    // Validate cover_text: strip emoji (cover rendering doesn't support them) and trim
    let finalCoverText = coverText || ''
    finalCoverText = stripEmoji(finalCoverText)
    finalCoverText = finalCoverText.replace(/[？?！!。，,…]+$/, '').trim()
    if (finalCoverText.length > 10) {
      finalCoverText = finalCoverText.slice(0, 8)
    }
    if (!finalCoverText || finalCoverText.length < 2) {
      // Extract a short phrase from the title (strip emoji + punctuation)
      const titleClean = stripEmoji(titles[0]).replace(/[？?！!。，,…""]+/g, '')
      finalCoverText = titleClean.slice(0, 6)
    }

    return {
      title: titles[0],
      description,
      coverText: finalCoverText,
      candidateTitles: titles,
      tags,
      aiApproved,
      aiReviewReason,
    }
  } catch (e: any) {
    logger.warn(`AI content generation failed: ${e.message}`)
    const fb = fallbackContent(ctx)
    // AI was configured but failed — auto-approve with fallback content
    // so slices don't pile up as "待审核"
    fb.aiApproved = true
    fb.aiReviewReason = `AI调用失败，自动通过: ${e.message.slice(0, 80)}`
    return fb
  }
}

/**
 * Use AI vision to select the best cover frame from candidates.
 * candidateFrames: array of local image file paths.
 * Returns the index of the best frame (0-based).
 */
export async function selectBestCover(
  candidateFrames: string[],
  ctx: SliceContext,
): Promise<number> {
  if (!isAiConfigured() || candidateFrames.length <= 1) {
    return 0
  }

  try {
    const imageContents: Array<{ type: string; text?: string; image_url?: { url: string } }> = []

    imageContents.push({
      type: 'text',
      text: `你是短视频封面选择专家。以下是一个视频高光片段中提取的${candidateFrames.length}张候选封面截图。
请选择最适合作为短视频封面的一张，要求：画面清晰、有视觉冲击力、能吸引点击。
只回复数字(1-${candidateFrames.length})，代表你选择的图片编号。`,
    })

    for (let i = 0; i < candidateFrames.length; i++) {
      try {
        const dataUrl = imageToDataUrl(candidateFrames[i])
        imageContents.push({
          type: 'text',
          text: `图片 ${i + 1}:`,
        })
        imageContents.push({
          type: 'image_url',
          image_url: { url: dataUrl },
        })
      } catch {
        // Skip unreadable images
      }
    }

    const response = await chatCompletion(
      [{ role: 'user', content: imageContents }],
      { temperature: 0.3, max_tokens: 10 },
    )

    const match = response.match(/(\d+)/)
    if (match) {
      const idx = parseInt(match[1], 10) - 1
      if (idx >= 0 && idx < candidateFrames.length) {
        logger.info(`AI selected cover frame #${idx + 1}`)
        return idx
      }
    }
  } catch (e: any) {
    logger.warn(`AI cover selection failed: ${e.message}`)
  }

  // Default: return middle frame
  return Math.floor(candidateFrames.length / 2)
}

/**
 * Robustly extract a JSON object from AI model output.
 * Handles: markdown code blocks, trailing text/comments, control characters,
 * thinking tags, and other non-JSON content that models commonly add.
 */
function extractJson(raw: string): any {
  // Strip markdown code fences
  let text = raw.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim()

  // Strip thinking tags (some models wrap output in <think>...</think>)
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

  // Remove control characters (except \n \r \t) that break JSON.parse
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')

  // Try direct parse first
  try { return JSON.parse(text) } catch { /* continue */ }

  // Find the first { and match to its closing }
  const start = text.indexOf('{')
  if (start === -1) throw new Error('No JSON object found in AI response')

  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1)
        try { return JSON.parse(jsonStr) } catch { /* continue scanning */ }
      }
    }
  }

  // Last resort: try to fix common issues and parse again
  const lastBrace = text.lastIndexOf('}')
  if (lastBrace > start) {
    const candidate = text.slice(start, lastBrace + 1)
    try { return JSON.parse(candidate) } catch { /* give up */ }
  }

  // Try to repair truncated JSON (common when max_tokens cuts off the response)
  try {
    let truncated = text.slice(start)
    // Close any open strings
    const quoteCount = (truncated.match(/(?<!\\)"/g) || []).length
    if (quoteCount % 2 !== 0) truncated += '"'
    // Close open arrays and objects
    const openBrackets = (truncated.match(/\[/g) || []).length - (truncated.match(/\]/g) || []).length
    const openBraces = (truncated.match(/\{/g) || []).length - (truncated.match(/\}/g) || []).length
    // Remove trailing comma
    truncated = truncated.replace(/,\s*$/, '')
    for (let i = 0; i < openBrackets; i++) truncated += ']'
    for (let i = 0; i < openBraces; i++) truncated += '}'
    return JSON.parse(truncated)
  } catch { /* give up */ }

  throw new Error(`Failed to parse JSON from AI response: ${text.slice(0, 200)}`)
}

/** Strip emoji characters from text (for cover rendering which doesn't support emoji) */
function stripEmoji(text: string): string {
  return text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{200D}\u{20E3}]/gu, '').trim()
}

/** Auto-incrementing counter to ensure unique fallback titles across slices in the same session */
let fallbackCounter = 0

function fallbackContent(ctx: SliceContext): SliceContentResult {
  fallbackCounter++

  const streamer = ctx.streamerName || '主播'
  const hasTranscript = ctx.transcript && ctx.transcript.trim().length > 5
  // Extract a short phrase from transcript for title context
  const transcriptSnippet = hasTranscript
    ? ctx.transcript!.trim().replace(/[，。！？、\s]+/g, ' ').slice(0, 20).trim()
    : ''

  // Title templates — Douyin style, engaging with emoji
  const templates = hasTranscript
    ? [
        () => `${streamer}："${transcriptSnippet}"😂`,
        () => `${streamer}这句话说完全场都懵了💀`,
        () => `${streamer}的这波操作太顶了🔥`,
        () => `${streamer}这${Math.floor(ctx.clipDuration)}秒绝了😱`,
      ]
    : [
        () => `${streamer}这一波谁看谁懵🔥`,
        () => `${streamer}的操作看了三遍才看懂😂`,
        () => `${streamer}这${Math.floor(ctx.clipDuration)}秒太离谱了💀`,
        () => `${streamer}又整活了😱`,
      ]

  const title = templates[fallbackCounter % templates.length]()

  // Cover text — short, Douyin style, no emoji (cover rendering doesn't support emoji)
  const coverTexts = hasTranscript && transcriptSnippet.length >= 3
    ? [transcriptSnippet.slice(0, 5), `绝了`, `这波可以`, `太顶了`]
    : [`绝了`, `这波可以`, `教科书操作`, `太顶了`]
  const coverText = coverTexts[fallbackCounter % coverTexts.length]

  // Description — Douyin style, conversational, drives engagement
  const descTemplates = [
    () => {
      let desc = `${streamer}的这段高光时刻你一定要看`
      if (hasTranscript) desc += `，"${transcriptSnippet}……"这话说的也太真实了`
      desc += `。你们觉得这波几分？点个关注不迷路❤️`
      return desc
    },
    () => {
      if (hasTranscript) return `${streamer}说"${transcriptSnippet}"的时候我直接绷不住了💀 有同款经历的扣1！点个关注看更多精彩切片❤️`
      return `${streamer}的这段操作属实离谱，${Math.floor(ctx.clipDuration)}秒看完你就懂了🔥 双击关注不迷路！`
    },
  ]
  const description = descTemplates[fallbackCounter % descTemplates.length]()

  const fallbackTags = [
    '直播切片',
    streamer,
    ctx.liveTitle ? ctx.liveTitle.slice(0, 10) : '精彩瞬间',
  ].filter(Boolean)

  return { title, description, coverText, candidateTitles: [title], tags: fallbackTags, aiApproved: null, aiReviewReason: '' }
}

/**
 * Extract a meaningful hint from danmaku messages by finding frequently repeated words/phrases.
 * This helps generate more specific fallback titles when AI is unavailable.
 */
function extractDanmakuHint(texts: string[]): string {
  if (texts.length < 3) return ''

  // Count frequency of each message (exact match)
  const freq = new Map<string, number>()
  for (const t of texts) {
    const cleaned = t.trim()
    if (cleaned.length < 2 || cleaned.length > 15) continue
    freq.set(cleaned, (freq.get(cleaned) || 0) + 1)
  }

  // Find the most repeated message (must appear 3+ times)
  let bestMsg = ''
  let bestCount = 2
  for (const [msg, count] of freq) {
    if (count > bestCount) {
      bestCount = count
      bestMsg = msg
    }
  }
  if (bestMsg) return bestMsg

  // Look for common exclamation patterns
  const exclamations = texts.filter(t =>
    /[！!？?666牛nb厉害太强绝了卧槽woc哈哈笑死好看精彩]/.test(t)
  )
  if (exclamations.length >= 3) {
    // Find the most common exclamation
    const excFreq = new Map<string, number>()
    for (const t of exclamations) {
      const cleaned = t.trim()
      if (cleaned.length >= 2 && cleaned.length <= 10) {
        excFreq.set(cleaned, (excFreq.get(cleaned) || 0) + 1)
      }
    }
    let bestExc = ''
    let bestExcCount = 1
    for (const [msg, count] of excFreq) {
      if (count > bestExcCount) {
        bestExcCount = count
        bestExc = msg
      }
    }
    if (bestExc) return bestExc
  }

  return ''
}

// ──────────────────────────────────────────────
// Whisper-compatible speech-to-text
// ──────────────────────────────────────────────

export interface TranscriptSegment {
  start: number   // seconds
  end: number
  text: string
}

/**
 * Check if whisper transcription is available.
 * Prefers local whisper.cpp, falls back to API-based whisper.
 */
export function isWhisperConfigured(): boolean {
  if (isWhisperLocalReady()) return true
  const config = getConfig() as any
  const whisper = config.ai?.whisper
  return !!(whisper?.enabled && whisper?.api_key && whisper?.base_url)
}

/**
 * Transcribe audio using OpenAI-compatible /audio/transcriptions endpoint.
 * Uses separate whisper config (ai.whisper) since most Chinese LLM providers
 * don't support this endpoint.
 * Returns timestamped segments for subtitle generation.
 */
export async function transcribeAudio(audioPath: string): Promise<TranscriptSegment[]> {
  // Priority 1: Local whisper.cpp (best: free, offline, precise timestamps)
  if (isWhisperLocalReady()) {
    logger.info('Using local whisper.cpp for transcription')
    const segments = await transcribeLocal(audioPath)
    return segments.map(s => ({ start: s.start, end: s.end, text: s.text }))
  }

  // Priority 2: API-based whisper (fallback)
  const config = getConfig() as any
  const whisper = config.ai?.whisper
  if (!whisper?.enabled || !whisper?.api_key || !whisper?.base_url) {
    throw new Error(mt('error.asrNotConfigured'))
  }

  const model = whisper.model || 'whisper-1'

  // Auto-detect API protocol based on model name:
  // - qwen/asr models → dashscope chat/completions with input_audio
  // - whisper/other models → OpenAI /audio/transcriptions (multipart)
  const isDashscope = /qwen|asr|livetranslate/i.test(model) ||
                      whisper.base_url.includes('dashscope')

  if (isDashscope) {
    return transcribeViaDashscope(audioPath, whisper)
  } else {
    return transcribeViaWhisper(audioPath, whisper)
  }
}

/**
 * Transcribe via dashscope's OpenAI-compatible chat/completions endpoint.
 * Uses input_audio content type with base64-encoded audio.
 * Compatible with qwen3-asr-flash and similar models.
 */
async function transcribeViaDashscope(
  audioPath: string,
  whisper: { base_url: string; api_key: string; model: string },
): Promise<TranscriptSegment[]> {
  const baseUrl = whisper.base_url.replace(/\/+$/, '')
  const url = `${baseUrl}/chat/completions`
  const parsed = new URL(url)
  const model = whisper.model

  const audioData = readFileSync(audioPath)
  const audioBase64 = audioData.toString('base64')
  const ext = audioPath.toLowerCase()
  const mimeType = ext.endsWith('.mp3') ? 'audio/mpeg'
    : ext.endsWith('.ogg') ? 'audio/ogg'
    : ext.endsWith('.flac') ? 'audio/flac'
    : 'audio/wav'
  const dataUri = `data:${mimeType};base64,${audioBase64}`

  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: dataUri } },
      ],
    }],
    stream: false,
  }

  const body = Buffer.from(JSON.stringify(payload), 'utf-8')

  logger.info(`Dashscope ASR: model=${model}, url=${url}, audio=${(audioData.length / 1024).toFixed(0)}KB`)

  const result = await httpRequest(parsed, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Authorization': `Bearer ${whisper.api_key}`,
    },
    body,
    timeoutMs: 120000,
  })

  let json: any
  try {
    json = JSON.parse(result)
  } catch {
    throw new Error(mt('error.dashscopeNonJson', { detail: result.slice(0, 200) }))
  }

  if (json.error) {
    const errMsg = json.error.message || JSON.stringify(json.error)
    throw new Error(mt('error.dashscopeError', { message: errMsg }))
  }

  const content = json.choices?.[0]?.message?.content || ''
  if (!content) {
    throw new Error(mt('error.asrEmptyResponse', { model }))
  }

  logger.info(`Dashscope ASR text (model=${model}): "${content.slice(0, 200)}"`)

  // Try parsing <|time|> timestamp tokens (some models may include them)
  const timestampedSegments = parseAsrTimestamps(content)
  if (timestampedSegments.length > 0) {
    logger.info(`Dashscope ASR: parsed ${timestampedSegments.length} timestamped segments`)
    return timestampedSegments
  }

  // qwen3-asr-flash returns plain text without timestamps via chat/completions.
  // Use ffmpeg silence detection to find speech boundaries, then map text onto them.
  logger.info(`Dashscope ASR: aligning text with speech segments via silence detection`)
  try {
    const aligned = await alignTextWithSpeech(content, audioPath)
    if (aligned.length > 0) {
      logger.info(`Dashscope ASR: aligned ${aligned.length} segments via silence detection`)
      return aligned
    }
  } catch (e: any) {
    logger.warn(`Silence-based alignment failed: ${e.message}`)
  }

  // Fallback: estimate from audio duration
  const audioDuration = getAudioDuration(audioPath)
  if (audioDuration > 0) {
    const estimated = splitTextIntoSegments(content, audioDuration)
    if (estimated.length > 0) {
      logger.info(`Dashscope ASR: fallback estimated ${estimated.length} segments`)
      return estimated
    }
  }

  return [{ start: 0, end: audioDuration || 10, text: content }]
}

/**
 * Transcribe via OpenAI-compatible /audio/transcriptions endpoint.
 * Uses multipart form data. Compatible with OpenAI Whisper, Groq, etc.
 */
async function transcribeViaWhisper(
  audioPath: string,
  whisper: { base_url: string; api_key: string; model: string },
): Promise<TranscriptSegment[]> {
  const baseUrl = whisper.base_url.replace(/\/+$/, '')
  const url = `${baseUrl}/audio/transcriptions`
  const parsed = new URL(url)
  const model = whisper.model || 'whisper-1'

  const audioData = readFileSync(audioPath)
  const boundary = '----FormBoundary' + Date.now().toString(36)

  // Build multipart form data
  const parts: Buffer[] = []
  const addField = (name: string, value: string) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ))
  }

  addField('model', model)
  addField('response_format', 'verbose_json')
  addField('language', 'zh')

  // File field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
  ))
  parts.push(audioData)
  parts.push(Buffer.from('\r\n'))
  parts.push(Buffer.from(`--${boundary}--\r\n`))

  const body = Buffer.concat(parts)

  logger.info(`Whisper: model=${model}, url=${url}, audio=${(audioData.length / 1024).toFixed(0)}KB`)

  const result = await httpRequest(parsed, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      'Authorization': `Bearer ${whisper.api_key}`,
    },
    body,
    timeoutMs: 120000,
  })

  let json: any
  try {
    json = JSON.parse(result)
  } catch {
    logger.error(`Whisper returned non-JSON: ${result.slice(0, 300)}`)
    throw new Error(mt('error.whisperNonJson', { detail: result.slice(0, 200) }))
  }

  if (json.error) {
    const errMsg = json.error.message || JSON.stringify(json.error)
    throw new Error(mt('error.whisperError', { message: errMsg }))
  }

  logger.info(`Whisper response keys: ${Object.keys(json).join(', ')}`)

  // Try multiple response formats for compatibility:
  // OpenAI verbose_json: { segments: [{start, end, text}], text }
  // Fallback: just { text } with no timestamps
  let segments: TranscriptSegment[] = []

  const segs = json.segments
  if (Array.isArray(segs) && segs.length > 0) {
    segments = segs.map((s: any) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: (s.text || '').trim(),
    })).filter((s: TranscriptSegment) => s.text)
  }

  if (segments.length === 0) {
    const fullText = (json.text || '').trim()
    if (fullText) {
      logger.info(`Whisper model "${model}" returned text without timestamps, aligning via silence detection`)
      try {
        const aligned = await alignTextWithSpeech(fullText, audioPath)
        if (aligned.length > 0) {
          logger.info(`Whisper: aligned ${aligned.length} segments via silence detection`)
          return aligned
        }
      } catch (e: any) {
        logger.warn(`Silence-based alignment failed: ${e.message}`)
      }
      const audioDuration = getAudioDuration(audioPath)
      if (audioDuration > 0) {
        const estimated = splitTextIntoSegments(fullText, audioDuration)
        if (estimated.length > 0) return estimated
      }
      return [{ start: 0, end: getAudioDuration(audioPath) || 10, text: fullText }]
    }
  }

  logger.info(`Whisper result: ${segments.length} segments, text="${(json.text || '').slice(0, 80)}"`)
  return segments
}

/**
 * Simple HTTP request helper that returns the response body as a string.
 */
function httpRequest(
  parsed: URL,
  opts: { method: string; headers: Record<string, any>; body: Buffer; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.request(parsed, {
      method: opts.method,
      headers: opts.headers,
    }, (res) => {
      let data = ''
      res.on('data', (chunk: any) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`))
        } else {
          resolve(data)
        }
      })
    })
    req.on('error', (err) => reject(new Error(mt('error.requestFailed', { message: err.message }))))
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy()
      reject(new Error(mt('error.requestTimeout', { seconds: opts.timeoutMs / 1000 })))
    })
    req.write(opts.body)
    req.end()
  })
}

/**
 * Parse timestamp tokens from qwen3-asr-flash output.
 * Format: "<|0.00|>你好世界<|1.20|>今天天气不错<|2.50|>"
 * Also handles: "<|startoftranscript|>...<|0.00|>text<|1.20|>text<|endoftext|>"
 * Returns timestamped segments, or empty array if no timestamps found.
 */
function parseAsrTimestamps(content: string): TranscriptSegment[] {
  // Match all timestamp tokens like <|1.23|> or <|12.45|>
  const tokenRegex = /<\|(\d+(?:\.\d+)?)\|>/g
  const tokens: { time: number; index: number }[] = []
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(content)) !== null) {
    const time = parseFloat(match[1])
    if (!isNaN(time)) {
      tokens.push({ time, index: match.index + match[0].length })
    }
  }

  if (tokens.length < 2) return []

  const segments: TranscriptSegment[] = []
  for (let i = 0; i < tokens.length - 1; i++) {
    const startIdx = tokens[i].index
    const endIdx = content.lastIndexOf('<|', tokens[i + 1].index - 1)
    const text = content.slice(startIdx, endIdx >= startIdx ? endIdx : tokens[i + 1].index).trim()
      // Remove any remaining special tokens
      .replace(/<\|[^|]*\|>/g, '')
      .trim()

    if (text) {
      segments.push({
        start: tokens[i].time,
        end: tokens[i + 1].time,
        text,
      })
    }
  }

  return segments
}

/**
 * Get audio file duration in seconds using ffprobe.
 */
/**
 * Align ASR text with audio using silence detection.
 * 1. Detect speech segments via ffmpeg silencedetect (real audio boundaries)
 * 2. Split text into sentences
 * 3. Distribute sentences across speech segments proportionally by character count
 *
 * This gives much better subtitle sync than pure duration-based estimation
 * because silence gaps provide real timing anchors from the audio.
 */
async function alignTextWithSpeech(text: string, audioPath: string): Promise<TranscriptSegment[]> {
  const speechSegments = await detectSpeechSegments(audioPath)
  if (speechSegments.length === 0) return []

  // Split text into sentences at natural boundaries
  const sentences = text
    .split(/(?<=[。！？；\n])|(?<=\.|\!|\?)\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  if (sentences.length === 0) return []

  // Total speech duration and total text chars
  const totalSpeechDuration = speechSegments.reduce((sum, s) => sum + (s.end - s.start), 0)
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0)
  if (totalChars === 0 || totalSpeechDuration <= 0) return []

  // Distribute sentences across speech segments.
  // Each speech segment gets a share of sentences proportional to its duration.
  const results: TranscriptSegment[] = []
  let sentenceIdx = 0
  let charsAssigned = 0

  for (let segIdx = 0; segIdx < speechSegments.length && sentenceIdx < sentences.length; segIdx++) {
    const seg = speechSegments[segIdx]
    const segDuration = seg.end - seg.start

    // How many chars should this speech segment cover?
    const segCharBudget = (segDuration / totalSpeechDuration) * totalChars

    // Collect sentences until we've filled this segment's budget
    let segText = ''
    let segChars = 0
    const targetChars = charsAssigned + segCharBudget

    while (sentenceIdx < sentences.length) {
      const nextSentence = sentences[sentenceIdx]
      const newTotal = charsAssigned + segChars + nextSentence.length

      // If adding this sentence overshoots by more than half its length,
      // and we already have some text, stop (unless this is the last speech segment)
      if (segText && newTotal > targetChars + nextSentence.length / 2 && segIdx < speechSegments.length - 1) {
        break
      }

      segText += nextSentence
      segChars += nextSentence.length
      sentenceIdx++

      // If we have enough text for this segment, move on
      if (newTotal >= targetChars && segIdx < speechSegments.length - 1) break
    }

    if (segText) {
      // Sub-split long segments for better subtitle display (~8 chars per subtitle)
      const subSegments = subSplitSegment(segText, seg.start, seg.end)
      results.push(...subSegments)
      charsAssigned += segChars
    }
  }

  // Any remaining sentences go into the last speech segment
  if (sentenceIdx < sentences.length) {
    const remaining = sentences.slice(sentenceIdx).join('')
    const lastSeg = speechSegments[speechSegments.length - 1]
    if (remaining.trim()) {
      const subSegments = subSplitSegment(remaining, lastSeg.start, lastSeg.end)
      results.push(...subSegments)
    }
  }

  return results
}

/**
 * Sub-split a text segment into subtitle-sized chunks (~8 chars each),
 * distributing time proportionally within the given time range.
 */
function subSplitSegment(text: string, start: number, end: number): TranscriptSegment[] {
  const maxChars = 10
  if (text.length <= maxChars) {
    return [{ start, end, text }]
  }

  // Split at punctuation or every maxChars characters
  const chunks: string[] = []
  let remaining = text
  const punctuation = /[，。？！、,!?：:；;]/

  while (remaining.length > maxChars) {
    let splitIdx = -1
    // Try to break at punctuation near maxChars
    for (let i = maxChars; i >= Math.max(1, maxChars - 4); i--) {
      if (i <= remaining.length && punctuation.test(remaining[i - 1])) {
        splitIdx = i
        break
      }
    }
    if (splitIdx < 0) splitIdx = maxChars
    chunks.push(remaining.slice(0, splitIdx).trim())
    remaining = remaining.slice(splitIdx).trim()
  }
  if (remaining) chunks.push(remaining)

  // Distribute time proportionally
  const totalChars = chunks.reduce((sum, c) => sum + c.length, 0)
  const duration = end - start
  const segments: TranscriptSegment[] = []
  let cursor = start

  for (const chunk of chunks) {
    if (!chunk) continue
    const chunkDuration = (chunk.length / totalChars) * duration
    segments.push({ start: cursor, end: cursor + chunkDuration, text: chunk })
    cursor += chunkDuration
  }

  return segments
}

function getAudioDuration(audioPath: string): number {
  try {
    const ffmpegPath = getFFmpegPath()
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1')
    const probeBin = existsSync(ffprobePath) ? ffprobePath : 'ffprobe'

    const result = spawnSync(probeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      audioPath,
    ], { timeout: 10000 })

    if (result.stdout) {
      const json = JSON.parse(result.stdout.toString())
      const dur = parseFloat(json.format?.duration)
      if (!isNaN(dur) && dur > 0) return dur
    }
  } catch (e: any) {
    logger.warn(`Failed to get audio duration: ${e.message}`)
  }
  return 0
}

/**
 * Split a single text into timed segments for subtitle display.
 * Used when the API returns only full text without timestamps.
 */
function splitTextIntoSegments(text: string, totalDuration: number): TranscriptSegment[] {
  // Split at sentence boundaries
  const sentences = text.split(/(?<=[。！？；\n])|(?<=\.|\!|\?)\s+/).filter(s => s.trim())
  if (sentences.length === 0) return []

  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0)
  const segments: TranscriptSegment[] = []
  let offset = 0

  for (const sentence of sentences) {
    const ratio = sentence.length / totalChars
    const duration = ratio * totalDuration
    segments.push({
      start: offset,
      end: offset + duration,
      text: sentence.trim(),
    })
    offset += duration
  }

  return segments
}

function imageToDataUrl(filePath: string): string {
  const data = readFileSync(filePath)
  const ext = filePath.toLowerCase().endsWith('.png') ? 'png' : 'jpeg'
  return `data:image/${ext};base64,${data.toString('base64')}`
}

function httpPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http

    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`AI API HTTP ${res.statusCode}: ${data.slice(0, 300)}`))
          } else {
            resolve(data)
          }
        })
      },
    )

    req.on('error', (err) => reject(new Error(`AI API request failed: ${err.message}`)))
    req.setTimeout(60000, () => {
      req.destroy()
      reject(new Error(mt('error.aiTimeout')))
    })
    req.write(body)
    req.end()
  })
}
