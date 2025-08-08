import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { customAlphabet } from 'nanoid';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Seguridad y performance
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "img-src": ["'self'", "data:", "https:", "http:"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "connect-src": ["'self'"]
    }
  }
}));
app.use(compression());
app.use(express.json({ limit: '256kb' }));

// Archivos estáticos
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));

// Config
const PORT = process.env.PORT || 3000;
const SITE_NAME = process.env.SITE_NAME || 'Restaurante La Escondida';
const BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || '';
const OPEN_TIME = process.env.OPEN_TIME || '12:00';
const CLOSE_TIME = process.env.CLOSE_TIME || '22:00';
const OPEN_DAYS = (process.env.OPEN_DAYS || 'tue,wed,thu,fri,sat,sun')
  .split(',').map(s => s.trim().toLowerCase());
const TIMEZONE = process.env.TIMEZONE || 'America/Santiago';

// Persistencia simple en archivo JSON
const DATA_DIR = path.join(__dirname, 'data');
const RES_FILE = path.join(DATA_DIR, 'reservations.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(RES_FILE)) await fs.writeFile(RES_FILE, JSON.stringify([]), 'utf-8');

const nanoid = customAlphabet('123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8);

// Rate limiting para el endpoint de reservas
const reserveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas solicitudes de reserva. Intenta de nuevo en unos minutos.' }
});

// Helpers
function parseHHMM(str) {
  const [h, m] = str.split(':').map(Number);
  if (Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
    return { h, m };
  }
  return null;
}

function timeInRange(date, openStr, closeStr) {
  const open = parseHHMM(openStr);
  const close = parseHHMM(closeStr);
  if (!open || !close) return true; // no valid bounds => allow
  const d = new Date(date);
  const openDate = new Date(d);
  openDate.setHours(open.h, open.m, 0, 0);
  const closeDate = new Date(d);
  closeDate.setHours(close.h, close.m, 0, 0);
  return d >= openDate && d <= closeDate;
}

function dayToKey(date) {
  // mon..sun
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return days[new Date(date).getDay()];
}

function isFuture(date) {
  return new Date(date).getTime() > Date.now();
}

async function readReservations() {
  const raw = await fs.readFile(RES_FILE, 'utf-8');
  return JSON.parse(raw);
}

async function writeReservations(list) {
  await fs.writeFile(RES_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

// Email (opcional)
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendEmails(reservation) {
  if (!transporter) {
    console.log('[EMAIL] SMTP no configurado. Se omiten correos.');
    return;
  }
  const from = process.env.SMTP_FROM || `${SITE_NAME} <no-reply@localhost>`;
  const internalTo = process.env.NOTIFY_TO || BUSINESS_EMAIL || process.env.SMTP_USER;
  const when = new Date(reservation.datetime).toLocaleString('es-CL', { timeZone: TIMEZONE });

  const internalMsg = {
    from,
    to: internalTo,
    subject: `Nueva reserva (#${reservation.code}) - ${SITE_NAME}`,
    text:
`Nueva reserva recibida:

Código: ${reservation.code}
Nombre: ${reservation.name}
Teléfono: ${reservation.phone}
Email: ${reservation.email || '-'}
Personas: ${reservation.people}
Fecha/Hora: ${when}
Comentarios: ${reservation.notes || '-'}

Archivo: data/reservations.json`,
  };

  const clientMsg = {
    from,
    to: reservation.email,
    subject: `Reserva recibida (#${reservation.code}) - ${SITE_NAME}`,
    text:
`Hola ${reservation.name},

Hemos recibido tu solicitud de reserva en ${SITE_NAME}.
Detalles:
- Código: ${reservation.code}
- Personas: ${reservation.people}
- Fecha/Hora: ${when}
- Comentarios: ${reservation.notes || '-'}

Pronto nos pondremos en contacto para confirmar.

Ubicación:
Chiñihue Las Rosas, Melipilla
Google Maps: https://maps.app.goo.gl/R77LW5YKCLjWikAA9

¡Gracias por preferirnos!`
  };

  try {
    await transporter.sendMail(internalMsg);
  } catch (e) {
    console.error('Error enviando correo interno:', e.message);
  }

  if (reservation.email) {
    try {
      await transporter.sendMail(clientMsg);
    } catch (e) {
      console.error('Error enviando correo al cliente:', e.message);
    }
  }
}

// API de reservas
app.post('/api/reservations', reserveLimiter, async (req, res) => {
  try {
    const { name, phone, email, people, date, time, notes } = req.body || {};
    // Validaciones básicas
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ ok: false, error: 'Nombre inválido.' });
    }
    if (!phone || typeof phone !== 'string' || phone.trim().length < 6) {
      return res.status(400).json({ ok: false, error: 'Teléfono inválido.' });
    }
    const p = Number(people);
    if (!Number.isFinite(p) || p < 1 || p > 20) {
      return res.status(400).json({ ok: false, error: 'Número de personas inválido (1-20).' });
    }
    if (!date || !time) {
      return res.status(400).json({ ok: false, error: 'Fecha y hora son requeridas.' });
    }
    const dt = new Date(`${date}T${time}:00`);
    if (!isFuture(dt)) {
      return res.status(400).json({ ok: false, error: 'La fecha/hora debe ser futura.' });
    }
    const dayKey = dayToKey(dt);
    if (!OPEN_DAYS.includes(dayKey)) {
      return res.status(400).json({ ok: false, error: 'Ese día no atendemos.' });
    }
    if (!timeInRange(dt, OPEN_TIME, CLOSE_TIME)) {
      return res.status(400).json({ ok: false, error: `Horario fuera de rango (${OPEN_TIME}-${CLOSE_TIME}).` });
    }
    if (email && typeof email === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email inválido.' });
    }

    const reservations = await readReservations();
    const code = nanoid();
    const record = {
      id: cryptoRandomId(),
      code,
      createdAt: new Date().toISOString(),
      name: name.trim(),
      phone: phone.trim(),
      email: email ? String(email).trim() : '',
      people: p,
      datetime: dt.toISOString(),
      notes: notes ? String(notes).trim() : '',
      status: 'pending'
    };
    reservations.push(record);
    await writeReservations(reservations);

    // Enviar correos (si se configuró SMTP)
    sendEmails(record).catch(() => {});

    return res.json({ ok: true, message: 'Reserva recibida. Te contactaremos para confirmar.', code });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Error interno. Intenta más tarde.' });
  }
});

// Helper simple para ID
function cryptoRandomId() {
  // Node 18+ tiene crypto.randomUUID, pero mantenemos nanoid para el "code"
  try {
    return crypto.randomUUID();
  } catch {
    return `res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

// Fallback al index.html para rutas desconocidas (SPA-like)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`${SITE_NAME} escuchando en http://localhost:${PORT}`);
});