import config from './config.js';
import { ProjectStore, request } from './github.js';

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'project-dashboard-token';

const KIND_LABELS = {
  web: 'Web app',
  artifact: 'Artifact',
  'claude-project': 'Claude',
  repo: 'Repo',
  command: 'Script',
  other: 'Other',
};
const KIND_EMOJI = { web: '🌐', artifact: '✨', 'claude-project': '💬', repo: '📦', command: '⚙️', other: '🧩' };
const TEXT_FIELDS = ['name', 'emoji', 'kind', 'description', 'url', 'repo_url', 'command', 'notes'];

const state = {
  me: null,
  store: null,
  repoIsPublic: false,
  projects: [],
  filter: 'all',
  search: '',
  status: {},
};

// ---- Helpers --------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

const storage = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (v) => { try { localStorage.setItem(TOKEN_KEY, v); } catch { /* private mode: token lasts this tab only */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ } },
};

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return then.toLocaleDateString();
}

const tagsOf = (p) => (Array.isArray(p.tags) ? p.tags : []);
const parseTags = (s) => [...new Set(s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
const iconOf = (p) => p.emoji || KIND_EMOJI[p.kind] || '🧩';
const repoUrl = `https://github.com/${config.owner}/${config.repo}`;

document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) closer.closest('dialog').close();
});

// ---- Sign in --------------------------------------------------------------

async function showAuth(message = '') {
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  $('#auth-error').textContent = message;
  // A public data repo only needs public_repo; a private one needs full repo access.
  let scope = 'repo';
  try {
    const repo = await request(`/repos/${config.owner}/${config.repo}`);
    if (!repo.private) scope = 'public_repo';
  } catch { /* 404 means private (or missing): keep "repo" */ }
  $('#token-link').href = `https://github.com/settings/tokens/new?description=${encodeURIComponent('Project Dashboard')}&scopes=${scope}`;
}

async function signIn(token) {
  const me = await request('/user', { token });
  let repo;
  try {
    repo = await request(`/repos/${config.owner}/${config.repo}`, { token });
  } catch (err) {
    if (err.status === 404) throw new Error(`Can't see ${config.owner}/${config.repo}. Ask the owner to add @${me.login} as a collaborator.`);
    throw err;
  }
  if (!repo.permissions?.push) {
    throw new Error(`@${me.login} can view but not edit ${config.owner}/${config.repo}. Ask the owner to add you as a collaborator, or make a token with the "${repo.private ? 'repo' : 'public_repo'}" box ticked.`);
  }
  state.me = { login: me.login, name: me.name || me.login, avatar: me.avatar_url };
  state.repoIsPublic = !repo.private;
  state.store = new ProjectStore(config, token);
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = e.target.elements.token.value.trim();
  $('#auth-error').textContent = '';
  $('#auth-submit').disabled = true;
  try {
    await signIn(token);
    storage.set(token);
    e.target.reset();
    await enterApp();
  } catch (err) {
    $('#auth-error').textContent = err.status === 401 ? "GitHub didn't accept that token. Check you copied all of it." : err.message;
  } finally {
    $('#auth-submit').disabled = false;
  }
});

$('#logout').addEventListener('click', () => {
  storage.clear();
  state.me = state.store = null;
  $('#account-dialog').close();
  showAuth();
});

// ---- Dashboard ------------------------------------------------------------

async function boot() {
  const token = storage.get();
  if (!token) return showAuth();
  try {
    await signIn(token);
    await enterApp();
  } catch (err) {
    if (err.status === 401) storage.clear();
    showAuth(err.status === 401 ? 'Your token expired or was revoked. Make a new one.' : err.message);
  }
}

async function enterApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#avatar').src = state.me.avatar;
  $('#avatar').alt = state.me.login;
  $('#public-warning').hidden = !state.repoIsPublic;
  await reload();
}

async function reload() {
  try {
    state.projects = await state.store.load();
  } catch (err) {
    toast(`Couldn't load projects: ${err.message}`);
  }
  render();
  checkStatuses();
}

function sorted(projects) {
  return [...projects].sort((a, b) => (b.pinned - a.pinned) || (b.updated_at || '').localeCompare(a.updated_at || ''));
}

function visibleProjects() {
  const q = state.search.toLowerCase();
  return sorted(state.projects).filter((p) => {
    if (state.filter === 'pinned' && !p.pinned) return false;
    if (state.filter.startsWith('kind:') && p.kind !== state.filter.slice(5)) return false;
    if (state.filter.startsWith('tag:') && !tagsOf(p).includes(state.filter.slice(4))) return false;
    if (q && ![p.name, p.description, tagsOf(p).join(' '), p.notes].join(' ').toLowerCase().includes(q)) return false;
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
  const url = safeUrl(p.url);
  const code = safeUrl(p.repo_url);
  const dot = url ? `<span class="dot ${status || ''}" title="${status === 'up' ? 'Reachable' : status === 'down' ? 'Not reachable' : 'Checking…'}"></span>` : '';
  const actions = [];
  if (url) actions.push(`<a class="btn primary small" href="${esc(url)}" target="_blank" rel="noopener">Open ↗</a>`);
  if (p.command) actions.push(`<button class="btn small" data-action="copy" data-id="${esc(p.id)}">Copy run steps</button>`);
  if (code) actions.push(`<a class="btn small" href="${esc(code)}" target="_blank" rel="noopener">Code</a>`);
  actions.push(`<button class="btn small ghost" data-action="detail" data-id="${esc(p.id)}">Details</button>`);
  actions.push(`<button class="btn small ghost" data-action="edit" data-id="${esc(p.id)}">Edit</button>`);

  return `
    <article class="card project">
      <div class="project-head">
        <div class="project-icon">${esc(iconOf(p))}</div>
        <div class="grow">
          <div class="project-title" data-action="detail" data-id="${esc(p.id)}">${esc(p.name)}</div>
          <div class="project-meta">
            ${dot}
            <span class="kind">${esc(KIND_LABELS[p.kind] || p.kind)}</span>
            ${tagsOf(p).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
          </div>
        </div>
        ${p.pinned ? '<span class="pin" title="Pinned">📌</span>' : ''}
      </div>
      ${p.description ? `<p class="project-desc">${esc(p.description)}</p>` : ''}
      <div class="project-meta">Updated ${esc(timeAgo(p.updated_at))}${p.updated_by ? ` by ${esc(p.updated_by)}` : ''}</div>
      <div class="project-actions">${actions.join('')}</div>
    </article>`;
}

function render() {
  renderFilters();
  const list = visibleProjects();
  $('#grid').innerHTML = list.map(projectCard).join('');
  $('#empty').hidden = state.projects.length > 0;
  if (state.projects.length && !list.length) $('#grid').innerHTML = '<p class="muted">Nothing matches.</p>';
}

// Browsers can't read cross-site responses, but a no-cors request still fails
// outright when the site is down, which is all the dot needs.
async function checkStatuses() {
  await Promise.all(state.projects.filter((p) => safeUrl(p.url)).map(async (p) => {
    try {
      await fetch(p.url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      state.status[p.id] = 'up';
    } catch {
      state.status[p.id] = 'down';
    }
  }));
  render();
}

async function copyRunSteps(project) {
  try {
    await navigator.clipboard.writeText(project.command);
    toast('Copied');
  } catch {
    toast("Couldn't copy. Open Details and copy it from there.");
  }
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
  const project = state.projects.find((p) => p.id === el.dataset.id);
  if (!project) return;
  if (el.dataset.action === 'edit') openProjectForm(project);
  if (el.dataset.action === 'detail') openDetail(project);
  if (el.dataset.action === 'copy') copyRunSteps(project);
});

// ---- Add / edit / delete --------------------------------------------------

let editing = null;

function openProjectForm(project = null) {
  editing = project;
  const form = $('#project-form');
  form.reset();
  $('#project-error').textContent = '';
  $('#project-dialog-title').textContent = project ? `Edit ${project.name}` : 'Add project';
  $('#delete-project').hidden = !project;
  if (project) {
    for (const field of TEXT_FIELDS) form.elements[field].value = project[field] ?? '';
    form.elements.tags.value = tagsOf(project).join(', ');
    form.elements.pinned.checked = Boolean(project.pinned);
  }
  $('#project-dialog').showModal();
  form.elements.name.focus();
}

async function save(change, message, busyButton) {
  busyButton.disabled = true;
  try {
    state.projects = await state.store.update(change, `${message} (via dashboard)`);
    render();
    checkStatuses();
    return true;
  } finally {
    busyButton.disabled = false;
  }
}

$('#new-project').addEventListener('click', () => openProjectForm());
$('#empty-add').addEventListener('click', () => openProjectForm());

$('#project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fields = {};
  for (const field of TEXT_FIELDS) fields[field] = form.elements[field].value.trim();
  fields.tags = parseTags(form.elements.tags.value);
  fields.pinned = form.elements.pinned.checked;
  const now = new Date().toISOString();
  const who = state.me.login;
  const id = editing?.id;

  try {
    if (id) {
      await save(
        (list) => {
          if (!list.some((p) => p.id === id)) throw new Error('Someone deleted this project while you were editing it.');
          return list.map((p) => (p.id === id ? { ...p, ...fields, updated_at: now, updated_by: who } : p));
        },
        `Update ${fields.name}`,
        $('#save-project'),
      );
    } else {
      const project = { id: crypto.randomUUID(), ...fields, created_at: now, created_by: who, updated_at: now, updated_by: who };
      await save((list) => [...list, project], `Add ${fields.name}`, $('#save-project'));
    }
    $('#project-dialog').close();
    toast(id ? 'Saved' : 'Project added');
  } catch (err) {
    $('#project-error').textContent = err.message;
  }
});

$('#delete-project').addEventListener('click', async () => {
  if (!editing || !confirm(`Delete "${editing.name}"? You can still get it back from the repo history.`)) return;
  const { id, name } = editing;
  try {
    await save((list) => list.filter((p) => p.id !== id), `Delete ${name}`, $('#delete-project'));
    $('#project-dialog').close();
    toast('Deleted');
  } catch (err) {
    $('#project-error').textContent = err.message;
  }
});

// ---- Detail ---------------------------------------------------------------

$('#detail-dialog').addEventListener('close', () => { $('#detail-content').innerHTML = ''; });

function openDetail(project) {
  const url = safeUrl(project.url);
  const code = safeUrl(project.repo_url);
  $('#detail-title').textContent = `${iconOf(project)} ${project.name}`;

  const links = [];
  if (url) links.push(`<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">Open in new tab ↗</a>`);
  if (url) links.push('<button class="btn" id="embed-btn">View here</button>');
  if (code) links.push(`<a class="btn" href="${esc(code)}" target="_blank" rel="noopener">Code</a>`);
  links.push('<button class="btn ghost" id="detail-edit">Edit</button>');

  const sections = [`<div class="project-actions">${links.join('')}</div>`];
  if (project.description) sections.push(`<p class="project-desc">${esc(project.description)}</p>`);
  if (project.command) {
    sections.push(`
      <div class="detail-section">
        <div class="section-head"><h3>How to run it</h3><button class="btn small" id="copy-cmd">Copy</button></div>
        <pre class="notes mono">${esc(project.command)}</pre>
      </div>`);
  }
  if (project.notes) sections.push(`<div class="detail-section"><h3>Notes</h3><p class="notes">${esc(project.notes)}</p></div>`);
  sections.push('<div class="detail-section" id="embed-area"></div>');
  sections.push(`<p class="project-meta">Added ${esc(timeAgo(project.created_at))}${project.created_by ? ` by ${esc(project.created_by)}` : ''} · Updated ${esc(timeAgo(project.updated_at))}${project.updated_by ? ` by ${esc(project.updated_by)}` : ''}</p>`);

  $('#detail-content').innerHTML = sections.join('');
  $('#detail-dialog').showModal();

  $('#detail-edit').addEventListener('click', () => {
    $('#detail-dialog').close();
    openProjectForm(project);
  });
  $('#copy-cmd')?.addEventListener('click', () => copyRunSteps(project));
  $('#embed-btn')?.addEventListener('click', () => {
    $('#embed-area').innerHTML = `
      <h3>Preview</h3>
      <iframe class="embed" src="${esc(url)}" referrerpolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"></iframe>
      <p class="muted">Blank? Some sites (including claude.ai) block being shown inside other pages. Use “Open in new tab” instead.</p>`;
  });
}

// ---- Account --------------------------------------------------------------

$('#open-account').addEventListener('click', () => {
  $('#account-name').textContent = `${state.me.name} (@${state.me.login})`;
  const dataLink = $('#data-link');
  dataLink.href = `${repoUrl}/blob/${config.branch}/${config.path}`;
  dataLink.textContent = `${config.owner}/${config.repo}/${config.path}`;
  $('#collab-link').href = `${repoUrl}/settings/access`;
  $('#account-dialog').showModal();
});

boot();
