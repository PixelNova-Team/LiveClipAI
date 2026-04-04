import { app, BrowserWindow, shell, session, protocol, net, nativeImage } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { stopWatcher } from './streamer-watcher'
import { startStreamProxy } from './stream-proxy'
import { getDb } from './db'
import { detectPlatformFromUrl, getRefererUrl, getUserAgent, getCdnDomainMap } from './utils/platform-config'

// Single instance lock — prevent multiple app windows
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function getAppIcon(): Electron.NativeImage | undefined {
  const iconPaths = [
    join(__dirname, '../../build/icon.png'),
    join(app.getAppPath(), 'build/icon.png'),
    join(app.getAppPath(), '../build/icon.png'),
  ]
  for (const p of iconPaths) {
    if (existsSync(p)) return nativeImage.createFromPath(p)
  }
  return undefined
}

function createWindow(): void {
  // On macOS, icon is handled by .icns in production; skip to avoid raw PNG in dock
  const icon = process.platform === 'darwin' ? undefined : getAppIcon()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'LiveClipAI',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Forward renderer console to main process stdout in dev
  if (is.dev) {
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      const prefix = ['LOG', 'WARN', 'ERR', 'INFO'][level] || 'LOG'
      console.log(`[Renderer:${prefix}] ${message}`)
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Register liveclipai:// protocol scheme (must happen before app ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'liveclipai',
    privileges: { bypassCSP: true, stream: true, supportFetchAPI: true }
  }
])

app.whenReady().then(() => {
  // Handle liveclipai:// URLs to serve local slice/video files
  protocol.handle('liveclipai', (request) => {
    const url = new URL(request.url)
    const host = url.host
    const parts = url.pathname.replace(/^\/+/, '').split('/')

    // liveclipai://slice/{sliceId}/preview or /cover or /thumb
    if (host === 'slice') {
      const sliceId = parts[0] || ''
      const kind = parts[1] || 'preview'

      if (!sliceId) return new Response('Invalid URL', { status: 400 })

      try {
        const db = getDb()
        const row = db.prepare('SELECT slice_path, cover_path FROM slices WHERE slice_id = ?').get(sliceId) as
          { slice_path: string; cover_path: string } | undefined

        if (!row) return new Response('Slice not found', { status: 404 })

        const filePath = (kind === 'cover' || kind === 'thumb') ? row.cover_path : row.slice_path
        if (!filePath || !existsSync(filePath)) {
          return new Response(`File not found: ${filePath}`, { status: 404 })
        }

        // Thumbnail: generate a smaller version for list views (cached on disk)
        if (kind === 'thumb') {
          const thumbPath = filePath.replace(/\.(jpg|jpeg|png)$/i, '_thumb.jpg')
          if (!existsSync(thumbPath)) {
            try {
              const { execFileSync } = require('child_process')
              const ffmpegPath = require('./ffmpeg').getFFmpegPath()
              execFileSync(ffmpegPath, [
                '-y', '-i', filePath,
                '-vf', 'scale=480:-1',
                '-q:v', '8',
                thumbPath,
              ], { timeout: 5000 })
            } catch {
              // Fallback: serve original if thumbnail generation fails
              return net.fetch(pathToFileURL(filePath).toString())
            }
          }
          return net.fetch(pathToFileURL(thumbPath).toString())
        }

        return net.fetch(pathToFileURL(filePath).toString())
      } catch (e: any) {
        return new Response(`Error: ${e.message}`, { status: 500 })
      }
    }

    // liveclipai://video/{taskId}/source — serve source recording
    if (host === 'video') {
      const taskId = parts[0] || ''
      if (!taskId) return new Response('Invalid URL', { status: 400 })

      try {
        const db = getDb()
        const task = db.prepare('SELECT local_video_path FROM tasks WHERE task_id = ?').get(taskId) as
          { local_video_path: string } | undefined
        if (!task?.local_video_path || !existsSync(task.local_video_path)) {
          return new Response('Video not found', { status: 404 })
        }
        return net.fetch(pathToFileURL(task.local_video_path).toString())
      } catch (e: any) {
        return new Response(`Error: ${e.message}`, { status: 500 })
      }
    }

    return new Response('Unknown protocol path', { status: 400 })
  })
  // Remove CORS restrictions for live stream CDN URLs
  // mpegts.js fetches FLV streams via fetch/XHR which would be blocked by CORS
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url
    const isStream = url.includes('.flv') || url.includes('.m3u8') || url.includes('stream')
    // Also handle CDN image/resource requests (cover images, avatars)
    const cdnDomainMap = getCdnDomainMap()
    const isCdnResource = Array.from(cdnDomainMap.keys()).some(domain => url.includes(domain))

    if (isStream || isCdnResource) {
      if (isStream) {
        // Remove Origin header to avoid CORS preflight
        delete details.requestHeaders['Origin']
      }

      // Detect platform and set Referer/User-Agent from config
      const platform = detectPlatformFromUrl(url)
      if (platform) {
        details.requestHeaders['Referer'] = getRefererUrl(platform)
        details.requestHeaders['User-Agent'] = getUserAgent(platform)
      }
    }

    callback({ requestHeaders: details.requestHeaders })
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url
    const cdnDomainMap = getCdnDomainMap()
    const isCdnUrl = Array.from(cdnDomainMap.keys()).some(domain => url.includes(domain))
    // Add permissive CORS headers for stream responses
    if (url.includes('.flv') || url.includes('.m3u8') || url.includes('stream') || isCdnUrl) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Access-Control-Allow-Origin': ['*'],
          'Access-Control-Allow-Headers': ['*'],
          'Access-Control-Allow-Methods': ['GET, OPTIONS'],
        },
      })
    } else {
      callback({ responseHeaders: details.responseHeaders })
    }
  })

  // macOS dock icon: .icns handles masking in production builds automatically.
  // In dev mode, don't call dock.setIcon() — it bypasses macOS icon masking.


  registerIpcHandlers().catch((e) => console.error('Failed to initialize IPC handlers:', e))
  startStreamProxy().catch((e) => console.warn('Stream proxy start failed:', e))
  createWindow()

  // When second instance is launched, focus existing window
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('will-quit', () => {
  stopWatcher()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
