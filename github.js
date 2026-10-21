// Tiny client for keeping a JSON file in a GitHub repo via the contents API.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export async function request(path, { token, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, {
    method,
    headers,
    body: body && JSON.stringify(body),
    cache: 'no-store',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new GitHubError(data?.message || `GitHub request failed (${res.status})`, res.status);
  return data;
}

export class ProjectStore {
  constructor(config, token) {
    this.config = config;
    this.token = token;
    this.sha = null;
  }

  get filePath() {
    const { owner, repo, path } = this.config;
    return `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async load() {
    try {
      const file = await request(`${this.filePath}?ref=${encodeURIComponent(this.config.branch)}`, { token: this.token });
      this.sha = file.sha;
      const data = JSON.parse(decodeBase64(file.content));
      return Array.isArray(data.projects) ? data.projects : [];
    } catch (err) {
      if (err.status === 404) {
        this.sha = null;
        return [];
      }
      throw err;
    }
  }

  // Applies `change` to the latest copy of the list and commits it. If someone
  // else saved in the meantime, reloads and re-applies instead of overwriting.
  async update(change, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const projects = change(await this.load());
      try {
        const result = await request(this.filePath, {
          token: this.token,
          method: 'PUT',
          body: {
            message,
            branch: this.config.branch,
            content: encodeBase64(`${JSON.stringify({ version: 1, projects }, null, 2)}\n`),
            ...(this.sha && { sha: this.sha }),
          },
        });
        this.sha = result.content.sha;
        return projects;
      } catch (err) {
        if (err.status !== 409 && err.status !== 422) throw err;
      }
    }
    throw new GitHubError('Someone else keeps saving at the same time. Try again.', 409);
  }
}
