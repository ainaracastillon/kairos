'use strict';
/*
 * Avisos programados: cada minuto busca tareas, exámenes y eventos cuyo aviso ya toca
 * y, una vez al día a la hora elegida, manda el resumen de lo pendiente de los próximos 7 días.
 */
const notify = require('./notify');

const GRACE_MS = 6 * 60 * 60 * 1000; // si el servidor estuvo dormido, no se avisa de cosas ya muy pasadas

function fmtWhen(iso, tz, allDay = false) {
  const d = new Date(iso);
  const opts = allDay ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' };
  const s = d.toLocaleString('es-ES', { ...opts, timeZone: tz });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function localParts(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
function relativeLabel(iso) {
  const mins = Math.round((new Date(iso) - Date.now()) / 60000);
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
  if (Math.abs(mins) < 60 * 24) return rtf.format(Math.round(mins / 60), 'hour');
  return rtf.format(Math.round(mins / 1440), 'day');
}

async function deliver(db, user, { subject, title, lines, push, url }, appUrl) {
  const jobs = [];
  if (user.email_notifications && !user.is_guest) {
    jobs.push(notify.sendMail({
      to: user.email,
      subject,
      text: `${title}\n\n${lines.join('\n')}`,
      html: notify.mailHtml(title, lines.map((l) => `<p style="margin:6px 0">${notify.escHtml(l)}</p>`).join(''), appUrl),
    }).catch((e) => console.error('[correo]', e.message)));
  }
  if (push) jobs.push(notify.pushToUser(db, user.id, { ...push, url: url || '/' }).catch((e) => console.error('[push]', e.message)));
  await Promise.all(jobs);
}

async function itemReminders(db, appUrl) {
  const now = Date.now();
  const rows = await db.all(`SELECT i.*, s.name AS subject_name FROM items i LEFT JOIN subjects s ON s.id = i.subject_id
    WHERE i.reminder_sent = 0 AND i.done = 0 AND i.reminder_minutes IS NOT NULL`);
  for (const it of rows) {
    const due = new Date(it.due_at).getTime();
    if (due - it.reminder_minutes * 60000 > now) continue;
    await db.run('UPDATE items SET reminder_sent = 1 WHERE id = ?', [it.id]);
    if (now - due > GRACE_MS) continue;
    const user = await db.get('SELECT * FROM users WHERE id = ?', [it.user_id]);
    if (!user) continue;
    const kind = it.type === 'exam' ? 'Examen' : 'Tarea';
    const when = fmtWhen(it.due_at, user.timezone);
    const lines = [`${kind}: ${it.title}`, it.subject_name ? `Asignatura: ${it.subject_name}` : null, `Cuándo: ${when} (${relativeLabel(it.due_at)})`, it.description || null].filter(Boolean);
    const checks = await db.all('SELECT * FROM checklist WHERE item_id = ? ORDER BY position, id', [it.id]);
    if (checks.length) lines.push('Pasos:', ...checks.map((c) => `${c.done ? '✔' : '○'} ${c.text}`));
    await deliver(db, user, {
      subject: `${kind}: ${it.title} · ${relativeLabel(it.due_at)}`,
      title: `${kind} ${relativeLabel(it.due_at)}`,
      lines,
      push: { title: `${kind}: ${it.title}`, body: `${it.subject_name ? `${it.subject_name} · ` : ''}${when}`, tag: `item-${it.id}` },
      url: '/#items',
    }, appUrl);
  }
}

async function eventReminders(db, appUrl) {
  const now = Date.now();
  const rows = await db.all('SELECT * FROM events WHERE reminder_sent = 0 AND reminder_minutes IS NOT NULL AND done = 0');
  for (const ev of rows) {
    const start = new Date(ev.start_at).getTime();
    if (start - ev.reminder_minutes * 60000 > now) continue;
    await db.run('UPDATE events SET reminder_sent = 1 WHERE id = ?', [ev.id]);
    if (now - start > GRACE_MS) continue;
    const user = await db.get('SELECT * FROM users WHERE id = ?', [ev.user_id]);
    if (!user) continue;
    const when = fmtWhen(ev.start_at, user.timezone, Boolean(ev.all_day));
    await deliver(db, user, {
      subject: `Evento: ${ev.title} · ${relativeLabel(ev.start_at)}`,
      title: `Evento ${relativeLabel(ev.start_at)}`,
      lines: [`Evento: ${ev.title}`, `Cuándo: ${when}`, ev.location ? `Lugar: ${ev.location}` : null, ev.description || null].filter(Boolean),
      push: { title: `Evento: ${ev.title}`, body: [when, ev.location].filter(Boolean).join(' · '), tag: `event-${ev.id}` },
      url: '/#month',
    }, appUrl);
  }
}

async function digests(db, appUrl) {
  const users = await db.all('SELECT * FROM users WHERE daily_digest = 1');
  for (const user of users) {
    const local = localParts(new Date(), user.timezone);
    if (local.hour !== user.digest_hour || user.last_digest_date === local.date) continue;
    await db.run('UPDATE users SET last_digest_date = ? WHERE id = ?', [local.date, user.id]);
    const until = new Date(Date.now() + 7 * 86400000).toISOString();
    const items = await db.all(`SELECT i.*, s.name AS subject_name FROM items i LEFT JOIN subjects s ON s.id = i.subject_id
      WHERE i.user_id = ? AND i.done = 0 AND i.due_at <= ? ORDER BY i.due_at`, [user.id, until]);
    const events = await db.all('SELECT * FROM events WHERE user_id = ? AND done = 0 AND start_at >= ? AND start_at <= ? ORDER BY start_at', [user.id, new Date().toISOString(), until]);
    if (!items.length && !events.length) continue;
    const now = new Date().toISOString();
    const lines = [
      ...items.map((i) => `${i.due_at < now ? '⚠ Vencida · ' : ''}${i.type === 'exam' ? 'Examen' : 'Tarea'}: ${i.title}${i.subject_name ? ` (${i.subject_name})` : ''} — ${fmtWhen(i.due_at, user.timezone)}`),
      ...events.map((e) => `Evento: ${e.title} — ${fmtWhen(e.start_at, user.timezone, Boolean(e.all_day))}`),
    ];
    const n = items.length + events.length;
    await deliver(db, user, {
      subject: `Tu resumen de Kairos: ${n} ${n === 1 ? 'cosa pendiente' : 'cosas pendientes'}`,
      title: 'Lo que tienes los próximos 7 días',
      lines,
      push: { title: 'Tu resumen de hoy', body: `${n} ${n === 1 ? 'cosa pendiente' : 'cosas pendientes'} en los próximos 7 días`, tag: 'digest' },
      url: '/#items',
    }, appUrl);
  }
}

function startReminders(db, getAppUrl) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const url = getAppUrl();
      await itemReminders(db, url);
      await eventReminders(db, url);
      await digests(db, url);
    } catch (e) {
      console.error('[avisos]', e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 60000);
}

module.exports = { startReminders };
