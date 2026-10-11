'use strict';
/*
 * Base de datos de Kairos.
 * - Con DATABASE_URL (p. ej. Postgres de Render) usa el paquete «pg».
 * - Sin ella, usa SQLite integrado en Node (node:sqlite) en el archivo DATA_DIR/kairos.db.
 * Las consultas se escriben con «?» y aquí se adaptan a cada motor.
 */
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id {PK},
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Madrid',
  active_timetable_id INTEGER,
  email_notifications INTEGER NOT NULL DEFAULT 1,
  default_reminder_minutes INTEGER DEFAULT 1440,
  daily_digest INTEGER NOT NULL DEFAULT 0,
  digest_hour INTEGER NOT NULL DEFAULT 8,
  last_digest_date TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timetables (
  id {PK},
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  visible_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  background TEXT NOT NULL DEFAULT 'rayas',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slots (
  id {PK},
  user_id INTEGER NOT NULL,
  timetable_id INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  is_break INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subjects (
  id {PK},
  user_id INTEGER NOT NULL,
  timetable_id INTEGER NOT NULL,
  parent_id INTEGER,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '',
  teacher TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#3a7aa6'
);
CREATE TABLE IF NOT EXISTS schedule (
  id {PK},
  user_id INTEGER NOT NULL,
  slot_id INTEGER NOT NULL,
  day INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  room_override TEXT NOT NULL DEFAULT '',
  UNIQUE (slot_id, day)
);
CREATE TABLE IF NOT EXISTS items (
  id {PK},
  user_id INTEGER NOT NULL,
  timetable_id INTEGER NOT NULL,
  subject_id INTEGER,
  type TEXT NOT NULL DEFAULT 'task',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL,
  reminder_minutes INTEGER,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklist (
  id {PK},
  item_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id {PK},
  user_id INTEGER NOT NULL,
  timetable_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#7461a6',
  all_day INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL,
  end_at TEXT,
  reminder_minutes INTEGER,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id {PK},
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_messages (
  id {PK},
  user_id INTEGER,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  emailed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_log (
  id {PK},
  admin_id INTEGER,
  admin_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_user_id INTEGER,
  target_label TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_slots_user ON slots (user_id, timetable_id);
CREATE INDEX IF NOT EXISTS idx_subjects_user ON subjects (user_id, timetable_id);
CREATE INDEX IF NOT EXISTS idx_schedule_user ON schedule (user_id);
CREATE INDEX IF NOT EXISTS idx_items_user ON items (user_id, due_at);
CREATE INDEX IF NOT EXISTS idx_items_rem ON items (reminder_sent, done);
CREATE INDEX IF NOT EXISTS idx_checklist_item ON checklist (item_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON events (user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);
`;

/** Pequeña cola para que las transacciones de SQLite no se mezclen entre peticiones. */
function mutex() {
  let last = Promise.resolve();
  return (fn) => {
    const run = last.then(fn, fn);
    last = run.catch(() => {});
    return run;
  };
}

async function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
  raw.exec(SCHEMA.replaceAll('{PK}', 'INTEGER PRIMARY KEY AUTOINCREMENT'));
  const norm = (p) => p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));
  const q = {
    async all(sql, params = []) { return raw.prepare(sql).all(...norm(params)); },
    async get(sql, params = []) { return raw.prepare(sql).get(...norm(params)) || null; },
    async run(sql, params = []) {
      const st = raw.prepare(sql);
      if (/\breturning\b/i.test(sql)) return st.get(...norm(params)) || null;
      const r = st.run(...norm(params));
      return { changes: Number(r.changes) };
    },
  };
  const lock = mutex();
  return {
    kind: 'sqlite',
    ...q,
    tx: (fn) => lock(async () => {
      raw.exec('BEGIN');
      try {
        const r = await fn(q);
        raw.exec('COMMIT');
        return r;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    }),
  };
}

async function openPostgres(url) {
  const { Pool } = require('pg');
  // Las opciones de SSL de la dirección (sslmode, channel_binding…) se gestionan aquí para que
  // funcione igual con Neon, Supabase o el Postgres interno de Render.
  const parsed = new URL(url);
  for (const k of ['sslmode', 'channel_binding', 'sslrootcert', 'sslcert', 'sslkey']) parsed.searchParams.delete(k);
  const host = parsed.hostname;
  const local = /^(localhost|127\.0\.0\.1)$/.test(host) || !host.includes('.'); // sin punto = red interna de Render
  const ssl = local || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: parsed.toString(), ssl, max: 5 });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const norm = (p) => p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));
  const wrap = (c) => ({
    async all(sql, params = []) { return (await c.query(toPg(sql), norm(params))).rows; },
    async get(sql, params = []) { return (await c.query(toPg(sql), norm(params))).rows[0] || null; },
    async run(sql, params = []) {
      const r = await c.query(toPg(sql), norm(params));
      return /\breturning\b/i.test(sql) ? r.rows[0] || null : { changes: r.rowCount };
    },
  });
  for (const stmt of SCHEMA.replaceAll('{PK}', 'SERIAL PRIMARY KEY').split(';').map((s) => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }
  return {
    kind: 'postgres',
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn(wrap(client));
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

async function openDb() {
  if (process.env.DATABASE_URL) return openPostgres(process.env.DATABASE_URL);
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  return openSqlite(path.join(dir, 'kairos.db'));
}

module.exports = { openDb };
