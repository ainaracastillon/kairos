'use strict';
/*
 * Calendario en formato iCalendar (.ics), compatible con Apple Calendar, Google Calendar,
 * Outlook y los calendarios de Android. Sirve para añadir un examen o evento suelto
 * y para la suscripción que mantiene sincronizados todos los exámenes y eventos.
 */

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utc = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Fecha (AAAAMMDD) de un instante en la zona horaria de la persona. */
function localDate(d, tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  return p.replace(/-/g, '');
}
function nextDay(yyyymmdd) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + 1));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Las líneas largas se parten a 74 caracteres, como pide el formato. */
function fold(line) {
  const out = [];
  let rest = line;
  while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = ` ${rest.slice(74)}`; }
  out.push(rest);
  return out.join('\r\n');
}

function vevent({ uid, title, start, end, allDay, location, description, reminder, tz, url }) {
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utc(Date.now())}`, `SEQUENCE:${Math.floor(Date.now() / 1000) - 1700000000}`, `LAST-MODIFIED:${utc(Date.now())}`];
  if (allDay) {
    const s = localDate(start, tz);
    const e = end ? localDate(end, tz) : s;
    lines.push(`DTSTART;VALUE=DATE:${s}`, `DTEND;VALUE=DATE:${nextDay(e)}`);
  } else {
    lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end || new Date(new Date(start).getTime() + 60 * 60000))}`);
  }
  lines.push(`SUMMARY:${esc(title)}`);
  if (location) lines.push(`LOCATION:${esc(location)}`);
  if (description) lines.push(`DESCRIPTION:${esc(description)}`);
  if (url) lines.push(`URL:${url}`);
  if (reminder !== null && reminder !== undefined) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, `TRIGGER:-PT${Math.max(0, Number(reminder))}M`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

/** Un examen o tarea (item) o un evento convertidos a VEVENT. */
function itemEvent(item, subject, tz, host) {
  const kind = item.type === 'exam' ? 'Examen' : 'Tarea';
  const title = `${kind}: ${item.title}${subject && !item.title.toLowerCase().includes(subject.name.toLowerCase()) ? ` (${subject.name})` : ''}`;
  return vevent({
    uid: `${item.type}-${item.id}@${host}`, title, start: item.due_at, tz,
    location: item.room || '', description: item.description || '', reminder: item.reminder_minutes,
  });
}
/** Exposición de una tarea, con su propia fecha y hora (1 hora). */
function talkEvent(item, subject, tz, host) {
  return vevent({
    uid: `talk-${item.id}@${host}`, title: `Exposición: ${item.title}${subject && !item.title.toLowerCase().includes(subject.name.toLowerCase()) ? ` (${subject.name})` : ''}`,
    start: item.presentation_at, tz, location: item.room || '', description: item.description || '', reminder: item.reminder_minutes,
  });
}
function eventEvent(ev, tz, host) {
  return vevent({
    uid: `event-${ev.id}@${host}`, title: ev.title, start: ev.start_at, end: ev.end_at, allDay: Boolean(ev.all_day), tz,
    location: ev.location || '', description: ev.description || '', reminder: ev.reminder_minutes,
  });
}

function calendar(vevents, name = 'Kairos') {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kairos//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, 'X-WR-CALDESC:Exámenes y eventos de Kairos', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
    ...vevents.flat(), 'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { calendar, itemEvent, eventEvent, talkEvent };
