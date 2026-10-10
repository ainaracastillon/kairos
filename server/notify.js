'use strict';
/*
 * Envío de avisos: correo (Resend por HTTP o SMTP con nodemailer) y notificaciones push (web-push).
 * Si no hay nada configurado, el correo se muestra en la consola del servidor.
 */

function optional(name) {
  try { return require(name); } catch { return null; }
}

/* ---------------- Correo ---------------- */
const nodemailer = optional('nodemailer');
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_FROM || 'Kairos <avisos@kairos.app>';
let transport = null;
if (!process.env.RESEND_API_KEY && process.env.SMTP_HOST && nodemailer) {
  const port = Number(process.env.SMTP_PORT || 587);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}
const mailConfigured = () => Boolean(process.env.RESEND_API_KEY || transport);

async function sendMail({ to, subject, text, html }) {
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }),
    });
    if (!res.ok) throw new Error(`No se pudo enviar el correo (${res.status}): ${await res.text().catch(() => '')}`);
    return;
  }
  if (transport) {
    await transport.sendMail({ from: MAIL_FROM, to, subject, text, html });
    return;
  }
  console.log(`\n[correo sin SMTP] Para: ${to}\nAsunto: ${subject}\n${text}\n`);
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Plantilla sencilla con la marca de Kairos. */
function mailHtml(title, bodyHtml, appUrl) {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f6f4ef;font-family:Helvetica,Arial,sans-serif;color:#1f2b30">
  <div style="max-width:560px;margin:0 auto;padding:28px 18px">
    <div style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#2c5f6f;margin-bottom:18px">
      <span style="display:inline-block;width:26px;height:26px;border-radius:7px;background:#14213d;color:#fca311;text-align:center;line-height:26px;font-size:16px;font-family:Helvetica,Arial,sans-serif;vertical-align:-4px">K</span> Kairos
    </div>
    <div style="background:#fff;border:1px solid #e4dfd4;border-radius:12px;padding:22px">
      <h1 style="font-family:Georgia,serif;font-size:21px;margin:0 0 12px">${escHtml(title)}</h1>
      ${bodyHtml}
    </div>
    ${appUrl ? `<p style="text-align:center;margin:18px 0 0"><a href="${escHtml(appUrl)}" style="display:inline-block;background:#2c5f6f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:9px;font-weight:600">Abrir Kairos</a></p>` : ''}
    <p style="color:#6c7478;font-size:12px;text-align:center;margin-top:18px">Recibes este correo porque tienes activados los avisos en Kairos. Puedes cambiarlo en Ajustes.</p>
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

module.exports = { sendMail, mailHtml, mailConfigured, escHtml, initPush, pushAvailable, pushPublicKey, pushToUser };
