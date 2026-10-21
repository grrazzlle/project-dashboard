# Project Dashboard

One place for all the projects we've built with Claude. Add a project once, then open it or look up how to use it from any device.

It's a static site on GitHub Pages, so it's free and there's no server to keep running. Projects are saved in [`projects.json`](projects.json) in this repo. Every change is a commit, so you get a full history and can undo anything.

- **Sign in** with a GitHub token. It stays in that browser only.
- **Projects**: name, icon, type, description, link, code repo, how-to-run steps, tags, notes, pin to top. Anyone with access can add, edit and delete, and each card shows who changed it last.
- **Open** launches the project's link in a new tab. **Details → View here** tries to show it inside the dashboard (claude.ai blocks this, so use Open for artifacts).
- **Copy run steps** copies a script's commands so you can paste them into a terminal.
- **Green/red dot** shows whether the project's link is reachable.
- If you both save at the same time, the second save is re-applied on top of the first instead of overwriting it.

## Setup (once)

1. **Turn on Pages:** Settings → Pages → Build and deployment → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save. After a minute the dashboard is at **https://grrazzlle.github.io/project-dashboard/**.
2. **Sign in:** open that link, click *Create a token on GitHub*, generate it, and paste it in.

## Adding someone

1. They need a GitHub account.
2. Settings → Collaborators → Add people, and they accept the email invite.
3. They open the dashboard link and sign in with their own token.

## Privacy

This repo is public, so anyone can read `projects.json`. Only people you add as collaborators can change it. Don't put passwords or private details in notes.

To keep the list private, create a private repo (e.g. `project-dashboard-data`) and change `repo` in [`config.js`](config.js) to its name. The dashboard creates `projects.json` there on the first save. The dashboard itself can stay public.

## Files

- `index.html`, `styles.css`: the page
- `app.js`: dashboard logic
- `github.js`: reads and writes `projects.json` through the GitHub API
- `config.js`: where projects are saved

There's no build step. To try changes locally, run `python3 -m http.server` and open http://localhost:8000.
