'use strict';
/*
 * Kairos · servidor
 * API JSON en /api y archivos de la app en /public. Sin dependencias obligatorias:
 * «pg», «nodemailer», «web-push» y las fuentes de @fontsource se usan si están instalados.
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { openDb } = require('./db');
const notify = require('./notify');
const ics = require('./ics');
const { startReminders } = require('./reminders');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 90;
const GUEST_SESSION_DAYS = 5 * 365; // sin cuenta, la sesión es lo único que une el dispositivo con sus datos
const GUEST_DOMAIN = 'invitado.kairos'; // correo interno de las cuentas sin registrar (nunca se muestra ni se usa para enviar)
const GUEST_MAX_IDLE_DAYS = 365;
const COOKIE = 'kairos_session';
const TERMS_VERSION = '2026-10-11';
// Superadministradora: la única que puede nombrar o quitar administradores. Se puede cambiar con la variable SUPERADMIN_EMAIL.
const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || 'apps.ainara@outlook.com').trim().toLowerCase(); // fecha de los textos legales vigentes (public/legal.html)

/* ============================================================
   Utilidades
   ============================================================ */
class HttpError extends Error {
  constructor(status, message, extra = null) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (what = 'No encontrado') => new HttpError(404, what);
const nowIso = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const bool = (v) => (v ? 1 : 0);

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const BACKGROUNDS = ['rayas', 'rayas-rosa', 'cuadricula', 'puntos', 'lisa', 'arena', 'menta', 'lavanda', 'cielo', 'noche'];

function isoDate(v, field) {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) throw bad(`${field} no es una fecha válida`);
  return d.toISOString();
}
function optDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (!DATE_RE.test(v)) throw bad('Fecha no válida');
  return v;
}
function reminderValue(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 60 * 24 * 60) throw bad('Aviso no válido');
  return n;
}
function daysValue(v) {
  if (!Array.isArray(v)) throw bad('Días no válidos');
  const days = [...new Set(v.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!days.length) throw bad('Elige al menos un día de la semana');
  return days.sort((a, b) => a - b);
}
function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('es-ES', { timeZone: tz }); return true; } catch { return false; }
}

/* Contraseñas con scrypt */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [kind, saltHex, hashHex] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

/* ============================================================
   Formato de las filas que recibe la app
   ============================================================ */
/** Apariencias de la app (fondo y, según su claridad, letra negra o blanca). */
const THEMES = ['auto', 'crema', 'blanco', 'gris', 'rosa', 'menta', 'cielo', 'lavanda', 'arena', 'oscuro', 'negro', 'noche', 'bosque', 'vino'];

const fmtUser = (u, tt) => ({
  id: u.id,
  name: u.name,
  email: u.is_guest ? '' : u.email,
  timezone: u.timezone,
  active_timetable_id: u.active_timetable_id,
  email_notifications: Boolean(u.email_notifications),
  default_reminder_minutes: u.default_reminder_minutes ?? null,
  daily_digest: Boolean(u.daily_digest),
  digest_hour: u.digest_hour,
  visible_days: tt ? JSON.parse(tt.visible_days) : [1, 2, 3, 4, 5],
  tt_background: tt ? tt.background : 'rayas',
  // La foto se sirve aparte (no se manda en cada carga); el número cambia cada vez que se actualiza.
  is_guest: Boolean(u.is_guest),
  role: u.role || 'user',
  is_admin: u.role === 'admin' || u.role === 'superadmin',
  is_superadmin: u.role === 'superadmin',
  theme: u.theme || 'auto',
  avatar_url: u.avatar_data ? `/api/me/avatar?v=${encodeURIComponent(u.avatar_updated || '')}` : null,
});
const fmtTimetable = (t) => ({
  id: t.id, name: t.name, start_date: t.start_date || null, end_date: t.end_date || null,
  visible_days: JSON.parse(t.visible_days), background: t.background,
});
const fmtSlot = (s) => ({ id: s.id, timetable_id: s.timetable_id, start_time: s.start_time, end_time: s.end_time, label: s.label, is_break: Boolean(s.is_break) });
const fmtSubject = (s) => ({ id: s.id, timetable_id: s.timetable_id, parent_id: s.parent_id ?? null, name: s.name, short_name: s.short_name, room: s.room, teacher: s.teacher, teacher_email: s.teacher_email || '', color: s.color, start_date: s.start_date || null, end_date: s.end_date || null, skip_dates: parseSkip(s.skip_dates) });
/** Días sin clase de una asignatura (festivos, etc.), guardados como lista de fechas AAAA-MM-DD. */
function parseSkip(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : []; } catch { return []; } }
const fmtEntry = (e) => ({ id: e.id, slot_id: e.slot_id, day: e.day, subject_id: e.subject_id, room_override: e.room_override });
const fmtEvent = (e) => ({
  id: e.id, timetable_id: e.timetable_id, title: e.title, location: e.location, description: e.description, color: e.color,
  all_day: Boolean(e.all_day), start_at: e.start_at, end_at: e.end_at || null,
  reminder_minutes: e.reminder_minutes ?? null, reminder_sent: Boolean(e.reminder_sent), done: Boolean(e.done),
});
const fmtItem = (i, checklist, files = []) => ({
  id: i.id, timetable_id: i.timetable_id, subject_id: i.subject_id ?? null, type: i.type, title: i.title, description: i.description, room: i.room || '',
  due_at: i.due_at, reminder_minutes: i.reminder_minutes ?? null, reminder_sent: Boolean(i.reminder_sent), done: Boolean(i.done),
  checklist: checklist.map((c) => ({ id: c.id, text: c.text, done: Boolean(c.done) })),
  files: files.map((f) => ({ id: f.id, name: f.name, size: Number(f.size) })),
});

const collator = new Intl.Collator('es', { sensitivity: 'base' });

/* ============================================================
   Arranque
   ============================================================ */
const DEFAULT_SLOTS = [
  ['08:00', '08:55', '', 0], ['08:55', '09:50', '', 0], ['09:50', '10:45', '', 0], ['10:45', '11:15', 'Recreo', 1],
  ['11:15', '12:10', '', 0], ['12:10', '13:05', '', 0], ['13:05', '14:00', '', 0],
];

async function main() {
  const db = await openDb();
  // Columnas añadidas después de la primera versión (si ya existen, se ignora el error).
  for (const col of ['accepted_terms_at TEXT', 'terms_version TEXT', 'avatar_data TEXT', 'avatar_updated TEXT', "role TEXT NOT NULL DEFAULT 'user'", 'suspended_at TEXT', 'last_seen_at TEXT', 'is_guest INTEGER NOT NULL DEFAULT 0',
    'suspend_reason TEXT', 'delete_suggested_at TEXT', 'delete_suggested_by TEXT', 'delete_suggested_reason TEXT']) {
    await db.run(`ALTER TABLE users ADD COLUMN ${col}`).catch(() => {});
  }
  await db.run('ALTER TABLE contact_messages ADD COLUMN resolved_at TEXT').catch(() => {});
  for (const col of ['start_date TEXT', 'end_date TEXT', "teacher_email TEXT NOT NULL DEFAULT ''", "skip_dates TEXT NOT NULL DEFAULT '[]'"]) await db.run(`ALTER TABLE subjects ADD COLUMN ${col}`).catch(() => {});
  await db.run('ALTER TABLE events ADD COLUMN done INTEGER NOT NULL DEFAULT 0').catch(() => {});
  await db.run("ALTER TABLE items ADD COLUMN room TEXT NOT NULL DEFAULT ''").catch(() => {});
  await db.run("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'auto'").catch(() => {});
  await db.run('ALTER TABLE users ADD COLUMN calendar_token TEXT').catch(() => {});
  // Solo hay una superadministradora: la del correo configurado.
  await db.run("UPDATE users SET role = 'admin' WHERE role = 'superadmin' AND email <> ?", [SUPERADMIN_EMAIL]);
  await db.run("UPDATE users SET role = 'superadmin', suspended_at = NULL, suspend_reason = NULL, delete_suggested_at = NULL WHERE email = ?", [SUPERADMIN_EMAIL]);
  await notify.initPush(db).catch((e) => console.error('[push] no disponible:', e.message));
  notify.checkSender();

  /* ---------- consultas de apoyo ---------- */
  const getUser = (id) => db.get('SELECT * FROM users WHERE id = ?', [id]);
  const listTimetables = (uid) => db.all('SELECT * FROM timetables WHERE user_id = ? ORDER BY id', [uid]);
  const listSlots = async (uid) => (await db.all('SELECT * FROM slots WHERE user_id = ? ORDER BY timetable_id, start_time, id', [uid])).map(fmtSlot);
  const listSubjects = async (uid) => (await db.all('SELECT * FROM subjects WHERE user_id = ?', [uid])).map(fmtSubject).sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
  const listSchedule = async (uid) => (await db.all('SELECT * FROM schedule WHERE user_id = ? ORDER BY id', [uid])).map(fmtEntry);
  const listEvents = async (uid) => (await db.all('SELECT * FROM events WHERE user_id = ? ORDER BY start_at, id', [uid])).map(fmtEvent);
  const pushDevices = async (uid) => Number((await db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [uid])).n);

  async function listItems(uid) {
    const items = await db.all('SELECT * FROM items WHERE user_id = ? ORDER BY due_at, id', [uid]);
    const checks = await db.all('SELECT c.* FROM checklist c JOIN items i ON i.id = c.item_id WHERE i.user_id = ? ORDER BY c.item_id, c.position, c.id', [uid]);
    const by = new Map();
    for (const c of checks) { if (!by.has(c.item_id)) by.set(c.item_id, []); by.get(c.item_id).push(c); }
    const files = await db.all('SELECT id, item_id, name, size FROM item_files WHERE user_id = ? ORDER BY id', [uid]);
    const fb = new Map();
    for (const f of files) { if (!fb.has(f.item_id)) fb.set(f.item_id, []); fb.get(f.item_id).push(f); }
    return items.map((i) => fmtItem(i, by.get(i.id) || [], fb.get(i.id) || []));
  }
  async function itemOut(id, q = db) {
    const i = await q.get('SELECT * FROM items WHERE id = ?', [id]);
    const checks = await q.all('SELECT * FROM checklist WHERE item_id = ? ORDER BY position, id', [id]);
    const files = await q.all('SELECT id, item_id, name, size FROM item_files WHERE item_id = ? ORDER BY id', [id]);
    return fmtItem(i, checks, files);
  }
  async function userOut(uid) {
    const u = await getUser(uid);
    const tt = u.active_timetable_id ? await db.get('SELECT * FROM timetables WHERE id = ?', [u.active_timetable_id]) : null;
    return fmtUser(u, tt);
  }
  async function timetablesOut(uid) { return (await listTimetables(uid)).map(fmtTimetable); }
  async function fullTimetables(uid) {
    return { user: await userOut(uid), timetables: await timetablesOut(uid), slots: await listSlots(uid), subjects: await listSubjects(uid), schedule: await listSchedule(uid) };
  }
  async function ownTimetable(uid, id) {
    const tt = await db.get('SELECT * FROM timetables WHERE id = ? AND user_id = ?', [Number(id), uid]);
    if (!tt) throw notFound('Horario no encontrado');
    return tt;
  }

  async function createTimetable(q, uid, { name, start_date, end_date, visible_days, background = 'rayas' }, copyFrom) {
    const tt = await q.run('INSERT INTO timetables (user_id, name, start_date, end_date, visible_days, background, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [uid, name, start_date, end_date, JSON.stringify(visible_days), background, nowIso()]);
    const ttId = tt.id;
    if (copyFrom) {
      const slotMap = new Map();
      for (const s of await q.all('SELECT * FROM slots WHERE timetable_id = ? ORDER BY start_time, id', [copyFrom.id])) {
        const r = await q.run('INSERT INTO slots (user_id, timetable_id, start_time, end_time, label, is_break) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
          [uid, ttId, s.start_time, s.end_time, s.label, s.is_break]);
        slotMap.set(s.id, r.id);
      }
      const subjMap = new Map();
      const subs = await q.all('SELECT * FROM subjects WHERE timetable_id = ? ORDER BY (CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END), id', [copyFrom.id]);
      for (const s of subs) {
        const r = await q.run('INSERT INTO subjects (user_id, timetable_id, parent_id, name, short_name, room, teacher, teacher_email, color, start_date, end_date, skip_dates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
          [uid, ttId, s.parent_id ? subjMap.get(s.parent_id) ?? null : null, s.name, s.short_name, s.room, s.teacher, s.teacher_email || '', s.color, s.start_date || null, s.end_date || null, s.skip_dates || '[]']);
        subjMap.set(s.id, r.id);
      }
      const entries = await q.all('SELECT e.* FROM schedule e JOIN slots s ON s.id = e.slot_id WHERE s.timetable_id = ?', [copyFrom.id]);
      for (const e of entries) {
        if (!slotMap.has(e.slot_id) || !subjMap.has(e.subject_id)) continue;
        await q.run('INSERT INTO schedule (user_id, slot_id, day, subject_id, room_override) VALUES (?, ?, ?, ?, ?)',
          [uid, slotMap.get(e.slot_id), e.day, subjMap.get(e.subject_id), e.room_override]);
      }
    } else {
      for (const [a, b, label, brk] of DEFAULT_SLOTS) {
        await q.run('INSERT INTO slots (user_id, timetable_id, start_time, end_time, label, is_break) VALUES (?, ?, ?, ?, ?, ?)', [uid, ttId, a, b, label, brk]);
      }
    }
    return ttId;
  }

  /* ---------- sesiones ---------- */
  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function setCookie(res, value, maxAge) {
    const secure = PROD || process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
  }
  async function startSession(res, uid, days = SESSION_DAYS) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + days * 86400000).toISOString();
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [sha256(token), uid, expires]);
    setCookie(res, token, days * 86400);
  }
  /** Usuario de la sesión actual aunque la petición no la exija (para saber si era un invitado). */
  async function currentUser(req) {
    const uid = await sessionUser(req);
    return uid ? getUser(uid) : null;
  }
  async function sessionUser(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const s = await db.get('SELECT * FROM sessions WHERE token_hash = ?', [sha256(token)]);
    if (!s || s.expires_at < nowIso()) return null;
    const u = await db.get('SELECT suspended_at, last_seen_at FROM users WHERE id = ?', [s.user_id]);
    if (!u || u.suspended_at) return null;
    // Última actividad (como mucho, una escritura cada 10 minutos).
    if (!u.last_seen_at || Date.now() - Date.parse(u.last_seen_at) > 10 * 60000) {
      await db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [nowIso(), s.user_id]).catch(() => {});
    }
    return s.user_id;
  }

  /** Error 403 con el motivo de la suspensión, para que la app se lo enseñe a la persona. */
  const suspendedError = (u) => new HttpError(403, 'Tu cuenta está suspendida.', {
    suspended: { reason: u.suspend_reason || '', at: u.suspended_at, has_account: !u.is_guest },
  });
  /** Si la sesión es de una cuenta suspendida, lanza ese error. */
  async function checkSuspendedSession(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return;
    const s = await db.get('SELECT * FROM sessions WHERE token_hash = ?', [sha256(token)]);
    if (!s || s.expires_at < nowIso()) return;
    const u = await getUser(s.user_id);
    if (u?.suspended_at) throw suspendedError(u);
  }

  /* Límite sencillo de intentos de acceso por IP */
  const attempts = new Map();
  function rateLimit(req) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
    list.push(now);
    attempts.set(ip, list);
    if (list.length > 30) throw new HttpError(429, 'Has hecho demasiados intentos seguidos. Por seguridad, espera 15 minutos y vuelve a probar.');
  }

  /* ============================================================
     Rutas de la API
     ============================================================ */
  const routes = [];
  const route = (method, pattern, handler, { auth = true, maxBody = 1_000_000 } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth, maxBody });
  };

  /* ---------- cuenta ---------- */
  route('POST', '/auth/register', async ({ body, res }) => {
    const name = str(body.name, 80);
    const email = str(body.email, 200).toLowerCase();
    const password = String(body.password || '');
    if (!name) throw bad('Escribe tu nombre');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Escribe un correo electrónico válido');
    if (password.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
    if (body.accept_terms !== true && body.accept_terms !== 'on') throw bad('Para crear la cuenta tienes que aceptar los Términos de uso y la Política de privacidad');
    if (await db.get('SELECT id FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Ya existe una cuenta con ese correo');
    const tz = validTimezone(body.timezone) ? body.timezone : 'Europe/Madrid';
    const uid = await db.tx(async (q) => {
      const u = await q.run('INSERT INTO users (email, name, password_hash, timezone, created_at, accepted_terms_at, terms_version, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
        [email, name, hashPassword(password), tz, nowIso(), nowIso(), TERMS_VERSION, email === SUPERADMIN_EMAIL ? 'superadmin' : 'user']);
      const ttId = await createTimetable(q, u.id, { name: 'Mi horario', start_date: null, end_date: null, visible_days: [1, 2, 3, 4, 5] });
      await q.run('UPDATE users SET active_timetable_id = ? WHERE id = ?', [ttId, u.id]);
      return u.id;
    });
    await startSession(res, uid);
    return { user: await userOut(uid) };
  }, { auth: false });

  /** Empezar sin cuenta: se crea un usuario invitado unido a este dispositivo por la cookie de sesión. */
  const guestHits = new Map();
  route('POST', '/auth/guest', async ({ req, res, body }) => {
    await checkSuspendedSession(req);
    const existing = await currentUser(req);
    if (existing) return { user: await userOut(existing.id) };
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const hits = (guestHits.get(ip) || []).filter((t) => now - t < 60 * 60000);
    if (hits.length >= 20) throw new HttpError(429, 'Demasiados intentos. Espera un rato y vuelve a probar.');
    hits.push(now);
    guestHits.set(ip, hits);
    const tz = validTimezone(body.timezone) ? body.timezone : 'Europe/Madrid';
    const uid = await db.tx(async (q) => {
      const u = await q.run(`INSERT INTO users (email, name, password_hash, timezone, created_at, accepted_terms_at, terms_version, role, is_guest, email_notifications)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 1, 0) RETURNING id`,
      [`${crypto.randomUUID()}@${GUEST_DOMAIN}`, 'Sin cuenta', `guest$${crypto.randomBytes(16).toString('hex')}`, tz, nowIso(), nowIso(), TERMS_VERSION]);
      const ttId = await createTimetable(q, u.id, { name: 'Mi horario', start_date: null, end_date: null, visible_days: [1, 2, 3, 4, 5] });
      await q.run('UPDATE users SET active_timetable_id = ? WHERE id = ?', [ttId, u.id]);
      return u.id;
    });
    await startSession(res, uid, GUEST_SESSION_DAYS);
    return { user: await userOut(uid) };
  }, { auth: false });

  /** Crear cuenta a partir de lo que ya tenías sin cuenta: se conservan todos los datos. */
  route('POST', '/auth/upgrade', async ({ uid, body, res }) => {
    const u = await getUser(uid);
    if (!u.is_guest) throw bad('Ya tienes una cuenta');
    const name = str(body.name, 80);
    const email = str(body.email, 200).toLowerCase();
    const password = String(body.password || '');
    if (!name) throw bad('Escribe tu nombre');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith(`@${GUEST_DOMAIN}`)) throw bad('Escribe un correo electrónico válido');
    if (password.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
    if (body.accept_terms !== true) throw bad('Para crear la cuenta tienes que aceptar los Términos de uso y la Política de privacidad');
    if (await db.get('SELECT id FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Ya existe una cuenta con ese correo. Si es tuya, inicia sesión (lo que tienes sin cuenta en este dispositivo no se puede unir a ella).');
    await db.run(`UPDATE users SET name = ?, email = ?, password_hash = ?, is_guest = 0, email_notifications = 1, accepted_terms_at = ?, terms_version = ?, role = ? WHERE id = ?`,
      [name, email, hashPassword(password), nowIso(), TERMS_VERSION, email === SUPERADMIN_EMAIL ? 'superadmin' : 'user', uid]);
    // Sesión nueva con la duración normal de una cuenta.
    await db.run('DELETE FROM sessions WHERE user_id = ?', [uid]);
    await startSession(res, uid);
    return { user: await userOut(uid) };
  });

  route('POST', '/auth/login', async ({ body, req, res }) => {
    rateLimit(req);
    const email = str(body.email, 200).toLowerCase();
    const password = String(body.password || '');
    // Se indica siempre el motivo exacto por el que no se puede entrar.
    if (!email) throw bad('Escribe tu correo electrónico.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Ese correo no es válido. Revisa que esté bien escrito (por ejemplo, nombre@gmail.com).');
    if (!password) throw bad('Escribe tu contraseña.');
    const u = await db.get('SELECT * FROM users WHERE email = ? AND is_guest = 0', [email]);
    if (!u) throw new HttpError(401, `No hay ninguna cuenta con el correo ${email}. Revisa que esté bien escrito o crea una cuenta.`);
    // Un espacio añadido sin querer al principio o al final (p. ej. por el teclado del móvil) no impide entrar.
    if (!checkPassword(password, u.password_hash) && !(password.trim() !== password && checkPassword(password.trim(), u.password_hash))) throw new HttpError(401, 'La contraseña no es correcta. Revisa mayúsculas y minúsculas, o pulsa «¿Has olvidado tu contraseña?» para crear una nueva.');
    if (u.suspended_at) throw suspendedError(u);
    const prev = await currentUser(req);
    if (prev?.is_guest) await deleteUserData(prev.id);
    await startSession(res, u.id);
    return { user: await userOut(u.id) };
  }, { auth: false });

  /* ---------- Recuperar la contraseña ---------- */
  const RESET_MINUTES = 60;
  const resetHits = new Map();
  route('POST', '/auth/forgot', async ({ body, req }) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const email = str(body.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Escribe un correo válido');
    const now = Date.now();
    for (const key of [`ip:${ip}`, `em:${email}`]) {
      const hits = (resetHits.get(key) || []).filter((t) => now - t < 60 * 60000);
      if (hits.length >= (key.startsWith('ip') ? 10 : 3)) throw new HttpError(429, 'Has pedido demasiados correos. Espera un rato y vuelve a intentarlo.');
      hits.push(now);
      resetHits.set(key, hits);
    }
    const u = await db.get('SELECT * FROM users WHERE email = ? AND is_guest = 0', [email]);
    // Siempre se responde igual, exista o no la cuenta, para no revelar qué correos están registrados.
    if (u && !u.suspended_at) {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.run('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?', [u.id, nowIso()]);
      await db.run('INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [sha256(token), u.id, new Date(now + RESET_MINUTES * 60000).toISOString(), nowIso()]);
      const link = `${appUrl(req).replace(/\/$/, '')}/#restablecer=${token}`;
      const esc = notify.escHtml;
      notify.sendMail({
        to: u.email,
        subject: 'Restablece tu contraseña de Kairos',
        text: `Hola, ${u.name}.\n\nHemos recibido una petición para cambiar la contraseña de tu cuenta de Kairos. Abre este enlace para elegir una nueva (caduca en ${RESET_MINUTES} minutos):\n\n${link}\n\nSi no lo has pedido tú, ignora este correo: tu contraseña no cambiará.`,
        html: notify.mailHtml('Restablece tu contraseña', `<p>Hola, ${esc(u.name)}.</p>
          <p>Hemos recibido una petición para cambiar la contraseña de tu cuenta de Kairos. Pulsa el botón para elegir una nueva. El enlace caduca en ${RESET_MINUTES} minutos.</p>
          <p style="text-align:center;margin:20px 0"><a href="${esc(link)}" style="display:inline-block;background:#2c5f6f;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:600">Elegir nueva contraseña</a></p>
          <p style="color:#6c7478;font-size:13px">Si no lo has pedido tú, ignora este correo: tu contraseña no cambiará.</p>`, appUrl(req), { button: false, footer: 'Recibes este correo porque se ha pedido restablecer la contraseña de tu cuenta de Kairos.' }),
      }).catch((e) => console.error('[correo] recuperar contraseña:', e.message));
    }
    return { ok: true };
  }, { auth: false });

  async function resetRow(token) {
    const row = token ? await db.get('SELECT * FROM password_resets WHERE token_hash = ?', [sha256(String(token))]) : null;
    if (!row || row.expires_at < nowIso()) throw bad('El enlace no es válido o ha caducado. Pide uno nuevo desde «¿Has olvidado tu contraseña?».');
    const u = await getUser(row.user_id);
    if (!u || u.suspended_at) throw bad('El enlace no es válido o ha caducado.');
    return u;
  }
  route('POST', '/auth/reset/check', async ({ body }) => {
    const u = await resetRow(body.token);
    return { email: u.email };
  }, { auth: false });
  route('POST', '/auth/reset', async ({ body, req, res }) => {
    rateLimit(req);
    const u = await resetRow(body.token);
    if (String(body.password || '').length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
    const prev = await currentUser(req);
    if (prev?.is_guest) await deleteUserData(prev.id);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(String(body.password)), u.id]);
    await db.run('DELETE FROM password_resets WHERE user_id = ?', [u.id]);
    await db.run('DELETE FROM sessions WHERE user_id = ?', [u.id]); // se cierran las sesiones abiertas en otros dispositivos
    await startSession(res, u.id);
    return { user: await userOut(u.id) };
  }, { auth: false });

  route('POST', '/auth/logout', async ({ req, res }) => {
    const token = parseCookies(req)[COOKIE];
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
    setCookie(res, '', 0);
    return null;
  }, { auth: false });

  route('GET', '/bootstrap', async ({ uid }) => ({
    ...(await fullTimetables(uid)),
    mail_configured: notify.mailConfigured(),
    push_available: notify.pushAvailable(),
    push_devices: await pushDevices(uid),
  }));

  route('PUT', '/me/settings', async ({ uid, body }) => {
    const sets = [];
    const vals = [];
    const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    if ('name' in body) { const n = str(body.name, 80); if (!n) throw bad('El nombre no puede estar vacío'); set('name', n); }
    if ('timezone' in body) { if (!validTimezone(body.timezone)) throw bad('Zona horaria no válida'); set('timezone', body.timezone); }
    if ('theme' in body) {
      const th = String(body.theme || '').toLowerCase();
      if (!THEMES.includes(th) && !/^custom:#[0-9a-f]{6}$/.test(th)) throw bad('Apariencia no válida');
      set('theme', th);
    }
    if ('email_notifications' in body) {
      if (body.email_notifications && (await getUser(uid)).is_guest) throw bad('Crea una cuenta para recibir avisos por correo');
      set('email_notifications', bool(body.email_notifications));
    }
    if ('default_reminder_minutes' in body) set('default_reminder_minutes', reminderValue(body.default_reminder_minutes));
    if ('daily_digest' in body) set('daily_digest', bool(body.daily_digest));
    if ('digest_hour' in body) {
      const h = Number(body.digest_hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) throw bad('Hora no válida');
      set('digest_hour', h);
    }
    if ('active_timetable_id' in body) { await ownTimetable(uid, body.active_timetable_id); set('active_timetable_id', Number(body.active_timetable_id)); }
    if (sets.length) await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...vals, uid]);
    return { user: await userOut(uid) };
  });

  route('PUT', '/me/password', async ({ uid, body }) => {
    const u = await getUser(uid);
    if (u.is_guest) throw bad('Para esto necesitas crear una cuenta.');
    if (!checkPassword(String(body.current || ''), u.password_hash)) throw bad('La contraseña actual no es correcta');
    if (String(body.password || '').length < 8) throw bad('La nueva contraseña debe tener al menos 8 caracteres');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(String(body.password)), uid]);
    return { ok: true };
  });

  route('PUT', '/me/email', async ({ uid, body }) => {
    const u = await getUser(uid);
    if (u.is_guest) throw bad('Para esto necesitas crear una cuenta.');
    if (!checkPassword(String(body.password || ''), u.password_hash)) throw bad('La contraseña no es correcta');
    if (u.role === 'superadmin') throw bad('El correo de la superadministradora está fijado en la configuración del servidor y no se puede cambiar desde aquí.');
    const email = str(body.email, 200).toLowerCase();
    if (email === SUPERADMIN_EMAIL) throw new HttpError(409, 'Ya existe una cuenta con ese correo');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Escribe un correo electrónico válido');
    if (email === u.email) return { user: await userOut(uid) };
    if (await db.get('SELECT id FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Ya existe una cuenta con ese correo');
    await db.run('UPDATE users SET email = ? WHERE id = ?', [email, uid]);
    return { user: await userOut(uid) };
  });

  /** Borra una cuenta y todos sus datos. */
  async function deleteUserData(uid) {
    // La cuenta de la superadministradora no se borra nunca desde la app (solo cambiando el código o la base de datos).
    const target = await getUser(uid);
    if (!target) return;
    if (target.role === 'superadmin' || target.email === SUPERADMIN_EMAIL) throw new HttpError(403, 'La cuenta de la superadministradora no se puede eliminar.');
    await db.tx(async (q) => {
      await q.run('DELETE FROM checklist WHERE item_id IN (SELECT id FROM items WHERE user_id = ?)', [uid]);
      for (const t of ['items', 'events', 'schedule', 'subjects', 'slots', 'timetables', 'push_subscriptions', 'sessions', 'password_resets', 'item_files']) {
        await q.run(`DELETE FROM ${t} WHERE user_id = ?`, [uid]);
      }
      await q.run('UPDATE contact_messages SET user_id = NULL WHERE user_id = ?', [uid]);
      await q.run('DELETE FROM users WHERE id = ?', [uid]);
    });
  }

  /* ============================================================
     Panel de administración
     ============================================================ */
  const isAdmin = (u) => u && (u.role === 'admin' || u.role === 'superadmin');
  async function requireAdmin(uid) {
    const u = await getUser(uid);
    if (!isAdmin(u)) throw new HttpError(403, 'Solo para administración');
    return u;
  }
  async function requireSuper(uid) {
    const u = await getUser(uid);
    if (!u || u.role !== 'superadmin') throw new HttpError(403, 'Solo la superadministradora puede hacer esto');
    return u;
  }
  async function logAdmin(admin, action, target, detail = '') {
    await db.run('INSERT INTO admin_log (admin_id, admin_name, action, target_user_id, target_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [admin.id, admin.name, action, target?.id ?? null, target ? (target.is_guest ? `Sin cuenta (#${target.id})` : `${target.name} <${target.email}>`) : '', detail, nowIso()]);
  }
  /** Comprueba que el admin puede actuar sobre esa cuenta: nunca sobre sí mismo ni sobre la superadmin; sobre otros admins, solo la superadmin. */
  async function targetUser(admin, id) {
    const t = await getUser(Number(id));
    if (!t) throw notFound('Usuario no encontrado');
    if (t.id === admin.id) throw bad('No puedes hacer esto con tu propia cuenta desde el panel');
    if (t.role === 'superadmin') throw new HttpError(403, 'La cuenta de la superadministradora está protegida');
    if (t.role === 'admin' && admin.role !== 'superadmin') throw new HttpError(403, 'Solo la superadministradora puede actuar sobre otros administradores');
    return t;
  }
  const qs = (req) => new URL(req.url, 'http://x').searchParams;
  const count = async (sql, params = []) => Number((await db.get(sql, params))?.n || 0);
  const adminUserRow = (u, c = {}) => ({
    id: u.id, name: u.is_guest ? 'Sin cuenta' : u.name, email: u.is_guest ? '' : u.email, is_guest: Boolean(u.is_guest), role: u.role || 'user',
    created_at: u.created_at, last_seen_at: u.last_seen_at || null, suspended_at: u.suspended_at || null, suspend_reason: u.suspend_reason || '',
    delete_suggested_at: u.delete_suggested_at || null, delete_suggested_by: u.delete_suggested_by || '', delete_suggested_reason: u.delete_suggested_reason || '',
    avatar_url: u.avatar_updated ? `/api/admin/users/${u.id}/avatar?v=${encodeURIComponent(u.avatar_updated)}` : null,
    timetables: Number(c.timetables || 0), tasks: Number(c.tasks || 0), exams: Number(c.exams || 0), events: Number(c.events || 0),
  });

  route('GET', '/admin/stats', async ({ uid }) => {
    await requireAdmin(uid);
    const now = Date.now();
    const ago = (d) => new Date(now - d * 86400000).toISOString();
    const signups = await db.all('SELECT created_at FROM users WHERE created_at >= ?', [ago(30)]);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
    const perDay = {};
    for (let i = 29; i >= 0; i--) perDay[fmt.format(new Date(now - i * 86400000))] = 0;
    for (const r of signups) { const k = fmt.format(new Date(r.created_at)); if (k in perDay) perDay[k]++; }
    return {
      users: {
        total: await count('SELECT COUNT(*) AS n FROM users WHERE is_guest = 0'),
        guests: await count('SELECT COUNT(*) AS n FROM users WHERE is_guest = 1'),
        admins: await count("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin', 'superadmin')"),
        suspended: await count('SELECT COUNT(*) AS n FROM users WHERE suspended_at IS NOT NULL'),
        delete_suggested: await count('SELECT COUNT(*) AS n FROM users WHERE delete_suggested_at IS NOT NULL'),
        new7: await count('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', [ago(7)]),
        guests_active7: await count('SELECT COUNT(*) AS n FROM users WHERE is_guest = 1 AND last_seen_at >= ?', [ago(7)]),
        new30: signups.length,
        active7: await count('SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?', [ago(7)]),
        active30: await count('SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?', [ago(30)]),
        with_push: await count('SELECT COUNT(DISTINCT user_id) AS n FROM push_subscriptions'),
        email_on: await count('SELECT COUNT(*) AS n FROM users WHERE email_notifications = 1'),
      },
      content: {
        timetables: await count('SELECT COUNT(*) AS n FROM timetables'),
        subjects: await count('SELECT COUNT(*) AS n FROM subjects'),
        tasks: await count("SELECT COUNT(*) AS n FROM items WHERE type = 'task'"),
        exams: await count("SELECT COUNT(*) AS n FROM items WHERE type = 'exam'"),
        done: await count('SELECT COUNT(*) AS n FROM items WHERE done = 1'),
        events: await count('SELECT COUNT(*) AS n FROM events'),
      },
      messages_open: await count('SELECT COUNT(*) AS n FROM contact_messages WHERE resolved_at IS NULL'),
      signups_per_day: Object.entries(perDay).map(([date, n]) => ({ date, n })),
      system: {
        database: db.kind === 'postgres' ? 'PostgreSQL' : 'SQLite',
        mail: notify.mailConfigured(),
        mail_provider: process.env.BREVO_API_KEY ? 'Brevo' : process.env.RESEND_API_KEY ? 'Resend' : process.env.SMTP_HOST ? 'SMTP' : null,
        push: notify.pushAvailable(),
        node: process.version,
        uptime_s: Math.round(process.uptime()),
      },
    };
  });

  route('GET', '/admin/users', async ({ uid, req }) => {
    await requireAdmin(uid);
    const p = qs(req);
    const q = (p.get('q') || '').trim().toLowerCase().slice(0, 100);
    const filter = p.get('filter') || 'all';
    const where = [];
    const params = [];
    if (q) { where.push('(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (filter === 'admins') where.push("u.role IN ('admin', 'superadmin')");
    if (filter === 'suspended') where.push('u.suspended_at IS NOT NULL');
    if (filter === 'delete_suggested') where.push('u.delete_suggested_at IS NOT NULL');
    if (filter === 'accounts') where.push('u.is_guest = 0');
    if (filter === 'guests') where.push('u.is_guest = 1');
    if (filter === 'active') where.push('u.last_seen_at >= ?'), params.push(new Date(Date.now() - 7 * 86400000).toISOString());
    const sql = `SELECT u.id, u.name, u.email, u.role, u.is_guest, u.created_at, u.last_seen_at, u.suspended_at, u.suspend_reason,
        u.delete_suggested_at, u.delete_suggested_by, u.delete_suggested_reason, u.avatar_updated,
        (SELECT COUNT(*) FROM timetables t WHERE t.user_id = u.id) AS timetables,
        (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id AND i.type = 'task') AS tasks,
        (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id AND i.type = 'exam') AS exams,
        (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id) AS events
      FROM users u ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE u.role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.is_guest, u.created_at DESC LIMIT 300`;
    const rows = await db.all(sql, params);
    return rows.map((r) => adminUserRow(r, r));
  });

  route('GET', '/admin/users/:id', async ({ uid, params }) => {
    await requireAdmin(uid);
    const u = await getUser(Number(params.id));
    if (!u) throw notFound('Usuario no encontrado');
    const c = await db.get(`SELECT
        (SELECT COUNT(*) FROM timetables WHERE user_id = ?) AS timetables,
        (SELECT COUNT(*) FROM items WHERE user_id = ? AND type = 'task') AS tasks,
        (SELECT COUNT(*) FROM items WHERE user_id = ? AND type = 'exam') AS exams,
        (SELECT COUNT(*) FROM events WHERE user_id = ?) AS events`, [u.id, u.id, u.id, u.id]);
    return {
      ...adminUserRow(u, c),
      timezone: u.timezone,
      subjects: await count('SELECT COUNT(*) AS n FROM subjects WHERE user_id = ?', [u.id]),
      push_devices: await count('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [u.id]),
      sessions: await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?', [u.id, nowIso()]),
      email_notifications: Boolean(u.email_notifications),
      daily_digest: Boolean(u.daily_digest),
      accepted_terms_at: u.accepted_terms_at || null,
      messages: await count('SELECT COUNT(*) AS n FROM contact_messages WHERE user_id = ? OR email = ?', [u.id, u.email]),
    };
  });

  route('GET', '/admin/users/:id/avatar', async ({ uid, params }) => {
    await requireAdmin(uid);
    const u = await getUser(Number(params.id));
    const m = u?.avatar_data && u.avatar_data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw notFound('Sin foto');
    return { __binary: Buffer.from(m[2], 'base64'), type: m[1] };
  });

  route('PUT', '/admin/users/:id/role', async ({ uid, params, body }) => {
    const admin = await requireSuper(uid);
    const t = await targetUser(admin, params.id);
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (t.is_guest && role === 'admin') throw bad('Una persona sin cuenta no puede ser administradora');
    if (t.suspended_at && role === 'admin') throw bad('Reactiva la cuenta antes de hacerla administradora');
    await db.run('UPDATE users SET role = ? WHERE id = ?', [role, t.id]);
    await logAdmin(admin, role === 'admin' ? 'Nombrar administrador' : 'Quitar administrador', t);
    return { ok: true };
  });

  route('PUT', '/admin/users/:id/suspend', async ({ uid, params, body, req }) => {
    const admin = await requireAdmin(uid);
    const t = await targetUser(admin, params.id);
    const suspend = body.suspended === true;
    const reason = str(body.reason, 500);
    if (suspend) {
      // El motivo es obligatorio: es lo que verá la persona al intentar entrar.
      if (reason.length < 5) throw bad('Escribe el motivo de la suspensión. La persona lo verá al entrar.');
      await db.run('UPDATE users SET suspended_at = ?, suspend_reason = ? WHERE id = ?', [nowIso(), reason, t.id]);
      if (!t.is_guest) {
        const base = appUrl(req).replace(/\/$/, '');
        const esc = notify.escHtml;
        notify.sendMail({
          to: t.email,
          subject: 'Tu cuenta de Kairos está suspendida',
          text: `Hola, ${t.name}.\n\nTu cuenta de Kairos se ha suspendido por este motivo:\n\n${reason}\n\nMientras esté suspendida no podrás entrar, pero tus datos se conservan. Si crees que es un error o quieres reclamar, escríbenos desde el formulario de contacto eligiendo «Reclamar una suspensión»:\n${base}/contacto.html?tema=Reclamar`,
          html: notify.mailHtml('Tu cuenta está suspendida', `<p>Hola, ${esc(t.name)}.</p>
            <p>Tu cuenta de Kairos se ha suspendido por este motivo:</p>
            <blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #b9432c;background:#f6f4ef;border-radius:6px">${esc(reason)}</blockquote>
            <p>Mientras esté suspendida no podrás entrar, pero tus datos se conservan.</p>
            <p>Si crees que es un error o quieres reclamar, escríbenos:</p>
            <p style="text-align:center;margin:18px 0"><a href="${esc(base)}/contacto.html?tema=Reclamar" style="display:inline-block;background:#2c5f6f;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:600">Reclamar la suspensión</a></p>`,
          base, { button: false, footer: 'Recibes este correo porque se ha suspendido tu cuenta de Kairos.' }),
        }).catch((e) => console.error('[correo] suspensión:', e.message));
      }
    } else {
      await db.run('UPDATE users SET suspended_at = NULL, suspend_reason = NULL WHERE id = ?', [t.id]);
    }
    await logAdmin(admin, suspend ? 'Suspender cuenta' : 'Reactivar cuenta', t, reason);
    return { ok: true };
  });

  /* Los administradores sugieren eliminar una cuenta; solo la superadministradora la elimina. */
  route('POST', '/admin/users/:id/suggest-delete', async ({ uid, params, body }) => {
    const admin = await requireAdmin(uid);
    const t = await targetUser(admin, params.id);
    const reason = str(body.reason, 500);
    if (reason.length < 5) throw bad('Explica por qué sugieres eliminar esta cuenta.');
    await db.run('UPDATE users SET delete_suggested_at = ?, delete_suggested_by = ?, delete_suggested_reason = ? WHERE id = ?', [nowIso(), admin.name, reason, t.id]);
    await logAdmin(admin, 'Sugerir eliminación', t, reason);
    return { ok: true };
  });
  route('DELETE', '/admin/users/:id/suggest-delete', async ({ uid, params }) => {
    const admin = await requireAdmin(uid);
    const t = await targetUser(admin, params.id);
    await db.run('UPDATE users SET delete_suggested_at = NULL, delete_suggested_by = NULL, delete_suggested_reason = NULL WHERE id = ?', [t.id]);
    await logAdmin(admin, admin.role === 'superadmin' ? 'Descartar sugerencia de eliminación' : 'Retirar sugerencia de eliminación', t);
    return { ok: true };
  });

  route('POST', '/admin/users/:id/logout', async ({ uid, params }) => {
    const admin = await requireAdmin(uid);
    const t = await targetUser(admin, params.id);
    await db.run('DELETE FROM sessions WHERE user_id = ?', [t.id]);
    await logAdmin(admin, 'Cerrar sesiones', t);
    return { ok: true };
  });

  route('DELETE', '/admin/users/:id', async ({ uid, params, body }) => {
    const admin = await requireSuper(uid);
    if (!checkPassword(String(body.password || ''), admin.password_hash)) throw bad('Tu contraseña no es correcta');
    const t = await targetUser(admin, params.id);
    await logAdmin(admin, 'Eliminar cuenta', t, str(body.reason, 300));
    await deleteUserData(t.id);
    return { ok: true };
  });

  route('GET', '/admin/messages', async ({ uid, req }) => {
    await requireAdmin(uid);
    const status = qs(req).get('status') || 'open';
    const where = status === 'open' ? 'WHERE resolved_at IS NULL' : status === 'resolved' ? 'WHERE resolved_at IS NOT NULL' : '';
    return db.all(`SELECT id, user_id, name, email, topic, message, emailed, created_at, resolved_at FROM contact_messages ${where} ORDER BY created_at DESC LIMIT 300`);
  });
  route('PUT', '/admin/messages/:id', async ({ uid, params, body }) => {
    const admin = await requireAdmin(uid);
    const m = await db.get('SELECT * FROM contact_messages WHERE id = ?', [Number(params.id)]);
    if (!m) throw notFound('Mensaje no encontrado');
    await db.run('UPDATE contact_messages SET resolved_at = ? WHERE id = ?', [body.resolved ? nowIso() : null, m.id]);
    await logAdmin(admin, body.resolved ? 'Mensaje atendido' : 'Mensaje reabierto', null, `${m.name}: ${m.topic}`);
    return { ok: true };
  });
  route('DELETE', '/admin/messages/:id', async ({ uid, params }) => {
    const admin = await requireAdmin(uid);
    const m = await db.get('SELECT * FROM contact_messages WHERE id = ?', [Number(params.id)]);
    if (!m) throw notFound('Mensaje no encontrado');
    await db.run('DELETE FROM contact_messages WHERE id = ?', [m.id]);
    await logAdmin(admin, 'Borrar mensaje', null, `${m.name}: ${m.topic}`);
    return { ok: true };
  });

  route('GET', '/admin/log', async ({ uid }) => {
    await requireAdmin(uid);
    return db.all('SELECT * FROM admin_log ORDER BY created_at DESC, id DESC LIMIT 300');
  });

  route('POST', '/admin/test-email', async ({ uid, req }) => {
    const admin = await requireAdmin(uid);
    await notify.sendMail({
      to: admin.email,
      subject: 'Prueba del panel de administración de Kairos',
      text: 'El envío de correos de Kairos funciona.',
      html: notify.mailHtml('El correo funciona', '<p>Este es un correo de prueba enviado desde el panel de administración.</p>', appUrl(req)),
    });
    return { mail_configured: notify.mailConfigured() };
  });

  /* ---------- foto de perfil ---------- */
  const AVATAR_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
  route('GET', '/me/avatar', async ({ uid }) => {
    const u = await getUser(uid);
    const m = u.avatar_data && u.avatar_data.match(AVATAR_RE);
    if (!m) throw notFound('No tienes foto de perfil');
    return { __binary: Buffer.from(m[2], 'base64'), type: m[1] };
  });
  route('PUT', '/me/avatar', async ({ uid, body }) => {
    const img = String(body.image || '');
    const m = img.match(AVATAR_RE);
    if (!m) throw bad('La imagen no es válida. Usa una foto JPG, PNG o WebP.');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 300 * 1024) throw bad('La foto es demasiado grande');
    // Comprobación de la firma del archivo para no guardar algo que no sea una imagen.
    const sig = bytes.subarray(0, 12);
    const isJpeg = sig[0] === 0xff && sig[1] === 0xd8;
    const isPng = sig.subarray(0, 4).toString('hex') === '89504e47';
    const isWebp = sig.subarray(0, 4).toString() === 'RIFF' && sig.subarray(8, 12).toString() === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) throw bad('La imagen no es válida. Usa una foto JPG, PNG o WebP.');
    await db.run('UPDATE users SET avatar_data = ?, avatar_updated = ? WHERE id = ?', [img, String(Date.now()), uid]);
    return { user: await userOut(uid) };
  });
  route('DELETE', '/me/avatar', async ({ uid }) => {
    await db.run('UPDATE users SET avatar_data = NULL, avatar_updated = NULL WHERE id = ?', [uid]);
    return { user: await userOut(uid) };
  });

  /** Derecho de acceso y portabilidad: todos los datos de la cuenta en un archivo JSON. */
  route('GET', '/me/export', async ({ uid }) => {
    const u = await getUser(uid);
    if (u.is_guest) throw bad('Para descargar tus datos necesitas crear una cuenta.');
    return {
      exported_at: nowIso(),
      app: 'Kairos',
      account: {
        name: u.name, email: u.is_guest ? null : u.email, without_account: Boolean(u.is_guest), timezone: u.timezone, created_at: u.created_at,
        accepted_terms_at: u.accepted_terms_at || null, terms_version: u.terms_version || null,
        profile_photo: u.avatar_data || null,
        email_notifications: Boolean(u.email_notifications), default_reminder_minutes: u.default_reminder_minutes ?? null,
        daily_digest: Boolean(u.daily_digest), digest_hour: u.digest_hour,
      },
      timetables: await timetablesOut(uid),
      slots: await listSlots(uid),
      subjects: await listSubjects(uid),
      schedule: await listSchedule(uid),
      items: await listItems(uid),
      events: await listEvents(uid),
      push_devices: await pushDevices(uid),
    };
  });

  /** Derecho de supresión: borra la cuenta y todos sus datos. */
  route('DELETE', '/me', async ({ uid, body, res }) => {
    const u = await getUser(uid);
    if (!u.is_guest && !checkPassword(String(body.password || ''), u.password_hash)) throw bad('La contraseña no es correcta');
    if (u.role === 'superadmin') throw bad('La cuenta de la superadministradora no se puede eliminar desde la app.');
    await deleteUserData(uid);
    setCookie(res, '', 0);
    return null;
  });

  /* ---------- formulario de contacto (sin mostrar ningún correo en la web) ---------- */
  const contactHits = new Map();
  route('POST', '/contact', async ({ body, req, uid }) => {
    // Trampa para robots: un campo oculto que las personas no rellenan, y un tiempo mínimo para escribir.
    if (body.website || (Number(body.elapsed_ms) > 0 && Number(body.elapsed_ms) < 2500)) return { ok: true };
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const hits = (contactHits.get(ip) || []).filter((t) => now - t < 60 * 60000);
    if (hits.length >= 5) throw new HttpError(429, 'Has enviado varios mensajes seguidos. Vuelve a intentarlo dentro de un rato.');
    const name = str(body.name, 80);
    const email = str(body.email, 200).toLowerCase();
    const topic = str(body.topic, 60) || 'Otro';
    const message = String(body.message ?? '').trim().slice(0, 5000);
    if (!name) throw bad('Escribe tu nombre');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Escribe un correo electrónico válido para poder responderte');
    if (message.length < 10) throw bad('Cuéntanos un poco más (mínimo 10 caracteres)');
    if (body.accept_privacy !== true) throw bad('Tienes que aceptar la Política de privacidad para enviar el mensaje');
    hits.push(now);
    contactHits.set(ip, hits);
    const saved = await db.run('INSERT INTO contact_messages (user_id, name, email, topic, message, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      [uid || null, name, email, topic, message, nowIso()]);
    try {
      await notify.sendMail({
        to: notify.contactInbox(),
        replyTo: email,
        subject: `[Kairos · ${topic}] Mensaje de ${name}`,
        text: `De: ${name} <${email}>${uid ? ' (usuario registrado)' : ''}\nTema: ${topic}\n\n${message}\n\nResponde a este correo para contestar directamente.`,
        html: notify.mailHtml(`Nuevo mensaje: ${topic}`,
          `<p style="margin:0 0 4px"><b>De:</b> ${notify.escHtml(name)} &lt;${notify.escHtml(email)}&gt;${uid ? ' · usuario registrado' : ''}</p>
           <p style="margin:0 0 14px"><b>Tema:</b> ${notify.escHtml(topic)}</p>
           <div style="white-space:pre-wrap;background:#f6f4ef;border-radius:8px;padding:12px 14px">${notify.escHtml(message)}</div>
           <p style="color:#6c7478;font-size:13px;margin:14px 0 0">Pulsa «Responder» en tu correo para contestar directamente a ${notify.escHtml(name)}.</p>`, appUrl(req)),
      });
      await db.run('UPDATE contact_messages SET emailed = 1 WHERE id = ?', [saved.id]);
    } catch (e) {
      console.error('[contacto] no se pudo enviar el aviso por correo; el mensaje queda guardado', e.message);
    }
    return { ok: true };
  }, { auth: false });

  route('POST', '/me/test-email', async ({ uid, req }) => {
    const u = await getUser(uid);
    if (u.is_guest) throw bad('Para esto necesitas crear una cuenta.');
    await notify.sendMail({
      to: u.email,
      subject: 'Correo de prueba de Kairos',
      text: `Hola, ${u.name}. Si lees esto, los avisos por correo de Kairos funcionan.`,
      html: notify.mailHtml('Todo listo', `<p>Hola, ${notify.escHtml(u.name)}. Si lees esto, los avisos por correo de Kairos funcionan.</p>`, appUrl(req)),
    });
    return { mail_configured: notify.mailConfigured() };
  });

  /* ---------- horarios ---------- */
  route('POST', '/timetables', async ({ uid, body }) => {
    const name = str(body.name, 120);
    if (!name) throw bad('Escribe un nombre para el horario');
    const data = { name, start_date: optDate(body.start_date), end_date: optDate(body.end_date), visible_days: daysValue(body.visible_days || [1, 2, 3, 4, 5]) };
    if (data.start_date && data.end_date && data.end_date < data.start_date) throw bad('La fecha final debe ser posterior a la inicial');
    const copyFrom = body.copy_from ? await ownTimetable(uid, body.copy_from) : null;
    if (copyFrom) data.background = copyFrom.background;
    await db.tx(async (q) => {
      const id = await createTimetable(q, uid, data, copyFrom);
      await q.run('UPDATE users SET active_timetable_id = ? WHERE id = ?', [id, uid]);
    });
    await placeEvents(uid);
    return fullTimetables(uid);
  });

  route('PUT', '/timetables/:id', async ({ uid, body, params }) => {
    const tt = await ownTimetable(uid, params.id);
    const next = {
      name: 'name' in body ? str(body.name, 120) : tt.name,
      start_date: 'start_date' in body ? optDate(body.start_date) : tt.start_date,
      end_date: 'end_date' in body ? optDate(body.end_date) : tt.end_date,
      visible_days: 'visible_days' in body ? JSON.stringify(daysValue(body.visible_days)) : tt.visible_days,
      background: 'background' in body ? body.background : tt.background,
    };
    if (!next.name) throw bad('Escribe un nombre para el horario');
    if (!BACKGROUNDS.includes(next.background)) throw bad('Fondo no válido');
    if (next.start_date && next.end_date && next.end_date < next.start_date) throw bad('La fecha final debe ser posterior a la inicial');
    await db.run('UPDATE timetables SET name = ?, start_date = ?, end_date = ?, visible_days = ?, background = ? WHERE id = ?',
      [next.name, next.start_date, next.end_date, next.visible_days, next.background, tt.id]);
    if (next.start_date !== tt.start_date || next.end_date !== tt.end_date) await placeEvents(uid);
    return timetablesOut(uid);
  });

  route('DELETE', '/timetables/:id', async ({ uid, params }) => {
    const tt = await ownTimetable(uid, params.id);
    const all = await listTimetables(uid);
    if (all.length < 2) throw bad('No puedes eliminar tu único horario');
    await db.tx(async (q) => {
      await q.run('DELETE FROM schedule WHERE slot_id IN (SELECT id FROM slots WHERE timetable_id = ?)', [tt.id]);
      await q.run('DELETE FROM slots WHERE timetable_id = ?', [tt.id]);
      await q.run('DELETE FROM subjects WHERE timetable_id = ?', [tt.id]);
      await q.run('DELETE FROM checklist WHERE item_id IN (SELECT id FROM items WHERE timetable_id = ?)', [tt.id]);
      await q.run('DELETE FROM item_files WHERE item_id IN (SELECT id FROM items WHERE timetable_id = ?)', [tt.id]);
      await q.run('DELETE FROM items WHERE timetable_id = ?', [tt.id]);
      await q.run('DELETE FROM events WHERE timetable_id = ?', [tt.id]);
      await q.run('DELETE FROM timetables WHERE id = ?', [tt.id]);
      const u = await q.get('SELECT active_timetable_id FROM users WHERE id = ?', [uid]);
      if (u.active_timetable_id === tt.id) {
        await q.run('UPDATE users SET active_timetable_id = ? WHERE id = ?', [all.find((t) => t.id !== tt.id).id, uid]);
      }
    });
    return fullTimetables(uid);
  });

  /* ---------- tramos ---------- */
  function slotData(body, prev = {}) {
    const d = {
      start_time: 'start_time' in body ? String(body.start_time) : prev.start_time,
      end_time: 'end_time' in body ? String(body.end_time) : prev.end_time,
      label: 'label' in body ? str(body.label, 60) : prev.label ?? '',
      is_break: 'is_break' in body ? bool(body.is_break) : prev.is_break ?? 0,
    };
    if (!TIME_RE.test(d.start_time) || !TIME_RE.test(d.end_time)) throw bad('Indica la hora de inicio y de fin');
    if (d.end_time <= d.start_time) throw bad('La hora de fin debe ser posterior a la de inicio');
    return d;
  }
  route('POST', '/slots', async ({ uid, body }) => {
    const tt = await ownTimetable(uid, body.timetable_id);
    const d = slotData(body);
    await db.run('INSERT INTO slots (user_id, timetable_id, start_time, end_time, label, is_break) VALUES (?, ?, ?, ?, ?, ?)',
      [uid, tt.id, d.start_time, d.end_time, d.label, d.is_break]);
    return listSlots(uid);
  });
  route('PUT', '/slots/:id', async ({ uid, body, params }) => {
    const s = await db.get('SELECT * FROM slots WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!s) throw notFound('Tramo no encontrado');
    const d = slotData(body, s);
    await db.run('UPDATE slots SET start_time = ?, end_time = ?, label = ?, is_break = ? WHERE id = ?', [d.start_time, d.end_time, d.label, d.is_break, s.id]);
    if (d.is_break) await db.run('DELETE FROM schedule WHERE slot_id = ?', [s.id]);
    return listSlots(uid);
  });
  route('DELETE', '/slots/:id', async ({ uid, params }) => {
    const s = await db.get('SELECT * FROM slots WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!s) throw notFound('Tramo no encontrado');
    await db.tx(async (q) => {
      await q.run('DELETE FROM schedule WHERE slot_id = ?', [s.id]);
      await q.run('DELETE FROM slots WHERE id = ?', [s.id]);
    });
    return listSlots(uid);
  });

  /* ---------- clases del horario ---------- */
  route('GET', '/schedule', ({ uid }) => listSchedule(uid));
  route('PUT', '/schedule/bulk', async ({ uid, body }) => {
    const cells = Array.isArray(body.cells) ? body.cells.slice(0, 500) : [];
    if (!cells.length) throw bad('No hay casillas seleccionadas');
    const subjectId = body.subject_id === null || body.subject_id === undefined || body.subject_id === '' ? null : Number(body.subject_id);
    const subject = subjectId ? await db.get('SELECT * FROM subjects WHERE id = ? AND user_id = ?', [subjectId, uid]) : null;
    if (subjectId && !subject) throw notFound('Asignatura no encontrada');
    const room = str(body.room_override, 60);
    await db.tx(async (q) => {
      for (const c of cells) {
        const day = Number(c.day);
        if (!Number.isInteger(day) || day < 0 || day > 6) throw bad('Día no válido');
        const slot = await q.get('SELECT * FROM slots WHERE id = ? AND user_id = ?', [Number(c.slot_id), uid]);
        if (!slot) throw notFound('Tramo no encontrado');
        if (slot.is_break) continue;
        const prev = await q.get('SELECT * FROM schedule WHERE slot_id = ? AND day = ?', [slot.id, day]);
        if (!subject) {
          if (prev) await q.run('DELETE FROM schedule WHERE id = ?', [prev.id]);
          continue;
        }
        if (subject.timetable_id !== slot.timetable_id) throw bad('La asignatura es de otro horario');
        const roomValue = body.keep_room ? prev?.room_override || '' : room;
        if (prev) await q.run('UPDATE schedule SET subject_id = ?, room_override = ? WHERE id = ?', [subject.id, roomValue, prev.id]);
        else await q.run('INSERT INTO schedule (user_id, slot_id, day, subject_id, room_override) VALUES (?, ?, ?, ?, ?)', [uid, slot.id, day, subject.id, roomValue]);
      }
    });
    return listSchedule(uid);
  });

  /* ---------- asignaturas ---------- */
  function subjectData(body, prev = {}) {
    const d = {
      name: 'name' in body ? str(body.name, 120) : prev.name,
      short_name: 'short_name' in body ? str(body.short_name, 12) : prev.short_name ?? '',
      room: 'room' in body ? str(body.room, 60) : prev.room ?? '',
      teacher: 'teacher' in body ? str(body.teacher, 120) : prev.teacher ?? '',
      teacher_email: 'teacher_email' in body ? str(body.teacher_email, 200).toLowerCase() : prev.teacher_email ?? '',
      skip_dates: 'skip_dates' in body
        ? JSON.stringify([...new Set((Array.isArray(body.skip_dates) ? body.skip_dates : []).map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().slice(0, 400))
        : prev.skip_dates ?? '[]',
      color: 'color' in body ? String(body.color) : prev.color,
      start_date: 'start_date' in body ? optDate(body.start_date) : prev.start_date ?? null,
      end_date: 'end_date' in body ? optDate(body.end_date) : prev.end_date ?? null,
    };
    if (!d.name) throw bad('Escribe el nombre de la asignatura');
    if (d.teacher_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.teacher_email)) throw bad('El correo del profesor/a no es válido');
    if (d.start_date && d.end_date && d.end_date < d.start_date) throw bad('La fecha de fin debe ser posterior a la de inicio');
    if (!COLOR_RE.test(d.color || '')) throw bad('Color no válido');
    d.color = d.color.toLowerCase();
    return d;
  }
  route('POST', '/subjects', async ({ uid, body }) => {
    const d = subjectData(body);
    let ttId;
    let parentId = null;
    if (body.parent_id) {
      const parent = await db.get('SELECT * FROM subjects WHERE id = ? AND user_id = ?', [Number(body.parent_id), uid]);
      if (!parent) throw notFound('Asignatura no encontrada');
      if (parent.parent_id) throw bad('Una subasignatura no puede tener subasignaturas');
      parentId = parent.id;
      ttId = parent.timetable_id;
    } else {
      ttId = (await ownTimetable(uid, body.timetable_id)).id;
    }
    const r = await db.run('INSERT INTO subjects (user_id, timetable_id, parent_id, name, short_name, room, teacher, teacher_email, color, start_date, end_date, skip_dates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [uid, ttId, parentId, d.name, d.short_name, d.room, d.teacher, d.teacher_email, d.color, d.start_date, d.end_date, d.skip_dates]);
    return fmtSubject(await db.get('SELECT * FROM subjects WHERE id = ?', [r.id]));
  });
  route('PUT', '/subjects/:id', async ({ uid, body, params }) => {
    const s = await db.get('SELECT * FROM subjects WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!s) throw notFound('Asignatura no encontrada');
    const d = subjectData(body, s);
    await db.run('UPDATE subjects SET name = ?, short_name = ?, room = ?, teacher = ?, teacher_email = ?, color = ?, start_date = ?, end_date = ?, skip_dates = ? WHERE id = ?', [d.name, d.short_name, d.room, d.teacher, d.teacher_email, d.color, d.start_date, d.end_date, d.skip_dates, s.id]);
    return fmtSubject(await db.get('SELECT * FROM subjects WHERE id = ?', [s.id]));
  });
  route('DELETE', '/subjects/:id', async ({ uid, params }) => {
    const s = await db.get('SELECT * FROM subjects WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!s) throw notFound('Asignatura no encontrada');
    const ids = [s.id, ...(await db.all('SELECT id FROM subjects WHERE parent_id = ?', [s.id])).map((x) => x.id)];
    await db.tx(async (q) => {
      for (const id of ids) {
        await q.run('DELETE FROM schedule WHERE subject_id = ?', [id]);
        await q.run('UPDATE items SET subject_id = NULL WHERE subject_id = ?', [id]);
        await q.run('DELETE FROM subjects WHERE id = ?', [id]);
      }
    });
    return { ok: true };
  });

  /* ---------- tareas y exámenes ---------- */
  async function itemData(uid, body, prev) {
    const has = (k) => k in body;
    const d = {
      type: has('type') ? (body.type === 'exam' ? 'exam' : 'task') : prev?.type ?? 'task',
      title: has('title') ? str(body.title, 300) : prev?.title,
      description: has('description') ? String(body.description ?? '').slice(0, 20000) : prev?.description ?? '',
      room: has('room') ? str(body.room, 60) : prev?.room ?? '',
      subject_id: has('subject_id') ? (body.subject_id ? Number(body.subject_id) : null) : prev?.subject_id ?? null,
      timetable_id: has('timetable_id') ? Number(body.timetable_id) : prev?.timetable_id,
      due_at: has('due_at') ? isoDate(body.due_at, 'La fecha') : prev?.due_at,
      reminder_minutes: has('reminder_minutes') ? reminderValue(body.reminder_minutes) : prev?.reminder_minutes ?? null,
      done: has('done') ? bool(body.done) : prev?.done ?? 0,
    };
    if (!d.title) throw bad('Escribe un título');
    if (!d.due_at) throw bad('Indica la fecha y la hora');
    await ownTimetable(uid, d.timetable_id);
    if (d.subject_id && !(await db.get('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [d.subject_id, uid]))) throw notFound('Asignatura no encontrada');
    return d;
  }
  async function saveChecklist(q, itemId, list) {
    await q.run('DELETE FROM checklist WHERE item_id = ?', [itemId]);
    let pos = 0;
    for (const c of list.slice(0, 200)) {
      const text = str(c?.text, 500);
      if (text) await q.run('INSERT INTO checklist (item_id, position, text, done) VALUES (?, ?, ?, ?)', [itemId, pos++, text, bool(c.done)]);
    }
  }
  route('GET', '/items', ({ uid }) => listItems(uid));

  /* ---------- Añadir al calendario del móvil (.ics) ---------- */
  const calHost = (req) => (req.headers.host || 'kairos').replace(/:\d+$/, '');
  const icsFile = (text, filename, inline = false) => ({ __binary: Buffer.from(text, 'utf8'), type: 'text/calendar; charset=utf-8', filename, inline, cache: 'no-store' });
  const userTz = (u) => (validTimezone(u?.timezone) ? u.timezone : 'Europe/Madrid');
  const fileSafe = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kairos';

  route('GET', '/items/:id/ics', async ({ uid, params, req }) => {
    const it = await db.get('SELECT * FROM items WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!it) throw notFound('No encontrado');
    const subject = it.subject_id ? await db.get('SELECT * FROM subjects WHERE id = ?', [it.subject_id]) : null;
    return icsFile(ics.calendar([ics.itemEvent(it, subject, userTz(await getUser(uid)), calHost(req))]), `${fileSafe(it.title)}.ics`);
  });
  route('GET', '/events/:id/ics', async ({ uid, params, req }) => {
    const ev = await db.get('SELECT * FROM events WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!ev) throw notFound('No encontrado');
    return icsFile(ics.calendar([ics.eventEvent(ev, userTz(await getUser(uid)), calHost(req))]), `${fileSafe(ev.title)}.ics`);
  });

  /* Suscripción: un enlace secreto que el calendario del móvil consulta solo y mantiene al día. */
  async function calendarToken(uid, renew = false) {
    const u = await getUser(uid);
    if (u.calendar_token && !renew) return u.calendar_token;
    const token = crypto.randomBytes(24).toString('base64url');
    await db.run('UPDATE users SET calendar_token = ? WHERE id = ?', [token, uid]);
    return token;
  }
  route('GET', '/me/calendar', async ({ uid }) => ({ token: await calendarToken(uid) }));
  route('POST', '/me/calendar/reset', async ({ uid }) => ({ token: await calendarToken(uid, true) }));
  route('GET', '/cal/:token', async ({ params, req }) => {
    const token = String(params.token).replace(/\.ics$/i, '');
    const u = token.length >= 20 ? await db.get('SELECT * FROM users WHERE calendar_token = ?', [token]) : null;
    if (!u || u.suspended_at) throw notFound('Calendario no encontrado');
    const since = new Date(Date.now() - 60 * 86400000).toISOString();
    const items = await db.all("SELECT * FROM items WHERE user_id = ? AND type = 'exam' AND done = 0 AND due_at >= ? ORDER BY due_at", [u.id, since]);
    const events = await db.all('SELECT * FROM events WHERE user_id = ? AND done = 0 AND COALESCE(end_at, start_at) >= ? ORDER BY start_at', [u.id, since]);
    const subjects = new Map((await db.all('SELECT * FROM subjects WHERE user_id = ?', [u.id])).map((s) => [s.id, s]));
    const tz = userTz(u);
    const host = calHost(req);
    return icsFile(ics.calendar([...items.map((i) => ics.itemEvent(i, subjects.get(i.subject_id), tz, host)), ...events.map((e) => ics.eventEvent(e, tz, host))], 'Kairos'), 'kairos.ics', true);
  }, { auth: false });
  route('POST', '/items', async ({ uid, body }) => {
    const d = await itemData(uid, body);
    const id = await db.tx(async (q) => {
      const r = await q.run(`INSERT INTO items (user_id, timetable_id, subject_id, type, title, description, room, due_at, reminder_minutes, reminder_sent, done, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id`,
      [uid, d.timetable_id, d.subject_id, d.type, d.title, d.description, d.room, d.due_at, d.reminder_minutes, d.done, nowIso()]);
      if (Array.isArray(body.checklist)) await saveChecklist(q, r.id, body.checklist);
      return r.id;
    });
    return itemOut(id);
  });
  route('PUT', '/items/:id', async ({ uid, body, params }) => {
    const prev = await db.get('SELECT * FROM items WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!prev) throw notFound('Tarea no encontrada');
    const d = await itemData(uid, body, prev);
    // Si cambia la fecha o el aviso, se vuelve a avisar.
    const resend = d.due_at !== prev.due_at || d.reminder_minutes !== (prev.reminder_minutes ?? null);
    await db.tx(async (q) => {
      await q.run('UPDATE items SET timetable_id = ?, subject_id = ?, type = ?, title = ?, description = ?, room = ?, due_at = ?, reminder_minutes = ?, reminder_sent = ?, done = ? WHERE id = ?',
        [d.timetable_id, d.subject_id, d.type, d.title, d.description, d.room, d.due_at, d.reminder_minutes, resend ? 0 : prev.reminder_sent, d.done, prev.id]);
      if (Array.isArray(body.checklist)) await saveChecklist(q, prev.id, body.checklist);
    });
    return itemOut(prev.id);
  });
  /* ---------- PDF adjuntos a tareas y exámenes (instrucciones, enunciados…) ---------- */
  const MAX_PDF = 5 * 1024 * 1024;
  const MAX_FILES = 5;
  route('POST', '/items/:id/files', async ({ uid, params, body }) => {
    const it = await db.get('SELECT id FROM items WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!it) throw notFound('Tarea no encontrada');
    const m = String(body.data || '').match(/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw bad('Solo se pueden adjuntar archivos PDF.');
    const bytes = Buffer.from(m[1], 'base64');
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw bad('El archivo no es un PDF válido.');
    if (bytes.length > MAX_PDF) throw bad('El PDF es demasiado grande (máximo 5 MB).');
    if (await count('SELECT COUNT(*) AS n FROM item_files WHERE item_id = ?', [it.id]) >= MAX_FILES) throw bad(`Puedes adjuntar como mucho ${MAX_FILES} PDF por tarea.`);
    let name = str(body.name, 150).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || 'instrucciones.pdf';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    await db.run('INSERT INTO item_files (user_id, item_id, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [uid, it.id, name, 'application/pdf', bytes.length, m[1], nowIso()]);
    return itemOut(it.id);
  }, { maxBody: 7_500_000 });
  route('GET', '/items/:id/files/:fid', async ({ uid, params }) => {
    const f = await db.get('SELECT * FROM item_files WHERE id = ? AND item_id = ? AND user_id = ?', [Number(params.fid), Number(params.id), uid]);
    if (!f) throw notFound('Archivo no encontrado');
    return { __binary: Buffer.from(f.data, 'base64'), type: 'application/pdf', filename: f.name.replace(/"/g, ''), inline: true, cache: 'private, no-cache' };
  });
  route('DELETE', '/items/:id/files/:fid', async ({ uid, params }) => {
    const r = await db.run('DELETE FROM item_files WHERE id = ? AND item_id = ? AND user_id = ?', [Number(params.fid), Number(params.id), uid]);
    if (!r.changes) throw notFound('Archivo no encontrado');
    return itemOut(Number(params.id));
  });

  route('DELETE', '/items/:id', async ({ uid, params }) => {
    const prev = await db.get('SELECT * FROM items WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!prev) throw notFound('Tarea no encontrada');
    await db.tx(async (q) => {
      await q.run('DELETE FROM checklist WHERE item_id = ?', [prev.id]);
      await q.run('DELETE FROM item_files WHERE item_id = ?', [prev.id]);
      await q.run('DELETE FROM items WHERE id = ?', [prev.id]);
    });
    return { ok: true };
  });
  route('PATCH', '/checklist/:id', async ({ uid, body, params }) => {
    const c = await db.get('SELECT c.* FROM checklist c JOIN items i ON i.id = c.item_id WHERE c.id = ? AND i.user_id = ?', [Number(params.id), uid]);
    if (!c) throw notFound('Paso no encontrado');
    await db.run('UPDATE checklist SET done = ? WHERE id = ?', [bool(body.done), c.id]);
    return itemOut(c.item_id);
  });

  /* ---------- eventos ---------- */
  async function eventData(uid, body) {
    const d = {
      timetable_id: Number(body.timetable_id),
      title: str(body.title, 300),
      location: str(body.location, 300),
      description: String(body.description ?? '').slice(0, 20000),
      color: COLOR_RE.test(body.color || '') ? body.color.toLowerCase() : '#7461a6',
      all_day: bool(body.all_day),
      start_at: isoDate(body.start_at, 'La fecha'),
      end_at: body.end_at ? isoDate(body.end_at, 'La fecha final') : null,
      reminder_minutes: reminderValue(body.reminder_minutes),
    };
    if (!d.title) throw bad('Escribe un título');
    if (d.end_at && d.end_at < d.start_at) throw bad('El final debe ser posterior al inicio');
    await ownTimetable(uid, d.timetable_id);
    return d;
  }
  /**
   * Cada evento pertenece al horario cuyo periodo (fecha de inicio y fin) incluye su fecha.
   * Si varios lo incluyen, se respeta el que ya tenía; si ninguno, se queda donde estaba.
   */
  async function placeEvents(uid) {
    const tts = (await listTimetables(uid)).filter((t) => t.start_date || t.end_date);
    if (!tts.length) return;
    const u = await getUser(uid);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: validTimezone(u?.timezone) ? u.timezone : 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
    const covers = (t, key) => (!t.start_date || t.start_date <= key) && (!t.end_date || key <= t.end_date);
    for (const ev of await db.all('SELECT id, timetable_id, start_at FROM events WHERE user_id = ?', [uid])) {
      const key = fmt.format(new Date(ev.start_at));
      const fits = tts.filter((t) => covers(t, key));
      if (fits.length && !fits.some((t) => t.id === ev.timetable_id)) {
        await db.run('UPDATE events SET timetable_id = ? WHERE id = ?', [fits[0].id, ev.id]);
      }
    }
  }

  route('GET', '/events', ({ uid }) => listEvents(uid));
  route('POST', '/events', async ({ uid, body }) => {
    const d = await eventData(uid, body);
    const r = await db.run(`INSERT INTO events (user_id, timetable_id, title, location, description, color, all_day, start_at, end_at, reminder_minutes, reminder_sent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) RETURNING id`,
    [uid, d.timetable_id, d.title, d.location, d.description, d.color, d.all_day, d.start_at, d.end_at, d.reminder_minutes, nowIso()]);
    await placeEvents(uid);
    return fmtEvent(await db.get('SELECT * FROM events WHERE id = ?', [r.id]));
  });
  route('PUT', '/events/:id', async ({ uid, body, params }) => {
    const prev = await db.get('SELECT * FROM events WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!prev) throw notFound('Evento no encontrado');
    const d = await eventData(uid, body);
    const resend = d.start_at !== prev.start_at || d.reminder_minutes !== (prev.reminder_minutes ?? null);
    await db.run('UPDATE events SET timetable_id = ?, title = ?, location = ?, description = ?, color = ?, all_day = ?, start_at = ?, end_at = ?, reminder_minutes = ?, reminder_sent = ? WHERE id = ?',
      [d.timetable_id, d.title, d.location, d.description, d.color, d.all_day, d.start_at, d.end_at, d.reminder_minutes, resend ? 0 : prev.reminder_sent, prev.id]);
    await placeEvents(uid);
    return fmtEvent(await db.get('SELECT * FROM events WHERE id = ?', [prev.id]));
  });
  route('PUT', '/events/:id/done', async ({ uid, body, params }) => {
    const r = await db.run('UPDATE events SET done = ? WHERE id = ? AND user_id = ?', [bool(body.done), Number(params.id), uid]);
    if (!r.changes) throw notFound('Evento no encontrado');
    return fmtEvent(await db.get('SELECT * FROM events WHERE id = ?', [Number(params.id)]));
  });
  route('DELETE', '/events/:id', async ({ uid, params }) => {
    const r = await db.run('DELETE FROM events WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!r.changes) throw notFound('Evento no encontrado');
    return { ok: true };
  });

  /* ---------- notificaciones push ---------- */
  route('GET', '/push/key', () => {
    if (!notify.pushAvailable()) throw new HttpError(503, 'Las notificaciones no están disponibles en este servidor');
    return { publicKey: notify.pushPublicKey() };
  });
  route('POST', '/push/subscribe', async ({ uid, body }) => {
    const sub = body.subscription || {};
    if (!sub.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw bad('Suscripción no válida');
    const prev = await db.get('SELECT id FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
    if (prev) await db.run('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE id = ?', [uid, sub.keys.p256dh, sub.keys.auth, prev.id]);
    else await db.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)', [uid, sub.endpoint, sub.keys.p256dh, sub.keys.auth, nowIso()]);
    return { push_devices: await pushDevices(uid) };
  });
  route('POST', '/push/unsubscribe', async ({ uid, body }) => {
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [String(body.endpoint || ''), uid]);
    return { push_devices: await pushDevices(uid) };
  });
  route('POST', '/push/test', async ({ uid }) => {
    const n = await notify.pushToUser(db, uid, { title: 'Kairos', body: 'Las notificaciones funcionan en este dispositivo.', tag: 'test', url: '/' });
    if (!n) throw bad('No hay ningún dispositivo con las notificaciones activadas');
    return { sent: n };
  });

  /* ============================================================
     Servidor HTTP
     ============================================================ */
  const appUrl = (req) => process.env.APP_URL || (req ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}` : '');

  async function readBody(req, max = 1_000_000) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > max) throw new HttpError(413, max > 1_000_000 ? 'El archivo es demasiado grande (máximo 5 MB).' : 'Petición demasiado grande');
      chunks.push(c);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('JSON no válido'); }
  }

  function sendJson(res, status, data) {
    if (data === null || data === undefined) { res.writeHead(204); res.end(); return; }
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  async function handleApi(req, res, pathname) {
    const sub = pathname.slice(4) || '/';
    const candidates = routes.filter((r) => r.re.test(sub));
    const r = candidates.find((x) => x.method === req.method);
    if (!r) throw new HttpError(candidates.length ? 405 : 404, candidates.length ? 'Método no permitido' : 'No encontrado');
    // Protección CSRF: las peticiones que cambian datos deben venir de la propia app.
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origen no permitido');
      if (!/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Se esperaba JSON');
    }
    const m = sub.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const uid = await sessionUser(req);
    if (r.auth && !uid) {
      await checkSuspendedSession(req);
      throw new HttpError(401, 'Inicia sesión para continuar');
    }
    const body = req.method === 'GET' ? {} : await readBody(req, r.maxBody);
    const data = await r.handler({ req, res, body, params, uid });
    if (data && data.__binary) {
      res.writeHead(200, {
        'Content-Type': data.type,
        'Cache-Control': data.cache || 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        ...(data.filename ? { 'Content-Disposition': `${data.inline ? 'inline' : 'attachment'}; filename="${data.filename.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/"/g, '') || 'archivo'}"; filename*=UTF-8''${encodeURIComponent(data.filename)}` } : {}),
      });
      res.end(data.__binary);
      return;
    }
    sendJson(res, 200, data);
  }

  /* ---------- archivos estáticos ---------- */
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  };
  // Las tipografías (Figtree y Fraunces, licencia SIL OFL 1.1) van incluidas en public/fonts.
  const fontPath = (name) => {
    const p = path.join(PUBLIC, 'fonts', name);
    return fs.existsSync(p) ? p : null;
  };
  function serveStatic(req, res, pathname) {
    let file;
    if (pathname.startsWith('/fonts/')) file = fontPath(path.basename(pathname));
    else {
      const p = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
      if (p.startsWith(PUBLIC) && fs.existsSync(p) && fs.statSync(p).isFile()) file = p;
    }
    if (!file && pathname.startsWith('/fonts/')) { res.writeHead(404); res.end(); return; }
    if (!file) file = path.join(PUBLIC, 'index.html'); // la app se encarga de las rutas
    const stat = fs.statSync(file);
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const ext = path.extname(file);
    const longCache = ext === '.woff2' || pathname.startsWith('/icons/');
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': longCache ? 'public, max-age=2592000' : 'no-cache',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    };
    if (ext === '.html') headers['X-Frame-Options'] = 'SAMEORIGIN';
    if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
      if (pathname === '/api' || pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
      serveStatic(req, res, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Error del servidor. Vuelve a intentarlo.' : err.message, ...(err.extra || {}) });
      else res.end();
    }
  });
  server.listen(PORT, () => console.log(`Kairos en http://localhost:${PORT} (${db.kind})`));

  startReminders(db, () => appUrl(null));
  // Las personas que usan Kairos sin cuenta y llevan un año sin entrar se borran (se avisa en la política de privacidad).
  // Coloca los eventos ya existentes en el horario de su periodo (una vez al arrancar).
  (async () => {
    for (const { user_id } of await db.all('SELECT DISTINCT user_id FROM events')) await placeEvents(user_id).catch(() => {});
  })().catch(() => {});

  const cleanGuests = async () => {
    const limit = new Date(Date.now() - GUEST_MAX_IDLE_DAYS * 86400000).toISOString();
    const old = await db.all('SELECT id FROM users WHERE is_guest = 1 AND COALESCE(last_seen_at, created_at) < ?', [limit]);
    for (const g of old) await deleteUserData(g.id).catch(() => {});
    if (old.length) console.log(`[limpieza] ${old.length} usuarios sin cuenta inactivos borrados`);
  };
  setTimeout(() => cleanGuests().catch(() => {}), 60000);
  setInterval(() => cleanGuests().catch(() => {}), 86400000).unref();
  // Limpieza de sesiones caducadas una vez al día.
  setInterval(() => db.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]).catch(() => {}), 86400000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
