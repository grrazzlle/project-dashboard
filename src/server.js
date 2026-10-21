import { createApp } from './app.js';
import { openDb } from './db.js';
import { stopAll } from './runner.js';

const env = process.env;
const port = Number(env.PORT) || 3000;
const host = env.HOST || '0.0.0.0';
const allowCommands = env.ALLOW_COMMANDS === 'true';

const db = openDb(env.DB_PATH || 'data/dashboard.db');
const app = createApp(db, { allowCommands, secureCookies: env.SECURE_COOKIES === 'true' });
if (env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

const server = app.listen(port, host, () => {
  console.log(`Project dashboard running at http://localhost:${port}`);
  console.log(`Running commands: ${allowCommands ? 'ENABLED' : 'disabled (set ALLOW_COMMANDS=true to enable)'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopAll();
    server.close(() => process.exit(0));
  });
}
