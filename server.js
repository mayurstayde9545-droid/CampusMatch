// CampusMatch - dating app for college students. Zero dependencies (Node 22+).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || '';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'campusmatch.db');
const PUBLIC = path.join(__dirname, 'public');
const MIN_AGE = 18;
const MAX_BODY = 1_000_000; // ~1MB (profile photo is sent as a small data URL)

const MYSQL_ENABLED = Boolean(process.env.MYSQL_HOST || process.env.MYSQL_URL);
let mysqlPool;
let db;
if (MYSQL_ENABLED) {
  const mysql = require('mysql2/promise');
  const options = process.env.MYSQL_URL ? process.env.MYSQL_URL : {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'campusmatch',
    ssl: process.env.MYSQL_SSL === 'true' ? {
      rejectUnauthorized: true,
      ...(process.env.MYSQL_SSL_CA ? { ca: process.env.MYSQL_SSL_CA.replace(/\\n/g, '\n') } : {}),
    } : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
  };
  mysqlPool = mysql.createPool(options);
  db = {
    prepare(sql) {
      const statement = sql.replace(/INSERT OR IGNORE INTO/gi, 'INSERT IGNORE INTO')
        .replace(/INSERT OR REPLACE INTO swipes/gi, 'INSERT INTO swipes');
      const duplicateSwipe = /INSERT INTO swipes/i.test(statement);
      return {
        async get(...params) { const [rows] = await mysqlPool.execute(statement, params); return rows[0]; },
        async all(...params) { const [rows] = await mysqlPool.execute(statement, params); return rows; },
        async run(...params) {
          const sql = duplicateSwipe ? statement + ' ON DUPLICATE KEY UPDATE liked = VALUES(liked), created_at = VALUES(created_at)' : statement;
          const [result] = await mysqlPool.execute(sql, params);
          return { lastInsertRowid: Number(result.insertId || 0), changes: result.affectedRows || 0 };
        },
      };
    },
  };
} else {
  db = new DatabaseSync(DB_FILE);
}

let databaseReady = Promise.resolve();
if (!MYSQL_ENABLED) {
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE,
  google_sub TEXT UNIQUE,
  salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  dob TEXT NOT NULL,
  gender TEXT NOT NULL,
  interested_in TEXT NOT NULL,
  college TEXT NOT NULL,
  city TEXT NOT NULL,
  year TEXT NOT NULL,
  course TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  interests TEXT DEFAULT '[]',
  hobbies TEXT DEFAULT '[]',
  photo TEXT DEFAULT '',
  photos TEXT DEFAULT '[]',
  latitude REAL,
  longitude REAL,
  min_age INTEGER NOT NULL DEFAULT 18,
  max_age INTEGER NOT NULL DEFAULT 40,
  radius_km INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tickets (
  ticket TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, google_sub TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS swipes (
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  liked INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (a, b)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker, blocked)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter INTEGER NOT NULL,
  reported INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_match ON messages(match_id, id);
`);

// Keep existing demo databases usable when new profile preferences are added.
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
if (!userColumns.has('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
if (!userColumns.has('google_sub')) db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
for (const [name, definition] of Object.entries({ photos: "TEXT DEFAULT '[]'", hobbies: "TEXT DEFAULT '[]'", latitude: 'REAL', longitude: 'REAL', min_age: 'INTEGER NOT NULL DEFAULT 18', max_age: 'INTEGER NOT NULL DEFAULT 40', radius_km: 'INTEGER NOT NULL DEFAULT 100' })) {
  if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL');
} else {
  const schema = [
    `CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(191) NOT NULL UNIQUE, phone VARCHAR(24) NULL UNIQUE, google_sub VARCHAR(191) NULL UNIQUE,
      salt CHAR(32) NOT NULL, pass_hash CHAR(128) NOT NULL, name VARCHAR(50) NOT NULL, dob DATE NOT NULL,
      gender VARCHAR(20) NOT NULL, interested_in VARCHAR(20) NOT NULL, college VARCHAR(100) NOT NULL,
      city VARCHAR(60) NOT NULL, year VARCHAR(30) NOT NULL, course VARCHAR(80) NOT NULL DEFAULT '',
      bio VARCHAR(400) NOT NULL DEFAULT '', interests TEXT NOT NULL, hobbies TEXT NOT NULL,
      photo MEDIUMTEXT NOT NULL, photos MEDIUMTEXT NOT NULL, latitude DOUBLE NULL, longitude DOUBLE NULL,
      min_age INT NOT NULL DEFAULT 18, max_age INT NOT NULL DEFAULT 40, radius_km INT NOT NULL DEFAULT 100,
      created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token CHAR(64) PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, created_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS oauth_tickets (
      ticket CHAR(64) PRIMARY KEY, email VARCHAR(191) NOT NULL, name VARCHAR(50) NOT NULL,
      google_sub VARCHAR(191) NOT NULL, expires_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash CHAR(64) PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT NULL,
      KEY idx_reset_user (user_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS swipes (
      from_id BIGINT UNSIGNED NOT NULL, to_id BIGINT UNSIGNED NOT NULL, liked TINYINT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY (from_id, to_id), FOREIGN KEY (from_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (to_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS matches (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, a BIGINT UNSIGNED NOT NULL, b BIGINT UNSIGNED NOT NULL,
      created_at BIGINT NOT NULL, UNIQUE KEY idx_matches_pair (a, b),
      FOREIGN KEY (a) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (b) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, match_id BIGINT UNSIGNED NOT NULL,
      sender_id BIGINT UNSIGNED NOT NULL, body VARCHAR(1000) NOT NULL, created_at BIGINT NOT NULL,
      KEY idx_msg_match (match_id, id), FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS blocks (
      blocker BIGINT UNSIGNED NOT NULL, blocked BIGINT UNSIGNED NOT NULL, PRIMARY KEY (blocker, blocked),
      FOREIGN KEY (blocker) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (blocked) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS reports (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, reporter BIGINT UNSIGNED NOT NULL,
      reported BIGINT UNSIGNED NOT NULL, reason VARCHAR(500) NOT NULL, created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];
  databaseReady = (async () => { for (const sql of schema) await mysqlPool.query(sql); })();
}

// ---------- helpers ----------
const now = () => Date.now();
const GENDERS = ['woman', 'man', 'nonbinary'];
const INTEREST_PREF = ['women', 'men', 'everyone'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function ageFromDob(dob) {
  const d = new Date(dob + 'T00:00:00Z');
  if (isNaN(d)) return null;
  const t = new Date();
  let age = t.getUTCFullYear() - d.getUTCFullYear();
  const m = t.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && t.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

function starSign(dob) {
  const monthDay = Number(String(dob || '').slice(5, 7)) * 100 + Number(String(dob || '').slice(8, 10));
  if (!monthDay) return '';
  if (monthDay >= 321 && monthDay <= 419) return 'Aries';
  if (monthDay >= 420 && monthDay <= 520) return 'Taurus';
  if (monthDay >= 521 && monthDay <= 620) return 'Gemini';
  if (monthDay >= 621 && monthDay <= 722) return 'Cancer';
  if (monthDay >= 723 && monthDay <= 822) return 'Leo';
  if (monthDay >= 823 && monthDay <= 922) return 'Virgo';
  if (monthDay >= 923 && monthDay <= 1022) return 'Libra';
  if (monthDay >= 1023 && monthDay <= 1121) return 'Scorpio';
  if (monthDay >= 1122 && monthDay <= 1221) return 'Sagittarius';
  if (monthDay >= 1222 || monthDay <= 119) return 'Capricorn';
  if (monthDay <= 218) return 'Aquarius';
  return 'Pisces';
}

function clean(s, max) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function publicProfile(u) {
  return {
    id: u.id, name: u.name, age: ageFromDob(u.dob), gender: u.gender,
    college: u.college, city: u.city, year: u.year, course: u.course,
    bio: u.bio, interests: JSON.parse(u.interests || '[]'), photo: u.photo,
    photos: JSON.parse(u.photos || (u.photo ? JSON.stringify([u.photo]) : '[]')),
    hobbies: JSON.parse(u.hobbies || '[]'), star_sign: starSign(u.dob),
  };
}
function ownProfile(u) {
  return { ...publicProfile(u), email: u.email, dob: u.dob, interested_in: u.interested_in,
    phone: u.phone || '',
    min_age: u.min_age, max_age: u.max_age };
}

// naive in-memory rate limiter
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const t = now();
  const b = buckets.get(key) || [];
  const recent = b.filter(x => t - x < windowMs);
  if (recent.length >= limit) throw new HttpError(429, 'Too many attempts. Please wait a bit and try again.');
  recent.push(t);
  buckets.set(key, recent);
}
setInterval(() => { const t = now(); for (const [k, v] of buckets) { if (!v.some(x => t - x < 3600_000)) buckets.delete(k); } }, 600_000).unref();

function validatePhoto(p) {
  if (!p) return '';
  if (typeof p !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p)) throw new HttpError(400, 'Photo must be a JPEG, PNG or WebP image.');
  if (p.length > 600_000) throw new HttpError(400, 'Photo is too large.');
  return p;
}

function validateProfileFields(b, { requireAll }) {
  const out = {};
  const need = (k, v) => { if (requireAll && !v) throw new HttpError(400, `Missing field: ${k}`); };
  if (requireAll || b.name !== undefined) { out.name = clean(b.name, 50); need('name', out.name); }
  if (requireAll || b.gender !== undefined) {
    out.gender = clean(b.gender, 20);
    if (!GENDERS.includes(out.gender)) throw new HttpError(400, 'Invalid gender.');
  }
  if (requireAll || b.interested_in !== undefined) {
    out.interested_in = clean(b.interested_in, 20);
    if (!INTEREST_PREF.includes(out.interested_in)) throw new HttpError(400, 'Invalid preference.');
  }
  if (requireAll || b.college !== undefined) { out.college = clean(b.college, 100); need('college', out.college); }
  if (requireAll || b.city !== undefined) { out.city = clean(b.city, 60); need('city', out.city); }
  if (requireAll || b.year !== undefined) { out.year = clean(b.year, 30); need('year', out.year); }
  if (b.course !== undefined) out.course = clean(b.course, 80);
  if (b.bio !== undefined) out.bio = clean(b.bio, 400);
  if (b.interests !== undefined) {
    if (!Array.isArray(b.interests)) throw new HttpError(400, 'Interests must be a list.');
    out.interests = JSON.stringify(b.interests.map(x => clean(x, 24)).filter(Boolean).slice(0, 8));
  }
  if (b.hobbies !== undefined) {
    if (!Array.isArray(b.hobbies)) throw new HttpError(400, 'Hobbies must be a list.');
    out.hobbies = JSON.stringify(b.hobbies.map(x => clean(x, 24)).filter(Boolean).slice(0, 10));
  }
  if (b.photo !== undefined) out.photo = validatePhoto(b.photo);
  if (b.photos !== undefined) {
    if (!Array.isArray(b.photos) || b.photos.length > 6) throw new HttpError(400, 'Upload up to six photos.');
    out.photos = JSON.stringify(b.photos.map(validatePhoto).filter(Boolean));
    out.photo = JSON.parse(out.photos)[0] || '';
  }
  if (b.min_age !== undefined || requireAll) { out.min_age = Number(b.min_age ?? 18); if (!Number.isInteger(out.min_age) || out.min_age < 18 || out.min_age > 40) throw new HttpError(400, 'Minimum age must be between 18 and 40.'); }
  if (b.max_age !== undefined || requireAll) { out.max_age = Number(b.max_age ?? 40); if (!Number.isInteger(out.max_age) || out.max_age < 18 || out.max_age > 40) throw new HttpError(400, 'Maximum age must be between 18 and 40.'); }
  if (out.min_age !== undefined && out.max_age !== undefined && out.min_age > out.max_age) throw new HttpError(400, 'Minimum age cannot exceed maximum age.');
  if (b.radius_km !== undefined || requireAll) { out.radius_km = Number(b.radius_km ?? 100); if (!Number.isInteger(out.radius_km) || out.radius_km < 1 || out.radius_km > 500) throw new HttpError(400, 'Distance must be between 1 and 500 km.'); }
  for (const k of ['latitude', 'longitude']) if (b[k] !== undefined) {
    const n = b[k] === null || b[k] === '' ? null : Number(b[k]);
    if (n !== null && (!Number.isFinite(n) || n < (k === 'latitude' ? -90 : -180) || n > (k === 'latitude' ? 90 : 180))) throw new HttpError(400, 'Invalid location.');
    out[k] = n;
  }
  return out;
}

function ageWithin(u, other) { const age = ageFromDob(other.dob); return age >= u.min_age && age <= u.max_age; }
function interestedClause(pref) {
  if (pref === 'women') return ['woman'];
  if (pref === 'men') return ['man'];
  return GENDERS;
}
function genderWants(u) { // set of genders u wants to see
  return interestedClause(u.interested_in);
}
function wantsMe(other, me) { // does 'other' want to see 'me'?
  return interestedClause(other.interested_in).includes(me.gender);
}

// ---------- auth ----------
async function getUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const row = await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  return row || null;
}
async function requireUser(req) {
  const u = await getUser(req);
  if (!u) throw new HttpError(401, 'Please log in.');
  return u;
}
async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)').run(token, userId, now());
  return token;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('POST', '/api/signup', async (req, body, _p, ip) => {
  rateLimit('signup:' + ip, 10, 3600_000);
  let social = null;
  if (body.google_ticket) social = await db.prepare('SELECT * FROM oauth_tickets WHERE ticket = ? AND expires_at > ?').get(clean(body.google_ticket, 100), now());
  if (body.google_ticket && !social) throw new HttpError(401, 'Google sign-in expired. Please try again.');
  const rawEmail = (social?.email || clean(body.email, 120)).toLowerCase();
  const phone = clean(body.phone, 24).replace(/[\s().-]/g, '');
  if (!rawEmail && !phone) throw new HttpError(400, 'Enter an email address or phone number.');
  if (rawEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail)) throw new HttpError(400, 'Enter a valid email.');
  if (phone && !/^\+?[1-9]\d{7,14}$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number with country code.');
  // Keep the legacy email key populated for phone-only accounts; the synthetic address cannot receive mail.
  const email = rawEmail || `phone.${phone.replace(/\D/g, '')}@phone.campusmatch.invalid`;
  const password = social ? crypto.randomBytes(40).toString('hex') : String(body.password || '');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const dob = clean(body.dob, 10);
  const age = ageFromDob(dob);
  if (age === null) throw new HttpError(400, 'Enter a valid date of birth.');
  if (age < MIN_AGE) throw new HttpError(403, `You must be at least ${MIN_AGE} to join.`);
  if (age > 40) throw new HttpError(400, 'CampusMatch is for college students.');
  if (body.agreed !== true) throw new HttpError(400, 'Please accept the community guidelines.');
  const f = validateProfileFields({ ...body, name: clean(body.name || social?.name, 50) }, { requireAll: true });
  if (await db.prepare(`SELECT 1 FROM users WHERE email = ? OR (? <> '' AND phone = ?)`).get(email, phone, phone)) throw new HttpError(409, 'An account with this email or phone number already exists.');
  const salt = crypto.randomBytes(16).toString('hex');
  const r = await db.prepare(`INSERT INTO users (email, phone, google_sub, salt, pass_hash, name, dob, gender, interested_in, college, city, year, course, bio, interests, hobbies, photo, photos, latitude, longitude, min_age, max_age, radius_km, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    email, phone || null, social?.google_sub || null, salt, hashPassword(password, salt), f.name, dob, f.gender, f.interested_in, f.college, f.city, f.year,
    f.course || '', f.bio || '', f.interests || '[]', f.hobbies || '[]', f.photo || '', f.photos || '[]', f.latitude ?? null, f.longitude ?? null, f.min_age, f.max_age, f.radius_km, now());
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  if (social) await db.prepare('DELETE FROM oauth_tickets WHERE ticket = ?').run(social.ticket);
  return { status: 201, data: { token: await newSession(user.id), user: ownProfile(user) } };
});

route('GET', '/api/config', () => ({ data: { google_client_id: GOOGLE_CLIENT_ID } }));

route('POST', '/api/auth/google', async (_req, body, _p, ip) => {
  rateLimit('google:' + ip, 15, 600_000);
  if (!GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google sign-in is not configured for this site.');
  const credential = String(body.credential || '');
  if (!credential || credential.length > 10_000) throw new HttpError(400, 'Invalid Google credential.');
  let claims;
  try {
    const response = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    if (!response.ok) throw new Error('invalid token');
    claims = await response.json();
  } catch { throw new HttpError(401, 'Google could not verify this sign-in. Please try again.'); }
  if (claims.aud !== GOOGLE_CLIENT_ID || claims.email_verified !== 'true' || !claims.sub || !claims.email) throw new HttpError(401, 'Google account verification failed.');
  const email = clean(claims.email, 120).toLowerCase();
    const user = await db.prepare('SELECT * FROM users WHERE google_sub = ? OR lower(email) = ?').get(claims.sub, email);
  if (user) {
    if (!user.google_sub) await db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(claims.sub, user.id);
    const current = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return { data: { token: await newSession(user.id), user: ownProfile(current) } };
  }
  const ticket = crypto.randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO oauth_tickets (ticket,email,name,google_sub,expires_at) VALUES (?,?,?,?,?)').run(ticket, email, clean(claims.name || email.split('@')[0], 50), claims.sub, now() + 10 * 60_000);
  return { data: { ticket, email, name: clean(claims.name || '', 50), needs_profile: true } };
});

route('POST', '/api/login', async (req, body, _p, ip) => {
  rateLimit('login:' + ip, 20, 600_000);
  const identifier = clean(body.identifier || body.email, 120).toLowerCase();
  const phone = identifier.replace(/[\s().-]/g, '');
  const user = await db.prepare('SELECT * FROM users WHERE lower(email) = ? OR phone = ?').get(identifier, phone);
  const ok = user && crypto.timingSafeEqual(Buffer.from(hashPassword(String(body.password || ''), user.salt), 'hex'), Buffer.from(user.pass_hash, 'hex'));
  if (!ok) throw new HttpError(401, 'Incorrect email or password.');
  return { data: { token: await newSession(user.id), user: ownProfile(user) } };
});

route('POST', '/api/password/forgot', async (_req, body, _p, ip) => {
  rateLimit('password-forgot:' + ip, 6, 15 * 60_000);
  const email = clean(body.email, 120).toLowerCase();
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL || !APP_URL) return { data: { enabled: false } };
  if (validEmail) {
    const user = await db.prepare("SELECT id FROM users WHERE lower(email) = ? AND email NOT LIKE 'phone.%@phone.campusmatch.invalid'").get(email);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at < ?').run(user.id, now());
      await db.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, used_at) VALUES (?,?,?,NULL)')
        .run(tokenHash, user.id, now() + 30 * 60_000);
      const link = APP_URL + '/#/reset-password?token=' + token;
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: RESEND_FROM_EMAIL,
            to: [email],
            subject: 'Reset your CampusMatch password',
            html: `<p>We received a request to reset your CampusMatch password.</p><p><a href="${link}">Choose a new password</a></p><p>This link expires in 30 minutes and can only be used once. If you did not request this, you can ignore this email.</p>`,
          }),
        });
        if (!response.ok) throw new Error('Email provider rejected reset message');
      } catch {
        console.error('Password recovery email could not be sent. Check the email provider settings.');
        await db.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?').run(tokenHash);
      }
    }
  }
  return { data: { enabled: true, message: 'If an account uses that email, a password reset link will arrive shortly.' } };
});

route('POST', '/api/password/reset', async (_req, body, _p, ip) => {
  rateLimit('password-reset:' + ip, 10, 15 * 60_000);
  const token = clean(body.token, 128);
  const password = String(body.password || '');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(400, 'This reset link is invalid or expired. Request a new one.');
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const reset = await db.prepare('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(tokenHash, now());
  if (!reset) throw new HttpError(400, 'This reset link is invalid or expired. Request a new one.');
  const used = await db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').run(now(), tokenHash, now());
  if (!used.changes) throw new HttpError(400, 'This reset link is invalid or expired. Request a new one.');
  const salt = crypto.randomBytes(16).toString('hex');
  await db.prepare('UPDATE users SET salt = ?, pass_hash = ? WHERE id = ?').run(salt, hashPassword(password, salt), reset.user_id);
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);
  await db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(reset.user_id);
  return { data: { ok: true } };
});

route('POST', '/api/logout', async (req) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) await db.prepare('DELETE FROM sessions WHERE token = ?').run(h.slice(7));
  return { data: { ok: true } };
});

route('GET', '/api/me', async (req) => ({ data: { user: ownProfile(await requireUser(req)) } }));

route('PUT', '/api/me', async (req, body) => {
  const u = await requireUser(req);
  const f = validateProfileFields(body, { requireAll: false });
  if ((f.min_age ?? u.min_age) > (f.max_age ?? u.max_age)) throw new HttpError(400, 'Minimum age cannot exceed maximum age.');
  const keys = Object.keys(f);
  if (keys.length) {
    await db.prepare(`UPDATE users SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => f[k]), u.id);
  }
  return { data: { user: ownProfile(await db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) } };
});

route('DELETE', '/api/me', async (req) => {
  const u = await requireUser(req);
  await db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  return { data: { ok: true } };
});

route('GET', '/api/discover', async (req) => {
  const me = await requireUser(req);
  const rows = await db.prepare(`
    SELECT * FROM users u
    WHERE u.id != ?
      AND u.id NOT IN (SELECT to_id FROM swipes WHERE from_id = ?)
      AND u.id NOT IN (SELECT blocked FROM blocks WHERE blocker = ?)
      AND u.id NOT IN (SELECT blocker FROM blocks WHERE blocked = ?)
    ORDER BY (u.city = ?) DESC, (u.college = ?) DESC, RANDOM()
    LIMIT 100`).all(me.id, me.id, me.id, me.id, me.city, me.college);
  const myInterests = new Set(JSON.parse(me.interests || '[]').map(s => s.toLowerCase()));
  const cards = rows.slice(0, 20).map(r => {
    const p = publicProfile(r);
    p.shared_interests = p.interests.filter(i => myInterests.has(i.toLowerCase()));
    return p;
  });
  return { data: { cards } };
});

route('GET', '/api/likes', async (req) => {
  const me = await requireUser(req);
  const rows = await db.prepare(`
    SELECT u.* FROM swipes s JOIN users u ON u.id = s.from_id
    WHERE s.to_id = ? AND s.liked = 1
      AND NOT EXISTS (SELECT 1 FROM swipes mine WHERE mine.from_id = ? AND mine.to_id = u.id)
      AND u.id NOT IN (SELECT blocked FROM blocks WHERE blocker = ?)
      AND u.id NOT IN (SELECT blocker FROM blocks WHERE blocked = ?)
    ORDER BY s.created_at DESC LIMIT 60`).all(me.id, me.id, me.id, me.id);
  const myInterests = new Set(JSON.parse(me.interests || '[]').map(s => s.toLowerCase()));
  const cards = rows.filter(u => {
    if (!genderWants(me).includes(u.gender) || !wantsMe(u, me) || !ageWithin(me, u) || !ageWithin(u, me)) return false;
    return true;
  }).map(u => {
    const p = publicProfile(u);
    p.shared_interests = p.interests.filter(i => myInterests.has(i.toLowerCase()));
    return p;
  });
  return { data: { cards } };
});

route('POST', '/api/swipe', async (req, body) => {
  const me = await requireUser(req);
  const to = Number(body.to);
  const liked = body.like === true ? 1 : 0;
  if (!Number.isInteger(to) || to === me.id) throw new HttpError(400, 'Invalid profile.');
  const other = await db.prepare('SELECT * FROM users WHERE id = ?').get(to);
  if (!other) throw new HttpError(404, 'Profile not found.');
  if (await db.prepare('SELECT 1 FROM blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)').get(me.id, to, to, me.id)) throw new HttpError(403, 'Not available.');
  await db.prepare('INSERT OR REPLACE INTO swipes (from_id, to_id, liked, created_at) VALUES (?,?,?,?)').run(me.id, to, liked, now());
  let match = null;
  if (liked) {
    const back = await db.prepare('SELECT liked FROM swipes WHERE from_id = ? AND to_id = ?').get(to, me.id);
    if (back && back.liked) {
      const [a, b] = me.id < to ? [me.id, to] : [to, me.id];
      await db.prepare('INSERT OR IGNORE INTO matches (a, b, created_at) VALUES (?,?,?)').run(a, b, now());
      const m = await db.prepare('SELECT id FROM matches WHERE a = ? AND b = ?').get(a, b);
      match = { id: m.id, user: publicProfile(other) };
    }
  }
  return { data: { match } };
});

route('GET', '/api/matches', async (req) => {
  const me = await requireUser(req);
  const rows = await db.prepare(`
    SELECT m.id AS match_id, m.created_at AS matched_at, u.*,
      (SELECT body FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_body,
      (SELECT created_at FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_at,
      (SELECT sender_id FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_sender
    FROM matches m
    JOIN users u ON u.id = CASE WHEN m.a = ? THEN m.b ELSE m.a END
    WHERE (m.a = ? OR m.b = ?)
      AND u.id NOT IN (SELECT blocked FROM blocks WHERE blocker = ?)
      AND u.id NOT IN (SELECT blocker FROM blocks WHERE blocked = ?)
    ORDER BY COALESCE(last_at, m.created_at) DESC`).all(me.id, me.id, me.id, me.id, me.id);
  return { data: { matches: rows.map(r => ({
    match_id: r.match_id, matched_at: r.matched_at, user: publicProfile(r),
    last_message: r.last_body ? { body: r.last_body, at: r.last_at, mine: r.last_sender === me.id } : null,
  })) } };
});

async function getMatchFor(me, matchId) {
  const m = await db.prepare('SELECT * FROM matches WHERE id = ? AND (a = ? OR b = ?)').get(Number(matchId), me.id, me.id);
  if (!m) throw new HttpError(404, 'Match not found.');
  const otherId = m.a === me.id ? m.b : m.a;
  if (await db.prepare('SELECT 1 FROM blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)').get(me.id, otherId, otherId, me.id)) throw new HttpError(403, 'This conversation is no longer available.');
  return m;
}

route('GET', '/api/matches/:id/messages', async (req, _b, params, _ip, url) => {
  const me = await requireUser(req);
  const m = await getMatchFor(me, params.id);
  const after = Number(url.searchParams.get('after')) || 0;
  const rows = await db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE match_id = ? AND id > ? ORDER BY id ASC LIMIT 200').all(m.id, after);
  return { data: { messages: rows.map(r => ({ id: r.id, mine: r.sender_id === me.id, body: r.body, at: r.created_at })) } };
});

route('POST', '/api/matches/:id/messages', async (req, body, params) => {
  const me = await requireUser(req);
  const m = await getMatchFor(me, params.id);
  rateLimit('msg:' + me.id, 60, 60_000);
  const text = clean(body.body, 1000);
  if (!text) throw new HttpError(400, 'Message is empty.');
  const r = await db.prepare('INSERT INTO messages (match_id, sender_id, body, created_at) VALUES (?,?,?,?)').run(m.id, me.id, text, now());
  const message = { id: Number(r.lastInsertRowid), sender_id: me.id, mine: true, body: text, at: now() };
  await publishChat(m.id, message);
  return { status: 201, data: { message } };
});

route('POST', '/api/unmatch', async (req, body) => {
  const me = await requireUser(req);
  const m = await getMatchFor(me, body.match_id);
  await db.prepare('DELETE FROM matches WHERE id = ?').run(m.id);
  return { data: { ok: true } };
});

route('POST', '/api/block', async (req, body) => {
  const me = await requireUser(req);
  const target = Number(body.user);
  if (!Number.isInteger(target) || target === me.id) throw new HttpError(400, 'Invalid user.');
  await db.prepare('INSERT OR IGNORE INTO blocks (blocker, blocked) VALUES (?,?)').run(me.id, target);
  return { data: { ok: true } };
});

route('POST', '/api/report', async (req, body) => {
  const me = await requireUser(req);
  rateLimit('report:' + me.id, 10, 3600_000);
  const target = Number(body.user);
  const reason = clean(body.reason, 500);
  if (!Number.isInteger(target) || target === me.id) throw new HttpError(400, 'Invalid user.');
  if (!reason) throw new HttpError(400, 'Please tell us what happened.');
  await db.prepare('INSERT INTO reports (reporter, reported, reason, created_at) VALUES (?,?,?,?)').run(me.id, target, reason, now());
  await db.prepare('INSERT OR IGNORE INTO blocks (blocker, blocked) VALUES (?,?)').run(me.id, target); // reporting also blocks
  return { data: { ok: true } };
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' || Buffer.isBuffer(data) ? (headers['Content-Type'] || 'text/plain; charset=utf-8') : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' https://accounts.google.com; connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com; frame-src https://accounts.google.com; frame-ancestors 'none'",
    ...headers,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
        const out = await r.handler(req, body, m.groups || {}, ip, url);
        return send(res, out.status || 200, out.data, { 'Cache-Control': 'no-store' });
      }
      return send(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, 'Not found');
    }
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Something went wrong.' });
  }
});

// Small native WebSocket endpoint for match chat, keeping the project dependency-free.
const chatSockets = new Map();
function wsFrame(value) {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  if (data.length < 65536) { const head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); return Buffer.concat([head, data]); }
  const head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); return Buffer.concat([head, data]);
}
async function publishChat(matchId, message) {
  const m = await db.prepare('SELECT a, b FROM matches WHERE id = ?').get(matchId);
  if (!m) return;
  for (const userId of [m.a, m.b]) for (const socket of chatSockets.get(userId) || []) {
    if (socket.matchId === matchId && !socket.destroyed) socket.write(wsFrame({ type: 'message', message: { ...message, mine: socket.userId === message.sender_id } }));
  }
}
server.on('upgrade', async (req, socket) => {
  try {
    await databaseReady;
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') return socket.destroy();
    const token = url.searchParams.get('token') || '';
    const me = await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(token);
    if (!me) return socket.destroy();
    const matchId = Number(url.searchParams.get('match'));
    const match = await db.prepare('SELECT * FROM matches WHERE id=? AND (a=? OR b=?)').get(matchId, me.id, me.id);
    if (!match) return socket.destroy();
    const otherId = match.a === me.id ? match.b : match.a;
    if (await db.prepare('SELECT 1 FROM blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)').get(me.id, otherId, otherId, me.id)) return socket.destroy();
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.userId = me.id; socket.matchId = matchId; socket.buffered = Buffer.alloc(0);
    if (!chatSockets.has(me.id)) chatSockets.set(me.id, new Set());
    chatSockets.get(me.id).add(socket);
    socket.on('data', async chunk => {
      socket.buffered = Buffer.concat([socket.buffered, chunk]);
      while (socket.buffered.length >= 2) {
        const first = socket.buffered[0], second = socket.buffered[1]; let length = second & 0x7f, offset = 2;
        if (length === 126) { if (socket.buffered.length < 4) return; length = socket.buffered.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (socket.buffered.length < 10) return; const wide = socket.buffered.readBigUInt64BE(2); if (wide > 10000n) return socket.destroy(); length = Number(wide); offset = 10; }
        const masked = (second & 0x80) !== 0; if (masked) offset += 4;
        if (socket.buffered.length < offset + length) return;
        let payload = Buffer.from(socket.buffered.subarray(offset, offset + length));
        if (masked) { const mask = socket.buffered.subarray(offset - 4, offset); for (let i=0;i<payload.length;i++) payload[i] ^= mask[i & 3]; }
        socket.buffered = socket.buffered.subarray(offset + length);
        if ((first & 0x0f) === 8) return socket.end();
        if ((first & 0x0f) !== 1) continue;
        try {
          const input = JSON.parse(payload.toString('utf8'));
          const body = clean(input.body, 1000); if (!body) continue;
          rateLimit('msg:' + me.id, 60, 60_000);
          const result = await db.prepare('INSERT INTO messages (match_id, sender_id, body, created_at) VALUES (?,?,?,?)').run(matchId, me.id, body, now());
          const message = { id: Number(result.lastInsertRowid), sender_id: me.id, body, at: now() };
          await publishChat(matchId, message);
        } catch {}
      }
    });
    socket.on('close', () => { chatSockets.get(me.id)?.delete(socket); if (!chatSockets.get(me.id)?.size) chatSockets.delete(me.id); });
    socket.on('error', () => { chatSockets.get(me.id)?.delete(socket); });
  } catch { socket.destroy(); }
});

if (require.main === module) {
  databaseReady.then(() => server.listen(PORT, () => console.log(`CampusMatch running on http://localhost:${PORT}`)))
    .catch(error => { console.error('Could not initialize database:', error.message); process.exitCode = 1; });
}
module.exports = server;
