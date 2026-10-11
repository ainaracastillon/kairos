# Kairos

Tu horario escolar, tus tareas y tus exámenes en un solo sitio, con recordatorios por correo y notificaciones en el móvil.

## Qué incluye

- **Mes**: calendario con tus clases, tareas, exámenes y eventos de cada día.
- **Horario**: cuadrícula semanal con colores por asignatura, aulas, selección de varias casillas, 10 fondos y descarga como imagen.
- **Tareas y exámenes**: con checklist de pasos, filtros por tipo y asignatura, y avisos.
- **Asignaturas y subasignaturas**, con aula, profesor/a y color.
- **Varios horarios** (por ejemplo, uno por cuatrimestre), cada uno con sus días, tramos y fechas.
- **Avisos** por correo y notificaciones push, y resumen diario opcional.
- Se instala en el móvil como app (PWA) y tiene modo oscuro automático.

## Probarla en tu ordenador

Necesitas Node.js 22.13 o posterior.

```bash
npm install
npm start
```

Abre http://localhost:3000. Sin configurar nada, los datos se guardan en `data/kairos.db` y los correos se muestran en la consola.

## Publicarla en Render

1. Sube esta carpeta a un repositorio de GitHub.
2. En Render, elige **New → Blueprint** y selecciona el repositorio. El archivo `render.yaml` crea la web y una base de datos Postgres.
3. Para que lleguen los correos, crea una cuenta gratuita en brevo.com, verifica tu correo como remitente y añade en Render `BREVO_API_KEY` y `MAIL_FROM` (por ejemplo `Kairos <tucorreo@gmail.com>`).

## Variables de entorno

| Variable | Para qué sirve |
| --- | --- |
| `DATABASE_URL` | Postgres. Si no está, se usa SQLite en `DATA_DIR` (por defecto `./data`). |
| `BREVO_API_KEY` | Envío de correo por la API de Brevo (gratis, 300 al día; no necesita dominio propio). |
| `RESEND_API_KEY` | Envío de correo por la API de Resend (necesita dominio propio para escribir a cualquiera). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | Alternativa: envío por SMTP. |
| `MAIL_FROM` | Remitente de los correos. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Claves de las notificaciones push. Si faltan, se generan solas y se guardan en la base de datos. |
| `APP_URL` | Dirección pública, para el botón «Abrir Kairos» de los correos. |
| `PORT` | Puerto (Render lo pone solo). |

## Estructura

- `public/`: la app (HTML, CSS, JavaScript, service worker, iconos).
- `public/fonts/`: las tipografías Figtree y Fraunces, incluidas en el código bajo la licencia SIL Open Font License 1.1 (ver los archivos `OFL-*.txt`).
- `server/server.js`: API y servidor de archivos.
- `server/db.js`: base de datos (SQLite o Postgres).
- `server/reminders.js`: avisos y resumen diario.
- `server/notify.js`: correo y notificaciones push.
