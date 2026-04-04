import { app } from 'electron'
import { join } from 'path'
import { appendFileSync, mkdirSync, existsSync } from 'fs'

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
type LogLevel = typeof LOG_LEVELS[number]

let logDir: string
let minLevel: LogLevel = 'info'

function getLogDir(): string {
  if (!logDir) {
    try {
      logDir = join(app.getPath('userData'), 'logs')
    } catch {
      logDir = join(process.cwd(), 'logs')
    }
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true })
    }
  }
  return logDir
}

function formatTime(): string {
  return new Date().toISOString()
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minLevel)
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

export function getLogger(name: string) {
  const log = (level: LogLevel, msg: string, ...args: any[]) => {
    if (!shouldLog(level)) return

    const formatted = args.length > 0
      ? `${msg} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`
      : msg

    const line = `${formatTime()} [${level.toUpperCase()}] [${name}] ${formatted}`

    // Console output
    const consoleFn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug
      : console.log
    consoleFn(line)

    // File output
    try {
      const logFile = join(getLogDir(), `${new Date().toISOString().slice(0, 10)}.log`)
      appendFileSync(logFile, line + '\n')
    } catch { /* ignore file write errors */ }
  }

  return {
    debug: (msg: string, ...args: any[]) => log('debug', msg, ...args),
    info: (msg: string, ...args: any[]) => log('info', msg, ...args),
    warn: (msg: string, ...args: any[]) => log('warn', msg, ...args),
    error: (msg: string, ...args: any[]) => log('error', msg, ...args),
  }
}
