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
const { startReminders } = require('./reminders');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 90;
const COOKIE = 'kairos_session';

/* ============================================================
   Utilidades
   ============================================================ */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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
const fmtUser = (u, tt) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  timezone: u.timezone,
  active_timetable_id: u.active_timetable_id,
  email_notifications: Boolean(u.email_notifications),
  default_reminder_minutes: u.default_reminder_minutes ?? null,
  daily_digest: Boolean(u.daily_digest),
  digest_hour: u.digest_hour,
  visible_days: tt ? JSON.parse(tt.visible_days) : [1, 2, 3, 4, 5],
  tt_background: tt ? tt.background : 'rayas',
});
const fmtTimetable = (t) => ({
  id: t.id, name: t.name, start_date: t.start_date || null, end_date: t.end_date || null,
  visible_days: JSON.parse(t.visible_days), background: t.background,
});
const fmtSlot = (s) => ({ id: s.id, timetable_id: s.timetable_id, start_time: s.start_time, end_time: s.end_time, label: s.label, is_break: Boolean(s.is_break) });
const fmtSubject = (s) => ({ id: s.id, timetable_id: s.timetable_id, parent_id: s.parent_id ?? null, name: s.name, short_name: s.short_name, room: s.room, teacher: s.teacher, color: s.color });
const fmtEntry = (e) => ({ id: e.id, slot_id: e.slot_id, day: e.day, subject_id: e.subject_id, room_override: e.room_override });
const fmtEvent = (e) => ({
  id: e.id, timetable_id: e.timetable_id, title: e.title, location: e.location, description: e.description, color: e.color,
  all_day: Boolean(e.all_day), start_at: e.start_at, end_at: e.end_at || null,
  reminder_minutes: e.reminder_minutes ?? null, reminder_sent: Boolean(e.reminder_sent),
});
const fmtItem = (i, checklist) => ({
  id: i.id, timetable_id: i.timetable_id, subject_id: i.subject_id ?? null, type: i.type, title: i.title, description: i.description,
  due_at: i.due_at, reminder_minutes: i.reminder_minutes ?? null, reminder_sent: Boolean(i.reminder_sent), done: Boolean(i.done),
  checklist: checklist.map((c) => ({ id: c.id, text: c.text, done: Boolean(c.done) })),
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
  await notify.initPush(db).catch((e) => console.error('[push] no disponible:', e.message));

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
    return items.map((i) => fmtItem(i, by.get(i.id) || []));
  }
  async function itemOut(id, q = db) {
    const i = await q.get('SELECT * FROM items WHERE id = ?', [id]);
    const checks = await q.all('SELECT * FROM checklist WHERE item_id = ? ORDER BY position, id', [id]);
    return fmtItem(i, checks);
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
        const r = await q.run('INSERT INTO subjects (user_id, timetable_id, parent_id, name, short_name, room, teacher, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
          [uid, ttId, s.parent_id ? subjMap.get(s.parent_id) ?? null : null, s.name, s.short_name, s.room, s.teacher, s.color]);
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
  async function startSession(res, uid) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [sha256(token), uid, expires]);
    setCookie(res, token, SESSION_DAYS * 86400);
  }
  async function sessionUser(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const s = await db.get('SELECT * FROM sessions WHERE token_hash = ?', [sha256(token)]);
    if (!s || s.expires_at < nowIso()) return null;
    return s.user_id;
  }

  /* Límite sencillo de intentos de acceso por IP */
  const attempts = new Map();
  function rateLimit(req) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
    list.push(now);
    attempts.set(ip, list);
    if (list.length > 30) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos y vuelve a probar.');
  }

  /* ============================================================
     Rutas de la API
     ============================================================ */
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth });
  };

  /* ---------- cuenta ---------- */
  route('POST', '/auth/register', async ({ body, res }) => {
    const name = str(body.name, 80);
    const email = str(body.email, 200).toLowerCase();
    const password = String(body.password || '');
    if (!name) throw bad('Escribe tu nombre');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Escribe un correo electrónico válido');
    if (password.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
    if (await db.get('SELECT id FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Ya existe una cuenta con ese correo');
    const tz = validTimezone(body.timezone) ? body.timezone : 'Europe/Madrid';
    const uid = await db.tx(async (q) => {
      const u = await q.run('INSERT INTO users (email, name, password_hash, timezone, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
        [email, name, hashPassword(password), tz, nowIso()]);
      const ttId = await createTimetable(q, u.id, { name: 'Mi horario', start_date: null, end_date: null, visible_days: [1, 2, 3, 4, 5] });
      await q.run('UPDATE users SET active_timetable_id = ? WHERE id = ?', [ttId, u.id]);
      return u.id;
    });
    await startSession(res, uid);
    return { user: await userOut(uid) };
  }, { auth: false });

  route('POST', '/auth/login', async ({ body, req, res }) => {
    rateLimit(req);
    const email = str(body.email, 200).toLowerCase();
    const u = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!u || !checkPassword(String(body.password || ''), u.password_hash)) throw new HttpError(401, 'Correo o contraseña incorrectos');
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
    if ('email_notifications' in body) set('email_notifications', bool(body.email_notifications));
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
    if (!checkPassword(String(body.current || ''), u.password_hash)) throw bad('La contraseña actual no es correcta');
    if (String(body.password || '').length < 8) throw bad('La nueva contraseña debe tener al menos 8 caracteres');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(String(body.password)), uid]);
    return { ok: true };
  });

  route('POST', '/me/test-email', async ({ uid, req }) => {
    const u = await getUser(uid);
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
      color: 'color' in body ? String(body.color) : prev.color,
    };
    if (!d.name) throw bad('Escribe el nombre de la asignatura');
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
    const r = await db.run('INSERT INTO subjects (user_id, timetable_id, parent_id, name, short_name, room, teacher, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [uid, ttId, parentId, d.name, d.short_name, d.room, d.teacher, d.color]);
    return fmtSubject(await db.get('SELECT * FROM subjects WHERE id = ?', [r.id]));
  });
  route('PUT', '/subjects/:id', async ({ uid, body, params }) => {
    const s = await db.get('SELECT * FROM subjects WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!s) throw notFound('Asignatura no encontrada');
    const d = subjectData(body, s);
    await db.run('UPDATE subjects SET name = ?, short_name = ?, room = ?, teacher = ?, color = ? WHERE id = ?', [d.name, d.short_name, d.room, d.teacher, d.color, s.id]);
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
  route('POST', '/items', async ({ uid, body }) => {
    const d = await itemData(uid, body);
    const id = await db.tx(async (q) => {
      const r = await q.run(`INSERT INTO items (user_id, timetable_id, subject_id, type, title, description, due_at, reminder_minutes, reminder_sent, done, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id`,
      [uid, d.timetable_id, d.subject_id, d.type, d.title, d.description, d.due_at, d.reminder_minutes, d.done, nowIso()]);
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
      await q.run('UPDATE items SET timetable_id = ?, subject_id = ?, type = ?, title = ?, description = ?, due_at = ?, reminder_minutes = ?, reminder_sent = ?, done = ? WHERE id = ?',
        [d.timetable_id, d.subject_id, d.type, d.title, d.description, d.due_at, d.reminder_minutes, resend ? 0 : prev.reminder_sent, d.done, prev.id]);
      if (Array.isArray(body.checklist)) await saveChecklist(q, prev.id, body.checklist);
    });
    return itemOut(prev.id);
  });
  route('DELETE', '/items/:id', async ({ uid, params }) => {
    const prev = await db.get('SELECT * FROM items WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!prev) throw notFound('Tarea no encontrada');
    await db.tx(async (q) => {
      await q.run('DELETE FROM checklist WHERE item_id = ?', [prev.id]);
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
  route('GET', '/events', ({ uid }) => listEvents(uid));
  route('POST', '/events', async ({ uid, body }) => {
    const d = await eventData(uid, body);
    const r = await db.run(`INSERT INTO events (user_id, timetable_id, title, location, description, color, all_day, start_at, end_at, reminder_minutes, reminder_sent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) RETURNING id`,
    [uid, d.timetable_id, d.title, d.location, d.description, d.color, d.all_day, d.start_at, d.end_at, d.reminder_minutes, nowIso()]);
    return fmtEvent(await db.get('SELECT * FROM events WHERE id = ?', [r.id]));
  });
  route('PUT', '/events/:id', async ({ uid, body, params }) => {
    const prev = await db.get('SELECT * FROM events WHERE id = ? AND user_id = ?', [Number(params.id), uid]);
    if (!prev) throw notFound('Evento no encontrado');
    const d = await eventData(uid, body);
    const resend = d.start_at !== prev.start_at || d.reminder_minutes !== (prev.reminder_minutes ?? null);
    await db.run('UPDATE events SET timetable_id = ?, title = ?, location = ?, description = ?, color = ?, all_day = ?, start_at = ?, end_at = ?, reminder_minutes = ?, reminder_sent = ? WHERE id = ?',
      [d.timetable_id, d.title, d.location, d.description, d.color, d.all_day, d.start_at, d.end_at, d.reminder_minutes, resend ? 0 : prev.reminder_sent, prev.id]);
    return fmtEvent(await db.get('SELECT * FROM events WHERE id = ?', [prev.id]));
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

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) throw new HttpError(413, 'Petición demasiado grande');
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
    if (r.auth && !uid) throw new HttpError(401, 'Inicia sesión para continuar');
    const body = req.method === 'GET' ? {} : await readBody(req);
    const data = await r.handler({ req, res, body, params, uid });
    sendJson(res, 200, data);
  }

  /* ---------- archivos estáticos ---------- */
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  };
  // Las fuentes salen de los paquetes de @fontsource si están instalados, o de public/fonts.
  function fontPath(name) {
    const family = name.split('-')[0];
    const candidates = [
      path.join(__dirname, '..', 'node_modules', '@fontsource-variable', family, 'files', name),
      path.join(PUBLIC, 'fonts', name),
    ];
    return candidates.find((p) => fs.existsSync(p));
  }
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
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Error del servidor. Vuelve a intentarlo.' : err.message });
      else res.end();
    }
  });
  server.listen(PORT, () => console.log(`Kairos en http://localhost:${PORT} (${db.kind})`));

  startReminders(db, () => appUrl(null));
  // Limpieza de sesiones caducadas una vez al día.
  setInterval(() => db.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]).catch(() => {}), 86400000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
