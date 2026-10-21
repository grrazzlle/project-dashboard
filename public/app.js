const $ = (sel) => document.querySelector(sel);

const KIND_LABELS = {
  web: 'Web app',
  artifact: 'Artifact',
  'claude-project': 'Claude',
  repo: 'Repo',
  command: 'Script',
  other: 'Other',
};
const KIND_EMOJI = { web: '🌐', artifact: '✨', 'claude-project': '💬', repo: '📦', command: '⚙️', other: '🧩' };

const state = {
  me: null,
  allowCommands: false,
  projects: [],
  filter: 'all',
  search: '',
  status: {},
};

// ---- Helpers --------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    showAuth(false);
    throw new Error(data.error || 'Not signed in');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

function timeAgo(sqlDate) {
  if (!sqlDate) return '';
  const then = new Date(sqlDate.replace(' ', 'T') + 'Z');
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return then.toLocaleDateString();
}

const tagsOf = (p) => p.tags.split(',').map((t) => t.trim()).filter(Boolean);

document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) closer.closest('dialog').close();
});

// ---- Auth -----------------------------------------------------------------

function showAuth(setup) {
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  $('#auth-form').dataset.mode = setup ? 'setup' : 'login';
  $('#auth-title').textContent = setup ? 'Welcome! Create your account' : 'Sign in';
  $('#auth-hint').textContent = setup ? "You're the first one here. You can add more people after." : '';
  $('#auth-submit').textContent = setup ? 'Create account' : 'Sign in';
  document.querySelectorAll('[data-setup-only]').forEach((el) => { el.hidden = !setup; });
  $('#auth-form [name=password]').autocomplete = setup ? 'new-password' : 'current-password';
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form));
  $('#auth-error').textContent = '';
  try {
    await api(form.dataset.mode === 'setup' ? '/setup' : '/login', { method: 'POST', body });
    form.reset();
    await boot();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showAuth(false);
});

// ---- Dashboard ------------------------------------------------------------

async function boot() {
  const session = await api('/session');
  state.allowCommands = session.allowCommands;
  if (!session.user) return showAuth(session.needsSetup);
  state.me = session.user;
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  await loadProjects();
}

async function loadProjects() {
  state.projects = await api('/projects');
  render();
  checkStatuses();
}

function visibleProjects() {
  const q = state.search.toLowerCase();
  return state.projects.filter((p) => {
    if (state.filter === 'pinned' && !p.pinned) return false;
    if (state.filter.startsWith('kind:') && p.kind !== state.filter.slice(5)) return false;
    if (state.filter.startsWith('tag:') && !tagsOf(p).includes(state.filter.slice(4))) return false;
    if (q && ![p.name, p.description, p.tags, p.notes].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderFilters() {
  const kinds = [...new Set(state.projects.map((p) => p.kind))];
  const tags = [...new Set(state.projects.flatMap(tagsOf))].sort();
  const chips = [['all', 'All']];
  if (state.projects.some((p) => p.pinned)) chips.push(['pinned', '📌 Pinned']);
  kinds.forEach((k) => chips.push([`kind:${k}`, KIND_LABELS[k] || k]));
  tags.forEach((t) => chips.push([`tag:${t}`, `#${t}`]));
  if (!chips.some(([v]) => v === state.filter)) state.filter = 'all';
  $('#filters').innerHTML = state.projects.length
    ? chips.map(([v, label]) => `<button class="chip ${v === state.filter ? 'active' : ''}" data-filter="${esc(v)}">${esc(label)}</button>`).join('')
    : '';
}

function projectCard(p) {
  const status = state.status[p.id];
  const dot = p.url ? `<span class="dot ${status?.state || ''}" title="${esc(statusText(status))}"></span>` : '';
  const actions = [];
  if (p.url) actions.push(`<a class="btn primary small" href="${esc(p.url)}" target="_blank" rel="noopener">Open ↗</a>`);
  if (p.command) {
    actions.push(`<button class="btn small" data-action="run" data-id="${p.id}" ${state.allowCommands ? '' : 'disabled title="Running commands is turned off on the server"'}>▶ Run</button>`);
  }
  if (p.repo_url) actions.push(`<a class="btn small" href="${esc(p.repo_url)}" target="_blank" rel="noopener">Code</a>`);
  actions.push(`<button class="btn small ghost" data-action="detail" data-id="${p.id}">Details</button>`);
  actions.push(`<button class="btn small ghost" data-action="edit" data-id="${p.id}">Edit</button>`);

  return `
    <article class="card project">
      <div class="project-head">
        <div class="project-icon">${esc(p.emoji || KIND_EMOJI[p.kind] || '🧩')}</div>
        <div class="grow">
          <div class="project-title" data-action="detail" data-id="${p.id}">${esc(p.name)}</div>
          <div class="project-meta">
            ${dot}
            <span class="kind">${esc(KIND_LABELS[p.kind] || p.kind)}</span>
            ${tagsOf(p).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
          </div>
        </div>
        ${p.pinned ? '<span class="pin" title="Pinned">📌</span>' : ''}
      </div>
      ${p.description ? `<p class="project-desc">${esc(p.description)}</p>` : ''}
      <div class="project-meta">Updated ${esc(timeAgo(p.updated_at))}${p.updated_by_name ? ` by ${esc(p.updated_by_name)}` : ''}</div>
      <div class="project-actions">${actions.join('')}</div>
    </article>`;
}

function statusText(s) {
  if (!s) return 'Checking…';
  if (s.state === 'up') return `Online (${s.status}, ${s.ms}ms)`;
  if (s.state === 'down') return `Not responding${s.status ? ` (${s.status})` : s.error ? ` (${s.error})` : ''}`;
  return '';
}

function render() {
  renderFilters();
  const list = visibleProjects();
  $('#grid').innerHTML = list.map(projectCard).join('');
  $('#empty').hidden = state.projects.length > 0;
  if (state.projects.length && !list.length) $('#grid').innerHTML = '<p class="muted">Nothing matches.</p>';
}

async function checkStatuses() {
  await Promise.all(state.projects.filter((p) => p.url).map(async (p) => {
    try {
      state.status[p.id] = await api(`/projects/${p.id}/status`);
    } catch {
      state.status[p.id] = { state: 'down' };
    }
  }));
  render();
}

$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  render();
});

$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  render();
});

$('#grid').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const project = state.projects.find((p) => p.id === Number(el.dataset.id));
  if (!project) return;
  if (el.dataset.action === 'edit') openProjectForm(project);
  if (el.dataset.action === 'detail') openDetail(project);
  if (el.dataset.action === 'run') openDetail(project, { run: true });
});

// ---- Add / edit -----------------------------------------------------------

let editing = null;

function openProjectForm(project = null) {
  editing = project;
  const form = $('#project-form');
  form.reset();
  $('#project-error').textContent = '';
  $('#project-dialog-title').textContent = project ? `Edit ${project.name}` : 'Add project';
  $('#delete-project').hidden = !project;
  if (project) {
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') el.checked = Boolean(project[el.name]);
      else el.value = project[el.name] ?? '';
    }
  }
  $('#project-dialog').showModal();
  form.elements.name.focus();
}

$('#new-project').addEventListener('click', () => openProjectForm());
$('#empty-add').addEventListener('click', () => openProjectForm());

$('#project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form));
  body.pinned = form.elements.pinned.checked;
  try {
    if (editing) await api(`/projects/${editing.id}`, { method: 'PATCH', body });
    else await api('/projects', { method: 'POST', body });
    $('#project-dialog').close();
    toast(editing ? 'Saved' : 'Project added');
    await loadProjects();
  } catch (err) {
    $('#project-error').textContent = err.message;
  }
});

$('#delete-project').addEventListener('click', async () => {
  if (!editing || !confirm(`Delete "${editing.name}"? This can't be undone.`)) return;
  await api(`/projects/${editing.id}`, { method: 'DELETE' });
  $('#project-dialog').close();
  toast('Deleted');
  await loadProjects();
});

// ---- Detail / run ---------------------------------------------------------

let pollTimer;
$('#detail-dialog').addEventListener('close', () => {
  clearTimeout(pollTimer);
  $('#detail-content').innerHTML = '';
});

async function openDetail(project, { run = false } = {}) {
  $('#detail-title').textContent = `${project.emoji || KIND_EMOJI[project.kind] || '🧩'} ${project.name}`;
  const sections = [];

  const links = [];
  if (project.url) links.push(`<a class="btn primary" href="${esc(project.url)}" target="_blank" rel="noopener">Open in new tab ↗</a>`);
  if (project.url) links.push('<button class="btn" id="embed-btn">View here</button>');
  if (project.repo_url) links.push(`<a class="btn" href="${esc(project.repo_url)}" target="_blank" rel="noopener">Code</a>`);
  if (project.command) links.push(`<button class="btn" id="run-btn" ${state.allowCommands ? '' : 'disabled'}>▶ Run</button>`);
  links.push('<button class="btn ghost" id="detail-edit">Edit</button>');
  sections.push(`<div class="project-actions">${links.join('')}</div>`);

  if (project.description) sections.push(`<p class="project-desc">${esc(project.description)}</p>`);
  if (project.notes) sections.push(`<div class="detail-section"><h3>Notes</h3><p class="notes">${esc(project.notes)}</p></div>`);
  if (project.command) {
    sections.push(`
      <div class="detail-section">
        <h3>Command</h3>
        <pre class="notes mono">${esc(project.cwd ? `cd ${project.cwd}\n` : '')}${esc(project.command)}</pre>
        ${state.allowCommands ? '' : '<p class="muted">Running commands is off. Start the server with <code>ALLOW_COMMANDS=true</code> to enable the Run button.</p>'}
      </div>`);
  }
  sections.push('<div class="detail-section" id="run-area"></div>');
  sections.push('<div class="detail-section" id="embed-area"></div>');
  sections.push(`<p class="project-meta">Added ${esc(timeAgo(project.created_at))}${project.created_by_name ? ` by ${esc(project.created_by_name)}` : ''} · Updated ${esc(timeAgo(project.updated_at))}${project.updated_by_name ? ` by ${esc(project.updated_by_name)}` : ''}</p>`);

  $('#detail-content').innerHTML = sections.join('');
  $('#detail-dialog').showModal();

  $('#detail-edit').addEventListener('click', () => {
    $('#detail-dialog').close();
    openProjectForm(project);
  });
  $('#embed-btn')?.addEventListener('click', () => {
    $('#embed-area').innerHTML = `
      <h3>Preview</h3>
      <iframe class="embed" src="${esc(project.url)}" referrerpolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"></iframe>
      <p class="muted">Blank? Some sites (including claude.ai) block being shown inside other pages. Use “Open in new tab” instead.</p>`;
  });
  $('#run-btn')?.addEventListener('click', () => startRun(project));

  if (project.command) {
    const runs = await api(`/projects/${project.id}/runs`).catch(() => []);
    const active = runs.find((r) => r.running);
    if (active) watchRun(active.id);
    else if (run) startRun(project);
    else if (runs[0]) watchRun(runs[0].id);
  }
}

async function startRun(project) {
  try {
    const run = await api(`/projects/${project.id}/run`, { method: 'POST' });
    watchRun(run.id);
  } catch (err) {
    toast(err.message);
  }
}

async function watchRun(runId) {
  clearTimeout(pollTimer);
  let run;
  try {
    run = await api(`/runs/${runId}`);
  } catch {
    return;
  }
  const area = $('#run-area');
  if (!area) return;
  const out = area.querySelector('.output');
  const stickToBottom = !out || out.scrollTop + out.clientHeight >= out.scrollHeight - 20;
  area.innerHTML = `
    <h3>Output</h3>
    <div class="run-bar">
      <span class="dot ${run.running ? 'up' : run.exitCode === 0 ? '' : 'down'}"></span>
      <span>${run.running ? 'Running' : `Finished (exit ${esc(run.exitCode)})`} · started by ${esc(run.startedBy)} ${esc(new Date(run.startedAt).toLocaleTimeString())}</span>
      ${run.running ? '<button class="btn small danger" id="stop-run">Stop</button>' : ''}
    </div>
    <pre class="output">${esc(run.output) || '<span class="muted">No output yet…</span>'}</pre>`;
  const newOut = area.querySelector('.output');
  if (stickToBottom) newOut.scrollTop = newOut.scrollHeight;
  else if (out) newOut.scrollTop = out.scrollTop;
  area.querySelector('#stop-run')?.addEventListener('click', () => api(`/runs/${runId}/stop`, { method: 'POST' }));
  if (run.running) pollTimer = setTimeout(() => watchRun(runId), 1000);
}

// ---- People ---------------------------------------------------------------

async function loadPeople() {
  const users = await api('/users');
  $('#people-list').innerHTML = users.map((u) => `
    <li>
      <span><strong>${esc(u.display_name)}</strong> <span class="muted">@${esc(u.username)}</span></span>
      ${u.id === state.me.id ? '<span class="muted">you</span>' : `<button class="btn small danger" data-remove="${u.id}" data-name="${esc(u.display_name)}">Remove</button>`}
    </li>`).join('');
}

$('#open-people').addEventListener('click', async () => {
  await loadPeople();
  $('#people-dialog').showModal();
});

$('#people-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn || !confirm(`Remove ${btn.dataset.name}? They won't be able to sign in.`)) return;
  await api(`/users/${btn.dataset.remove}`, { method: 'DELETE' });
  await loadPeople();
});

$('#add-person-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#person-error').textContent = '';
  try {
    await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    toast('Person added');
    await loadPeople();
  } catch (err) {
    $('#person-error').textContent = err.message;
  }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#password-error').textContent = '';
  try {
    await api('/me/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    toast('Password changed');
  } catch (err) {
    $('#password-error').textContent = err.message;
  }
});

boot().catch((err) => {
  document.body.innerHTML = `<p style="padding:2rem">Couldn't reach the server: ${esc(err.message)}</p>`;
});
