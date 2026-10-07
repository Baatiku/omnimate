import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const writeQueues = new Map();

export async function ensureStorage() {
  await fs.mkdir(path.join(config.dataDir, 'projects'), { recursive: true });
}

export function projectDir(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid project id.');
  return path.join(config.dataDir, 'projects', id);
}

export function saveJob(job) {
  const id = job.id;
  const snapshot = JSON.stringify(job, null, 2);
  const previous = writeQueues.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const dir = projectDir(id);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, 'job.json');
    const temp = path.join(dir, `job.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(temp, snapshot);
    await fs.rename(temp, target);
  });
  writeQueues.set(id, next);
  next.finally(() => { if (writeQueues.get(id) === next) writeQueues.delete(id); });
  return next;
}

export async function loadJob(id) {
  try {
    const pending = writeQueues.get(id);
    if (pending) await pending;
    return JSON.parse(await fs.readFile(path.join(projectDir(id), 'job.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listJobs() {
  await ensureStorage();
  const root = path.join(config.dataDir, 'projects');
  const names = await fs.readdir(root, { withFileTypes: true });
  const jobs = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const job = await loadJob(entry.name);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30);
}
