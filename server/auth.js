/* ==========================================================================
 * Street Light GIS · server/auth.js
 * Staff passwords (scrypt), sessions (random tokens, stored hashed), citizen phone OTP and rate limits.
 * A citizen's phone number is never stored: once verified, it becomes a reporter ID (a keyed hash),
 * so track records follow the person without keeping their number.
 * ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STAFF_SESSION_HOURS = 12;           // one shift; staff sign in again after this
const CITIZEN_SESSION_DAYS = 30;          // a verified phone stays verified on that device this long
const OTP_MINUTES = 5;                    // a code is valid this long
const OTP_MAX_ATTEMPTS = 5;               // wrong codes before it must be sent again
const LIMITS = {                          // [events, per minutes]
  otpPerPhone: [3, 60],
  otpPerIp: [10, 60],
  loginPerUser: [10, 15],
  loginPerIp: [30, 15],
  citizenWritePerIp: [60, 60],
};
const ROLES = ['operator', 'field', 'management'];
const PHONE = /^[6-9]\d{9}$/;             // Indian mobile, without +91

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
// Spend the same time when the user does not exist, so timing does not reveal valid usernames.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

/** +91 98765 43210, 098765-43210, 9876543210 → 9876543210, or null. */
function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/[\s()-]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return PHONE.test(d) ? d : null;
}

class Auth {
  constructor(store, secret) {
    this.store = store;
    this.secret = secret;
    const db = store.db;
    this.q = {
      user: db.prepare('SELECT username, name, roles, crew, password, disabled FROM users WHERE username = ?'),
      users: db.prepare('SELECT username, name, roles, crew, disabled FROM users ORDER BY username'),
      addUser: db.prepare('INSERT INTO users (username, name, roles, crew, password, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      setPassword: db.prepare('UPDATE users SET password = ? WHERE username = ?'),
      setDisabled: db.prepare('UPDATE users SET disabled = ? WHERE username = ?'),
      addSession: db.prepare('INSERT INTO sessions (token_hash, kind, subject, expires_at) VALUES (?, ?, ?, ?)'),
      session: db.prepare('SELECT kind, subject, expires_at FROM sessions WHERE token_hash = ?'),
      endSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      endUserSessions: db.prepare("DELETE FROM sessions WHERE kind = 'staff' AND subject = ?"),
      purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
      putOtp: db.prepare(`INSERT INTO otps (phone_hash, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
        ON CONFLICT (phone_hash) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`),
      otp: db.prepare('SELECT code_hash, expires_at, attempts FROM otps WHERE phone_hash = ?'),
      otpAttempt: db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone_hash = ?'),
      delOtp: db.prepare('DELETE FROM otps WHERE phone_hash = ?'),
      purgeOtps: db.prepare('DELETE FROM otps WHERE expires_at < ?'),
      hit: db.prepare('INSERT INTO hits (bucket, at) VALUES (?, ?)'),
      hits: db.prepare('SELECT COUNT(*) AS n FROM hits WHERE bucket = ? AND at > ?'),
      purgeHits: db.prepare('DELETE FROM hits WHERE at < ?'),
    };
  }

  keyed(label, value) { return crypto.createHmac('sha256', this.secret).update(`${label}:${value}`).digest('hex'); }
  /** The reporter ID for a verified phone: stable, but the number cannot be read back from it. */
  reporterId(phone) { return `RP-${this.keyed('reporter', phone).slice(0, 10).toUpperCase()}`; }

  // ---- rate limits ----
  /** Count an event; returns false (and does not count it) when the limit is already reached. */
  allow(name, key) {
    const [max, minutes] = LIMITS[name];
    const bucket = `${name}:${key}`;
    const now = Date.now();
    if (this.q.hits.get(bucket, now - minutes * 60e3).n >= max) return false;
    this.q.hit.run(bucket, now);
    return true;
  }

  // ---- staff ----
  addUser({ username, name, roles, crew = null, password }) {
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('username: 3–32 of a–z, 0–9, . _ -');
    const list = roles.map((r) => r.trim()).filter(Boolean);
    if (!list.length || list.some((r) => !ROLES.includes(r))) throw new Error(`roles: one or more of ${ROLES.join(', ')}`);
    if (list.includes('field') && !crew) throw new Error('field crew users need --crew (e.g. "R2 · Deepak R.")');
    if (String(password).length < 10) throw new Error('password: at least 10 characters');
    this.q.addUser.run(username, name || username, list.join(','), crew, hashPassword(password), new Date().toISOString());
  }
  setPassword(username, password) {
    if (String(password).length < 10) throw new Error('password: at least 10 characters');
    if (!this.q.setPassword.run(hashPassword(password), username).changes) throw new Error(`no user ${username}`);
    this.q.endUserSessions.run(username);
  }
  setDisabled(username, disabled) {
    if (!this.q.setDisabled.run(disabled ? 1 : 0, username).changes) throw new Error(`no user ${username}`);
    if (disabled) this.q.endUserSessions.run(username);
  }
  users() { return this.q.users.all().map((u) => ({ ...u, roles: u.roles.split(','), disabled: Boolean(u.disabled) })); }

  /** Returns the user (without the hash) or null. */
  login(username, password) {
    const u = this.q.user.get(String(username ?? ''));
    const ok = checkPassword(String(password ?? ''), u?.password ?? DUMMY_HASH);
    if (!u || !ok || u.disabled) return null;
    return { username: u.username, name: u.name, roles: u.roles.split(','), crew: u.crew };
  }

  // ---- sessions ----
  startSession(kind, subject, ms) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.q.addSession.run(sha256(token), kind, subject, Date.now() + ms);
    return token;
  }
  staffSession(username) { return this.startSession('staff', username, STAFF_SESSION_HOURS * 3.6e6); }
  citizenSession(reporterId) { return this.startSession('citizen', reporterId, CITIZEN_SESSION_DAYS * 864e5); }
  endSession(token) { if (token) this.q.endSession.run(sha256(token)); }

  /** Who a request is: { kind: 'staff', user } | { kind: 'citizen', reporterId } | null. */
  whoIs(token) {
    if (!token) return null;
    const s = this.q.session.get(sha256(token));
    if (!s || s.expires_at < Date.now()) return null;
    if (s.kind === 'citizen') return { kind: 'citizen', reporterId: s.subject };
    const u = this.q.user.get(s.subject);
    if (!u || u.disabled) return null;
    return { kind: 'staff', user: { username: u.username, name: u.name, roles: u.roles.split(','), crew: u.crew } };
  }

  // ---- citizen OTP ----
  /** A new 6-digit code for this phone (the caller sends it). */
  newOtp(phone) {
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    this.q.putOtp.run(this.keyed('phone', phone), this.keyed('otp', `${phone}:${code}`), Date.now() + OTP_MINUTES * 60e3);
    return code;
  }
  /** 'ok' | 'wrong' | 'expired' | 'locked'. A used code is deleted. */
  checkOtp(phone, code) {
    const key = this.keyed('phone', phone);
    const row = this.q.otp.get(key);
    if (!row || row.expires_at < Date.now()) return 'expired';
    if (row.attempts >= OTP_MAX_ATTEMPTS) return 'locked';
    const want = Buffer.from(row.code_hash, 'hex');
    const got = Buffer.from(this.keyed('otp', `${phone}:${String(code ?? '').trim()}`), 'hex');
    if (!crypto.timingSafeEqual(want, got)) {
      this.q.otpAttempt.run(key);
      return 'wrong';
    }
    this.q.delOtp.run(key);
    return 'ok';
  }

  purge() {
    const now = Date.now();
    this.q.purgeSessions.run(now);
    this.q.purgeOtps.run(now);
    this.q.purgeHits.run(now - 24 * 3.6e6);
  }
}

/** The key for sessions, OTP and reporter IDs: SESSION_SECRET, or a random one kept in DATA_DIR/secret. */
function loadSecret(env, dataDir) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = path.join(dataDir, 'secret');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

module.exports = { Auth, loadSecret, normalizePhone, hashPassword, checkPassword, ROLES, OTP_MINUTES, STAFF_SESSION_HOURS, CITIZEN_SESSION_DAYS };
