import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

let server;
let base;

before(async () => {
  const app = createApp(openDb(':memory:'), { allowCommands: true });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

test('setup, projects, users and runs', async () => {
  const me = client();
  assert.equal((await me('/session')).body.needsSetup, true);
  assert.equal((await me('/projects')).status, 401);

  assert.equal((await me('/setup', { method: 'POST', body: { username: 'chris', password: 'short' } })).status, 400);
  assert.equal((await me('/setup', { method: 'POST', body: { username: 'chris', displayName: 'Chris', password: 'longenough' } })).status, 200);
  assert.equal((await me('/session')).body.user.displayName, 'Chris');

  // Setup is one-time only
  const stranger = client();
  assert.equal((await stranger('/setup', { method: 'POST', body: { username: 'x', password: 'longenough' } })).status, 403);

  // Projects
  assert.equal((await me('/projects', { method: 'POST', body: { name: 'Bad', url: 'javascript:alert(1)' } })).status, 400);
  const created = await me('/projects', { method: 'POST', body: { name: 'Hello', kind: 'command', command: 'echo hi', tags: 'fun' } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const patched = await me(`/projects/${id}`, { method: 'PATCH', body: { description: 'says hi', pinned: true } });
  assert.equal(patched.body.description, 'says hi');
  assert.equal(patched.body.pinned, 1);

  // Run a command and wait for it to finish
  const run = await me(`/projects/${id}/run`, { method: 'POST' });
  assert.equal(run.status, 201);
  let result;
  for (let i = 0; i < 50; i++) {
    result = (await me(`/runs/${run.body.id}`)).body;
    if (!result.running) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.trim(), 'hi');

  // Add a second person; they can sign in and edit
  assert.equal((await me('/users', { method: 'POST', body: { username: 'partner', password: 'anotherpass' } })).status, 201);
  const partner = client();
  assert.equal((await partner('/login', { method: 'POST', body: { username: 'partner', password: 'nope' } })).status, 401);
  assert.equal((await partner('/login', { method: 'POST', body: { username: 'Partner', password: 'anotherpass' } })).status, 200);
  const edited = await partner(`/projects/${id}`, { method: 'PATCH', body: { name: 'Hello there' } });
  assert.equal(edited.body.updated_by_name, 'partner');
  assert.equal(edited.body.created_by_name, 'Chris');

  // Non-JSON mutations are rejected (CSRF guard)
  const form = await fetch(`${base}/projects/${id}`, { method: 'DELETE' });
  assert.equal(form.status, 415);

  assert.equal((await partner(`/projects/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await me('/projects')).body.length, 0);

  await me('/logout', { method: 'POST' });
  assert.equal((await me('/projects')).status, 401);
});

test('commands are blocked unless enabled', async () => {
  const app = createApp(openDb(':memory:'));
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  const url = `http://127.0.0.1:${s.address().port}/api`;
  const post = (p, body, cookie = '') => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  const res = await post('/setup', { username: 'chris', password: 'longenough' });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const project = await (await post('/projects', { name: 'x', command: 'echo no' }, cookie)).json();
  assert.equal((await post(`/projects/${project.id}/run`, {}, cookie)).status, 403);
  s.close();
});
