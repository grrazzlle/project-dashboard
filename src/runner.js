import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_OUTPUT = 200_000;
const KEEP_FINISHED_MS = 60 * 60_000;

// In-memory registry of command runs. Output is lost on restart, which is fine
// for a personal dashboard: the process itself dies with the server anyway.
const runs = new Map();

export function startRun(project, user) {
  const id = randomUUID();
  const child = spawn(project.command, {
    shell: true,
    cwd: project.cwd || process.cwd(),
    env: process.env,
  });

  const run = {
    id,
    projectId: project.id,
    command: project.command,
    startedBy: user.displayName,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: '',
    child,
  };

  const append = (chunk) => {
    run.output += chunk.toString();
    if (run.output.length > MAX_OUTPUT) run.output = run.output.slice(-MAX_OUTPUT);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (err) => append(`\n[failed to start: ${err.message}]\n`));
  child.on('close', (code, signal) => {
    run.exitCode = code ?? signal;
    run.finishedAt = new Date().toISOString();
    run.child = null;
    setTimeout(() => runs.delete(id), KEEP_FINISHED_MS).unref();
  });

  runs.set(id, run);
  return publicRun(run);
}

export function getRun(id) {
  const run = runs.get(id);
  return run ? publicRun(run) : null;
}

export function listRuns(projectId) {
  return [...runs.values()]
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(publicRun);
}

export function stopRun(id) {
  const run = runs.get(id);
  if (!run?.child) return false;
  run.child.kill('SIGTERM');
  return true;
}

export function stopAll() {
  for (const run of runs.values()) run.child?.kill('SIGTERM');
}

function publicRun({ child, ...rest }) {
  return { ...rest, running: Boolean(child) };
}
