import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const port = 18000 + (process.pid % 1000);
const baseUrl = 'http://127.0.0.1:' + port;

async function waitForServer(child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error('server exited early with code ' + child.exitCode);
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

test('local server boots and serves the studio without a Gemini key', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimate-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), GEMINI_API_KEY: '', OMNIMATE_GEMINI_RPM: '5', OMNIMATE_GEMINI_RATE_SAFETY_MS: '1000', OMNIMATE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitForServer(child);
  const health = await fetch(baseUrl + '/api/health').then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.geminiConfigured, false);
  assert.equal(health.textModel, 'gemini-3.8-flash');
  assert.equal(health.liveModel, 'gemini-3.8-live');
  assert.equal(health.geminiQuota.rpm, 5);
  assert.equal(health.geminiQuota.minIntervalMs, 13000);
  const home = await fetch(baseUrl + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') || '', /^text\/html/);
  assert.match(await home.text(), /Omnimate/i);
  const app = await fetch(baseUrl + '/app.js');
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type') || '', /^text\/javascript/);
  assert.match(await app.text(), /StudioRenderer/);
  const productions = await fetch(baseUrl + '/api/productions').then((response) => response.json());
  assert.deepEqual(productions, []);
  const create = await fetch(baseUrl + '/api/productions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Create a short animation about light.' }) });
  assert.equal(create.status, 503);
  assert.match((await create.json()).error, /GEMINI_API_KEY/);
  const missing = await fetch(baseUrl + '/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(stderr, '');
});
