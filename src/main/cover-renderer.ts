import { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { getLogger } from './utils/logger'

const logger = getLogger('cover-renderer')

/**
 * Render text overlay on a cover image using Electron's offscreen BrowserWindow.
 * Produces B-site / Douyin style covers with large bold text, dark gradient backdrop,
 * and yellow/white accent colors for maximum click-through impact.
 */
export async function renderCoverWithText(
  inputImage: string,
  outputImage: string,
  title: string,
  options?: { position?: 'top' | 'center' | 'bottom'; videoResolution?: { width: number; height: number } | null }
): Promise<boolean> {
  if (!existsSync(inputImage)) {
    logger.warn(`Cover image not found: ${inputImage}`)
    return false
  }

  const { position = 'center', videoResolution } = options || {}

  // Adapt canvas and font size for portrait videos
  // Portrait source → narrow cover image, need smaller font
  const isPortrait = videoResolution ? videoResolution.height > videoResolution.width : false
  let canvasWidth = 1280
  let canvasHeight = 720
  let coverFontSize = 128
  if (isPortrait && videoResolution) {
    // Fit portrait aspect ratio into 720px height
    canvasWidth = Math.round(720 * (videoResolution.width / videoResolution.height))
    coverFontSize = Math.max(88, Math.min(144, Math.round(canvasWidth * 0.36)))
    logger.info(`Cover renderer: portrait ${videoResolution.width}x${videoResolution.height}, canvas=${canvasWidth}x${canvasHeight}, fontSize=${coverFontSize}`)
  }

  try {
    const imgData = readFileSync(inputImage)
    const ext = inputImage.toLowerCase().endsWith('.png') ? 'png' : 'jpeg'
    const dataUrl = `data:image/${ext};base64,${imgData.toString('base64')}`

    // Position the text block
    let containerCSS: string
    if (position === 'top') {
      containerCSS = 'top: 0; padding-top: 40px; padding-bottom: 60px; background: linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.3) 70%, transparent 100%);'
    } else if (position === 'bottom') {
      containerCSS = 'bottom: 0; padding-bottom: 40px; padding-top: 60px; background: linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.3) 70%, transparent 100%);'
    } else {
      containerCSS = 'top: 50%; transform: translateY(-50%); padding: 30px 0; background: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.55) 20%, rgba(0,0,0,0.55) 80%, transparent 100%);'
    }

    // Escape title for HTML
    const safeTitle = title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

    const maxCharsPerLine = isPortrait ? 3 : 5
    const lines = splitText(safeTitle, maxCharsPerLine)
    const linesHtml = lines.map(l => `<div>${l}</div>`).join('')
    const padding = isPortrait ? '20px' : '50px'

    // Auto-shrink font if text block would exceed ~80% of canvas height
    const lineHeight = 1.25
    const maxTextHeight = canvasHeight * 0.8
    const estimatedTextHeight = lines.length * coverFontSize * lineHeight
    if (estimatedTextHeight > maxTextHeight) {
      coverFontSize = Math.max(36, Math.floor(maxTextHeight / (lines.length * lineHeight)))
      logger.info(`Cover renderer: auto-shrink fontSize to ${coverFontSize} (${lines.length} lines)`)
    }

    const shadowSize = Math.max(1, Math.round(coverFontSize / 24))
    const strokeWidth = Math.max(0.5, coverFontSize / 48)

    const html = `<!DOCTYPE html>
<html>
<head>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: ${canvasWidth}px;
  height: ${canvasHeight}px;
  overflow: hidden;
  position: relative;
  background: #000;
}
.bg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.text-container {
  position: absolute;
  left: 0;
  right: 0;
  ${containerCSS}
  text-align: center;
  padding-left: ${padding};
  padding-right: ${padding};
  z-index: 2;
}
.text-container div {
  font-family: "PingFang SC", "Hiragino Sans GB", "STHeiti", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif;
  font-size: ${coverFontSize}px;
  font-weight: 900;
  color: #ffffff;
  text-shadow:
    -${shadowSize}px -${shadowSize}px 0 rgba(0,0,0,0.9),
     ${shadowSize}px -${shadowSize}px 0 rgba(0,0,0,0.9),
    -${shadowSize}px  ${shadowSize}px 0 rgba(0,0,0,0.9),
     ${shadowSize}px  ${shadowSize}px 0 rgba(0,0,0,0.9),
     0    0  ${shadowSize * 3}px rgba(0,0,0,0.7),
     0    ${shadowSize}px ${shadowSize * 4}px rgba(0,0,0,0.5);
  line-height: 1.25;
  letter-spacing: ${isPortrait ? 1 : 3}px;
  -webkit-text-stroke: ${strokeWidth}px rgba(0,0,0,0.4);
  paint-order: stroke fill;
}
</style>
</head>
<body>
  <img class="bg" src="${dataUrl}" />
  <div class="text-container">${linesHtml}</div>
</body>
</html>`

    const win = new BrowserWindow({
      width: canvasWidth,
      height: canvasHeight,
      show: false,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      await new Promise(resolve => setTimeout(resolve, 400))
      const image = await win.webContents.capturePage()
      const buffer = image.toJPEG(95)
      writeFileSync(outputImage, buffer)
      logger.info(`Cover text overlay rendered: ${outputImage}`)
      return true
    } finally {
      win.destroy()
    }
  } catch (e: any) {
    logger.warn(`Cover text render failed: ${e.message}`)
    return false
  }
}

function splitText(text: string, maxCharsPerLine: number): string[] {
  text = text.trim()
  if (text.length <= maxCharsPerLine) return [text]

  const punctuation = /[，。？！、,!?：:；;]/
  const lines: string[] = []
  let remaining = text

  while (remaining.length > maxCharsPerLine) {
    let splitIdx = -1
    for (let i = maxCharsPerLine; i >= Math.max(1, maxCharsPerLine - 4); i--) {
      if (i <= remaining.length && punctuation.test(remaining[i - 1])) {
        splitIdx = i
        break
      }
    }
    if (splitIdx < 0) splitIdx = maxCharsPerLine

    lines.push(remaining.slice(0, splitIdx).trim())
    remaining = remaining.slice(splitIdx).trim()
  }
  if (remaining) lines.push(remaining)

  return lines
}
