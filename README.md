# Project Dashboard

One place for all the projects we've built with Claude. Add a project once, then open it, run it, or look up how to use it — from any device.

- **Accounts** — sign-in with username/password. The first person to open it creates the first account; anyone signed in can add more people (👥 button).
- **Projects** — name, icon, type, description, link, code repo, tags, notes, pin to top. Everyone can add, edit and delete. Each card shows who changed it last.
- **Open** — opens the project's link in a new tab. **Details → View here** tries to show it inside the dashboard (some sites, including claude.ai, block that).
- **Online dot** — green/red shows whether the project's link is responding.
- **Run** — for scripts: runs the project's command on the machine the dashboard is running on and shows live output, with a Stop button. Off by default (see below).

## What can be a "project"

| Type | Put this in |
|---|---|
| Web app / website | Link to the deployed site |
| Claude artifact | The `claude.ai/artifact/...` link |
| Claude project / chat | The `claude.ai/project/...` link |
| GitHub repo | Code repo link |
| Script / command | Command (e.g. `npm start`, `python report.py`) and the folder to run it in |

## Run it

Needs Node.js 22.13 or newer.

```sh
npm install
npm start
```

Open http://localhost:3000 and create your account.

To let the Run button execute commands:

```sh
ALLOW_COMMANDS=true npm start
```

Commands run with the same permissions as the dashboard process, so only turn this on where everyone who can sign in is someone you'd trust at your keyboard.

### Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to bind |
| `DB_PATH` | `data/dashboard.db` | SQLite file holding users and projects. Back this up. |
| `ALLOW_COMMANDS` | `false` | Enable the Run button |
| `SECURE_COOKIES` | `false` | Set `true` when served over HTTPS |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy (Caddy, nginx, Fly, Render…) |

### Docker

```sh
docker build -t project-dashboard .
docker run -p 3000:3000 -v dashboard-data:/app/data project-dashboard
```

## Getting it on your phones

Pick one:

- **Home computer + Tailscale** (easiest, stays private): run `npm start` on a computer that stays on, install Tailscale on it and both phones, then open `http://<computer-name>:3000`. This is also the setup where **Run** makes sense, since commands run on that computer next to your project folders.
- **Hosted** (Render, Fly.io, Railway): deploy the Docker image, attach a persistent volume at `/app/data`, and set `SECURE_COOKIES=true` and `TRUST_PROXY=true`. Leave `ALLOW_COMMANDS` off unless your scripts live on that server.

## Development

```sh
npm run dev   # restarts on file changes
npm test
```

- `src/server.js` — startup and settings
- `src/app.js` — API routes
- `src/db.js` — database tables
- `src/auth.js` — passwords and sessions
- `src/runner.js` — running project commands
- `public/` — the web page (plain HTML/CSS/JS, no build step)
