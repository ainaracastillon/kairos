'use strict';
/*
 * Envío de avisos: correo (Brevo o Resend por HTTP, o SMTP con nodemailer) y notificaciones push (web-push).
 * Si no hay nada configurado, el correo se muestra en la consola del servidor.
 */

function optional(name) {
  try { return require(name); } catch { return null; }
}

/* ---------------- Correo ---------------- */
const nodemailer = optional('nodemailer');
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_FROM || 'Kairos <avisos@kairos.app>';
let transport = null;
if (!process.env.BREVO_API_KEY && !process.env.RESEND_API_KEY && process.env.SMTP_HOST && nodemailer) {
  const port = Number(process.env.SMTP_PORT || 587);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}
const mailConfigured = () => Boolean(process.env.BREVO_API_KEY || process.env.RESEND_API_KEY || transport);

/** «Kairos <hola@x.com>» → { name: 'Kairos', email: 'hola@x.com' } */
function parseFrom(from) {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || 'Kairos', email: m[2] } : { name: 'Kairos', email: from.trim() };
}

/** Envío para otras apps (Entre Fogones): remitente propio; si Brevo no lo acepta, sale desde el remitente de Kairos con «responder a» el pedido */
async function sendMailAs({ from, to, subject, text, html, replyTo }) {
  if (!process.env.BREVO_API_KEY) throw new Error('Brevo no está configurado');
  const want = parseFrom(from || MAIL_FROM);
  const send = (sender, rt) => fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html, ...(rt ? { replyTo: { email: rt } } : {}) }) });
  let res = await send(want, replyTo);
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    // remitente sin verificar: se usa la dirección base (sin +etiqueta) o la de Kairos, con el mismo nombre
    const base = want.email.replace(/\+[^@]*@/, '@');
    const fallback = base !== want.email ? base : parseFrom(MAIL_FROM).email;
    console.log('[correo] remitente', want.email, 'rechazado:', err.slice(0, 160), '→ uso', fallback);
    res = await send({ name: want.name, email: fallback }, replyTo || want.email);
    if (!res.ok) throw new Error(`No se pudo enviar el correo (${res.status}): ${await res.text().catch(() => '')}`);
  }
}
/** Da de alta un remitente en Brevo si no está (Brevo le manda un correo para verificarlo) */
async function ensureSender(from) {
  if (!process.env.BREVO_API_KEY || !from) return;
  const want = parseFrom(from);
  try {
    const r = await fetch('https://api.brevo.com/v3/senders', { headers: { 'api-key': process.env.BREVO_API_KEY, Accept: 'application/json' } });
    const { senders = [] } = r.ok ? await r.json() : {};
    const s = senders.find((x) => String(x.email).toLowerCase() === want.email.toLowerCase());
    if (s) { console.log(`[correo] Remitente extra ${want.email}: ${s.active ? 'VERIFICADO' : 'SIN VERIFICAR (revisa el correo de Brevo)'}`); return; }
    const c = await fetch('https://api.brevo.com/v3/senders', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ name: want.name, email: want.email }) });
    console.log(`[correo] Alta del remitente ${want.email} en Brevo: ${c.status} ${(await c.text().catch(() => '')).slice(0, 160)}`);
  } catch (e) { console.log('[correo] alta de remitente:', e.message); }
}

async function sendMail({ to, subject, text, html, replyTo }) {
  // Brevo: gratis hasta 300 correos al día y permite usar como remitente un correo verificado (p. ej. un Gmail).
  if (process.env.BREVO_API_KEY) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: parseFrom(MAIL_FROM), to: [{ email: to }], subject, textContent: text, htmlContent: html, ...(replyTo ? { replyTo: { email: replyTo } } : {}) }),
    });
    if (!res.ok) throw new Error(`No se pudo enviar el correo (${res.status}): ${await res.text().catch(() => '')}`);
    return;
  }
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    if (!res.ok) throw new Error(`No se pudo enviar el correo (${res.status}): ${await res.text().catch(() => '')}`);
    return;
  }
  if (transport) {
    await transport.sendMail({ from: MAIL_FROM, to, subject, text, html, replyTo });
    return;
  }
  console.log(`\n[correo sin SMTP] Para: ${to}\nAsunto: ${subject}\n${text}\n`);
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Plantilla sencilla con la marca de Kairos. */
function mailHtml(title, bodyHtml, appUrl, { button = true, footer = 'Recibes este correo porque tienes activados los avisos en Kairos. Puedes cambiarlo en Ajustes.' } = {}) {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f6f4ef;font-family:Helvetica,Arial,sans-serif;color:#1f2b30">
  <div style="max-width:560px;margin:0 auto;padding:28px 18px">
    <div style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#14213d;margin-bottom:18px">
      ${appUrl ? `<img src="${escHtml(appUrl.replace(/\/$/, ''))}/icons/icon-192.png" width="30" height="30" alt="" style="display:inline-block;width:30px;height:30px;border:0;border-radius:8px;vertical-align:-8px;margin-right:6px">` : ''}Kairos
    </div>
    <div style="background:#fff;border:1px solid #e4dfd4;border-radius:12px;padding:22px">
      <h1 style="font-family:Georgia,serif;font-size:21px;margin:0 0 12px">${escHtml(title)}</h1>
      ${bodyHtml}
    </div>
    ${appUrl && button ? `<p style="text-align:center;margin:18px 0 0"><a href="${escHtml(appUrl)}" style="display:inline-block;background:#14213d;color:#fff;text-decoration:none;padding:10px 18px;border-radius:9px;font-weight:600">Abrir Kairos</a></p>` : ''}
    <p style="color:#6c7478;font-size:12px;text-align:center;margin-top:18px">${escHtml(footer)}${appUrl ? ` · <a href="${escHtml(appUrl.replace(/\/$/, ''))}/legal.html#privacidad" style="color:#6c7478">Privacidad</a>` : ''}</p>
  </div></body></html>`;
}

/* ---------------- Push ---------------- */
const webpush = optional('web-push');
let vapid = null;

/** Prepara las claves VAPID: de las variables de entorno o, si no hay, generadas y guardadas en la base de datos. */
async function initPush(db) {
  if (!webpush) return;
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const row = await db.get("SELECT value FROM app_settings WHERE key = 'vapid'");
    if (row) ({ publicKey: pub, privateKey: priv } = JSON.parse(row.value));
    else {
      const keys = webpush.generateVAPIDKeys();
      ({ publicKey: pub, privateKey: priv } = keys);
      await db.run('INSERT INTO app_settings (key, value) VALUES (?, ?)', ['vapid', JSON.stringify(keys)]);
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:${(MAIL_FROM.match(/<([^>]+)>/) || [])[1] || 'avisos@kairos.app'}`, pub, priv);
  vapid = { publicKey: pub };
}
const pushAvailable = () => Boolean(webpush && vapid);
const pushPublicKey = () => vapid?.publicKey || null;

/** Envía una notificación a todos los dispositivos de un usuario; borra las suscripciones caducadas. */
async function pushToUser(db, userId, payload) {
  if (!pushAvailable()) return 0;
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await db.run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
      else console.error('[push]', err.statusCode || '', err.body || err.message);
    }
  }
  return sent;
}

/** Al arrancar, comprueba en Brevo que el remitente configurado está verificado (solo deja una línea en el registro). */
async function checkSender() {
  if (!process.env.BREVO_API_KEY) return;
  const from = parseFrom(MAIL_FROM).email.toLowerCase();
  try {
    const res = await fetch('https://api.brevo.com/v3/senders', { headers: { 'api-key': process.env.BREVO_API_KEY, Accept: 'application/json' } });
    if (!res.ok) { console.log(`[correo] No se pudo comprobar el remitente en Brevo (${res.status})`); return; }
    const { senders = [] } = await res.json();
    const s = senders.find((x) => String(x.email).toLowerCase() === from);
    const list = senders.map((x) => `${x.email}${x.active ? ' (verificado)' : ' (sin verificar)'}`).join(', ');
    console.log(`[correo] Remitente ${from}: ${s ? (s.active ? 'VERIFICADO en Brevo' : 'en Brevo pero SIN VERIFICAR') : 'NO está dado de alta en Brevo'}. Remitentes en Brevo: ${list || 'ninguno'}`);
  } catch (e) {
    console.log('[correo] No se pudo comprobar el remitente en Brevo:', e.message);
  }
}

/** A quién llegan los mensajes del formulario de contacto (nunca se muestra en la web). */
const contactInbox = () => process.env.CONTACT_TO || parseFrom(MAIL_FROM).email;

module.exports = { checkSender, contactInbox, sendMail, sendMailAs, ensureSender, mailHtml, mailConfigured, escHtml, initPush, pushAvailable, pushPublicKey, pushToUser };
