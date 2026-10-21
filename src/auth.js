import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;
export const COOKIE = 'pd_session';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DAYS * 86400_000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return { token, maxAge: SESSION_DAYS * 86400_000 };
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionUser(db, req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, username: row.username, displayName: row.display_name, token };
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters';
  return null;
}

export function validateUsername(username) {
  if (typeof username !== 'string' || !/^[a-z0-9_.-]{2,32}$/i.test(username)) {
    return 'Username must be 2-32 characters: letters, numbers, dot, dash or underscore';
  }
  return null;
}
