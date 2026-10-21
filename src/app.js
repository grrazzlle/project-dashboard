import express from 'express';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  COOKIE, createSession, hashPassword, sessionUser,
  validatePassword, validateUsername, verifyPassword,
} from './auth.js';
import { getRun, listRuns, startRun, stopRun } from './runner.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const KINDS = ['web', 'artifact', 'claude-project', 'repo', 'command', 'other'];
const PROJECT_FIELDS = ['name', 'description', 'kind', 'url', 'repo_url', 'command', 'cwd', 'emoji', 'tags', 'notes', 'pinned'];

export function createApp(db, { allowCommands = false, secureCookies = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(PUBLIC_DIR));

  // Mutating API calls must be JSON. Browsers can't send cross-site JSON without
  // a CORS preflight we never approve, so this doubles as CSRF protection.
  app.use('/api', (req, res, next) => {
    const type = req.get('content-type') || '';
    if (['GET', 'HEAD'].includes(req.method) || type.split(';')[0].trim() === 'application/json') return next();
    res.status(415).json({ error: 'Expected application/json' });
  });

  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const setSessionCookie = (res, userId) => {
    const { token, maxAge } = createSession(db, userId);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge, path: '/' });
  };

  const requireUser = (req, res, next) => {
    const user = sessionUser(db, req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    req.user = user;
    next();
  };

  // ---- Auth ---------------------------------------------------------------

  app.get('/api/session', (req, res) => {
    const user = sessionUser(db, req);
    res.json({
      user: user && { id: user.id, username: user.username, displayName: user.displayName },
      needsSetup: userCount() === 0,
      allowCommands,
    });
  });

  // First-run only: creates the first account when the database is empty.
  app.post('/api/setup', (req, res) => {
    if (userCount() > 0) return res.status(403).json({ error: 'Setup already done' });
    const result = insertUser(db, req.body);
    if (result.error) return res.status(400).json(result);
    setSessionCookie(res, result.id);
    res.json({ ok: true });
  });

  const failedLogins = new Map();
  app.post('/api/login', (req, res) => {
    const key = req.ip;
    const attempts = failedLogins.get(key) || { count: 0, until: 0 };
    if (attempts.until > Date.now()) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    }
    const { username, password } = req.body || {};
    const row = typeof username === 'string'
      ? db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username.trim())
      : null;
    if (!row || typeof password !== 'string' || !verifyPassword(password, row.password_hash)) {
      attempts.count += 1;
      if (attempts.count >= 5) Object.assign(attempts, { count: 0, until: Date.now() + 60_000 });
      failedLogins.set(key, attempts);
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    failedLogins.delete(key);
    setSessionCookie(res, row.id);
    res.json({ ok: true });
  });

  app.post('/api/logout', requireUser, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.user.token);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ---- Users --------------------------------------------------------------
  // Everyone who can sign in is trusted equally: any user can add another.

  app.get('/api/users', requireUser, (req, res) => {
    res.json(db.prepare('SELECT id, username, display_name, created_at FROM users ORDER BY id').all());
  });

  app.post('/api/users', requireUser, (req, res) => {
    const result = insertUser(db, req.body);
    if (result.error) return res.status(400).json(result);
    res.status(201).json({ id: result.id });
  });

  app.delete('/api/users/:id', requireUser, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: "You can't remove yourself" });
    const { changes } = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (!changes) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  });

  app.post('/api/me/password', requireUser, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, row.password_hash)) {
      return res.status(400).json({ error: 'Current password is wrong' });
    }
    const error = validatePassword(newPassword);
    if (error) return res.status(400).json({ error });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.user.token);
    res.json({ ok: true });
  });

  // ---- Projects -----------------------------------------------------------

  const selectProject = `
    SELECT p.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
    FROM projects p
    LEFT JOIN users cu ON cu.id = p.created_by
    LEFT JOIN users uu ON uu.id = p.updated_by
  `;
  const findProject = (id) => db.prepare(`${selectProject} WHERE p.id = ?`).get(Number(id));

  app.get('/api/projects', requireUser, (req, res) => {
    res.json(db.prepare(`${selectProject} ORDER BY p.pinned DESC, p.updated_at DESC`).all());
  });

  app.get('/api/projects/:id', requireUser, (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  app.post('/api/projects', requireUser, (req, res) => {
    const { error, values } = cleanProject(req.body, true);
    if (error) return res.status(400).json({ error });
    const cols = Object.keys(values);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO projects (${cols.join(', ')}, created_by, updated_by)
      VALUES (${cols.map(() => '?').join(', ')}, ?, ?)
    `).run(...Object.values(values), req.user.id, req.user.id);
    res.status(201).json(findProject(lastInsertRowid));
  });

  app.patch('/api/projects/:id', requireUser, (req, res) => {
    if (!findProject(req.params.id)) return res.status(404).json({ error: 'Project not found' });
    const { error, values } = cleanProject(req.body, false);
    if (error) return res.status(400).json({ error });
    const cols = Object.keys(values);
    if (cols.length) {
      db.prepare(`
        UPDATE projects SET ${cols.map((c) => `${c} = ?`).join(', ')},
          updated_by = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(...Object.values(values), req.user.id, Number(req.params.id));
    }
    res.json(findProject(req.params.id));
  });

  app.delete('/api/projects/:id', requireUser, (req, res) => {
    const { changes } = db.prepare('DELETE FROM projects WHERE id = ?').run(Number(req.params.id));
    if (!changes) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  });

  // Is the project's URL reachable? Checked server-side so CORS doesn't get in the way.
  app.get('/api/projects/:id/status', requireUser, async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.url) return res.json({ state: 'none' });
    const started = Date.now();
    try {
      const r = await fetch(project.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      res.json({ state: r.status < 500 ? 'up' : 'down', status: r.status, ms: Date.now() - started });
    } catch (err) {
      res.json({ state: 'down', error: err.cause?.code || err.name });
    }
  });

  // ---- Running commands ---------------------------------------------------

  const requireCommands = (req, res, next) => {
    if (!allowCommands) {
      return res.status(403).json({ error: 'Running commands is turned off. Set ALLOW_COMMANDS=true on the server to enable it.' });
    }
    next();
  };

  app.post('/api/projects/:id/run', requireUser, requireCommands, (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.command) return res.status(400).json({ error: 'This project has no command set' });
    db.prepare("UPDATE projects SET last_run_at = datetime('now') WHERE id = ?").run(project.id);
    res.status(201).json(startRun(project, req.user));
  });

  app.get('/api/projects/:id/runs', requireUser, (req, res) => {
    res.json(listRuns(Number(req.params.id)));
  });

  app.get('/api/runs/:runId', requireUser, (req, res) => {
    const run = getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  app.post('/api/runs/:runId/stop', requireUser, requireCommands, (req, res) => {
    res.json({ stopped: stopRun(req.params.runId) });
  });

  // ---- Fallbacks ----------------------------------------------------------

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('/{*path}', (req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

function insertUser(db, body = {}) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const displayName = typeof body.displayName === 'string' && body.displayName.trim()
    ? body.displayName.trim().slice(0, 64)
    : username;
  const error = validateUsername(username) || validatePassword(body.password);
  if (error) return { error };
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return { error: 'That username is taken' };
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)',
  ).run(username, displayName, hashPassword(body.password));
  return { id: Number(lastInsertRowid) };
}

function cleanProject(body = {}, isCreate) {
  const values = {};
  for (const field of PROJECT_FIELDS) {
    if (!(field in body)) continue;
    const v = body[field];
    if (field === 'pinned') {
      values.pinned = v ? 1 : 0;
      continue;
    }
    if (typeof v !== 'string') return { error: `${field} must be text` };
    values[field] = v.trim().slice(0, field === 'notes' ? 20_000 : 2_000);
  }
  if (isCreate && !values.name) return { error: 'Name is required' };
  if ('name' in values && !values.name) return { error: 'Name is required' };
  if ('kind' in values && !KINDS.includes(values.kind)) return { error: `Kind must be one of: ${KINDS.join(', ')}` };
  for (const field of ['url', 'repo_url']) {
    if (values[field] && !/^https?:\/\//i.test(values[field])) {
      return { error: `${field === 'url' ? 'Link' : 'Repo link'} must start with http:// or https://` };
    }
  }
  return { values };
}
