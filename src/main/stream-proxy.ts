import http from 'http'
import https from 'https'
import { URL } from 'url'
import { getLogger } from './utils/logger'

const logger = getLogger('stream-proxy')

let server: http.Server | null = null
let proxyPort = 0

// Map of token -> { url, headers, format }
const streams = new Map<string, { url: string; headers: Record<string, string>; format?: string }>()
let tokenCounter = 0

/**
 * Register a stream URL and return a local proxy URL for the renderer to use.
 */
export function registerStream(streamUrl: string, headers: Record<string, string> = {}): string {
  const token = `s${++tokenCounter}`
  // Detect stream format from URL for frontend player
  let format: string | undefined
  if (streamUrl.includes('.flv')) format = 'flv'
  else if (streamUrl.includes('.m3u8')) format = 'hls'
  else if (streamUrl.includes('.ts') || streamUrl.includes('mpegts')) format = 'mpegts'
  streams.set(token, { url: streamUrl, headers, format })
  logger.info(`Registered stream proxy: token=${token}, format=${format || 'auto'}, url=${streamUrl.slice(0, 80)}...`)
  return `http://127.0.0.1:${proxyPort}/stream/${token}${format ? `?format=${format}` : ''}`
}

/**
 * Remove a registered stream.
 */
export function unregisterStream(proxyUrl: string): void {
  const m = /\/stream\/(\w+)/.exec(proxyUrl)
  if (m) {
    streams.delete(m[1])
    logger.info(`Unregistered stream proxy: token=${m[1]}`)
  }
}

/**
 * Start the local HTTP proxy server.
 */
export function startStreamProxy(): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(proxyPort)
      return
    }

    server = http.createServer((req, res) => {
      const m = /^\/stream\/(\w+)/.exec(req.url || '')
      if (!m) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const entry = streams.get(m[1])
      if (!entry) {
        res.writeHead(404)
        res.end('Stream not registered')
        return
      }

      // Set CORS headers so the renderer can access
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', '*')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      function fetchUpstream(targetUrl: string, redirectCount = 0) {
        if (redirectCount > 5) {
          logger.warn('Too many redirects')
          try { res.writeHead(502); res.end('Too many redirects') } catch { /* */ }
          return
        }

        const parsed = new URL(targetUrl)
        const isHttps = parsed.protocol === 'https:'
        const mod = isHttps ? https : http

        logger.debug(`Proxy fetch: ${targetUrl.slice(0, 100)}...`)

        const proxyReq = mod.request(
          targetUrl,
          {
            method: 'GET',
            headers: {
              ...entry.headers,
              'Accept': '*/*',
            },
            // Prevent Node from automatically rejecting self-signed certs on CDNs
            rejectUnauthorized: true,
          },
          (proxyRes) => {
            // Handle redirects (302/301/307)
            if (proxyRes.statusCode && proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
              logger.info(`Proxy redirect ${proxyRes.statusCode} -> ${proxyRes.headers.location.slice(0, 100)}`)
              proxyRes.resume() // drain the response
              fetchUpstream(proxyRes.headers.location, redirectCount + 1)
              return
            }

            const fwdHeaders: Record<string, string | string[]> = {
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache',
            }
            if (proxyRes.headers['content-type']) {
              fwdHeaders['Content-Type'] = proxyRes.headers['content-type'] as string
            } else {
              fwdHeaders['Content-Type'] = 'video/x-flv'
            }

            logger.info(`Proxy upstream connected: status=${proxyRes.statusCode}, content-type=${proxyRes.headers['content-type'] || 'none'}`)

            res.writeHead(proxyRes.statusCode || 200, fwdHeaders)
            proxyRes.pipe(res)

            proxyRes.on('error', (err) => {
              logger.warn(`Proxy upstream error: ${err.message}`)
              try { res.end() } catch { /* ignore */ }
            })
          },
        )

        proxyReq.on('error', (err) => {
          logger.warn(`Proxy request error: ${err.message}`)
          try {
            res.writeHead(502)
            res.end('Upstream error')
          } catch { /* ignore */ }
        })

        // Connection timeout for upstream (30s to establish connection)
        proxyReq.setTimeout(30000, () => {
          logger.warn('Proxy upstream connection timeout')
          proxyReq.destroy()
          try {
            res.writeHead(504)
            res.end('Upstream timeout')
          } catch { /* ignore */ }
        })

        // If the client disconnects, abort the upstream request
        req.on('close', () => {
          proxyReq.destroy()
        })

        proxyReq.end()
      }

      fetchUpstream(entry.url)
    })

    // Listen on a random available port
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (addr && typeof addr === 'object') {
        proxyPort = addr.port
        logger.info(`Stream proxy started on port ${proxyPort}`)
        resolve(proxyPort)
      } else {
        reject(new Error('Failed to get proxy server address'))
      }
    })

    server.on('error', (err) => {
      logger.error(`Stream proxy server error: ${err.message}`)
      reject(err)
    })
  })
}

/**
 * Stop the proxy server.
 */
export function stopStreamProxy(): void {
  if (server) {
    server.close()
    server = null
    proxyPort = 0
    streams.clear()
    logger.info('Stream proxy stopped')
  }
}
