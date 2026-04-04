import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { getLogger } from './utils/logger'

const logger = getLogger('db')

let db: Database.Database | null = null

function getDbPath(): string {
  try {
    const dir = join(app.getPath('userData'), 'data')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, 'liveclipai.db')
  } catch {
    return join(process.cwd(), 'data', 'liveclipai.db')
  }
}

export function getDb(): Database.Database {
  if (db) return db

  const dbPath = getDbPath()
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  initSchema(db)
  migrateSchema(db)
  logger.info(`Database opened: ${dbPath}`)
  return db
}

function migrateSchema(db: Database.Database): void {
  // Add description column if it doesn't exist (for existing databases)
  const cols = db.prepare("PRAGMA table_info('slices')").all() as { name: string }[]
  const colNames = cols.map(c => c.name)
  if (!colNames.includes('description')) {
    db.exec("ALTER TABLE slices ADD COLUMN description TEXT DEFAULT ''")
    logger.info('Migration: added description column to slices')
  }
  if (!colNames.includes('cover_text')) {
    db.exec("ALTER TABLE slices ADD COLUMN cover_text TEXT DEFAULT ''")
    logger.info('Migration: added cover_text column to slices')
  }
  if (!colNames.includes('tags_json')) {
    db.exec("ALTER TABLE slices ADD COLUMN tags_json TEXT DEFAULT '[]'")
    logger.info('Migration: added tags_json column to slices')
  }
  if (!colNames.includes('subtitle_path')) {
    db.exec("ALTER TABLE slices ADD COLUMN subtitle_path TEXT DEFAULT ''")
    logger.info('Migration: added subtitle_path column to slices')
  }
  if (!colNames.includes('ai_approved')) {
    db.exec("ALTER TABLE slices ADD COLUMN ai_approved INTEGER DEFAULT NULL")
    logger.info('Migration: added ai_approved column to slices')
  }
  if (!colNames.includes('ai_review_reason')) {
    db.exec("ALTER TABLE slices ADD COLUMN ai_review_reason TEXT DEFAULT ''")
    logger.info('Migration: added ai_review_reason column to slices')
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      task_type TEXT NOT NULL DEFAULT 'live',
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT DEFAULT '',
      author TEXT DEFAULT '',
      cover_url TEXT DEFAULT '',
      stream_url TEXT DEFAULT '',
      output_dir TEXT DEFAULT '',
      config_json TEXT DEFAULT '{}',
      live_stats_json TEXT DEFAULT '{}',
      error_message TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS slices (
      slice_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      duration REAL NOT NULL,
      slice_path TEXT NOT NULL,
      cover_path TEXT DEFAULT '',
      selected_title TEXT DEFAULT '',
      cover_text TEXT DEFAULT '',
      description TEXT DEFAULT '',
      candidate_titles_json TEXT DEFAULT '[]',
      peak_score REAL DEFAULT 0,
      subtitle_path TEXT DEFAULT '',
      ai_approved INTEGER DEFAULT NULL,
      ai_review_reason TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS publish_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slice_id TEXT NOT NULL REFERENCES slices(slice_id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      publish_url TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      task_id TEXT DEFAULT '',
      slice_id TEXT DEFAULT '',
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS streamers (
      streamer_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      room_url TEXT NOT NULL,
      room_id TEXT DEFAULT '',
      nickname TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'persistent',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_live INTEGER NOT NULL DEFAULT 0,
      last_live_at TEXT DEFAULT '',
      active_task_id TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
    CREATE INDEX IF NOT EXISTS idx_slices_task ON slices(task_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
    CREATE INDEX IF NOT EXISTS idx_streamers_enabled ON streamers(enabled);
  `)
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
