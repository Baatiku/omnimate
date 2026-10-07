import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { ensureStorage, listJobs, loadJob, projectDir, saveJob } from './lib/storage.js';
import { makeInitialStages, runProduction } from './lib/orchestrator.js';
import { generateNarrationAudio, geminiQuotaStatus } from './lib/gemini.js';
import { fitPlanToAudio } from './lib/compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const voiceRegenerations = new Set();
await ensureStorage();

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav']
]);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateCreate(body) {
  const prompt = String(body.prompt || '').trim();
  if (prompt.length < 8) throw new Error('Describe the film you want Omnimate to create.');
  return {
    prompt: prompt.slice(0, 6000),
    durationSec: Math.max(15, Math.min(180, Number(body.durationSec || 60))),
    aspectRatio: ['16:9','9:16','1:1'].includes(body.aspectRatio) ? body.aspectRatio : '16:9',
    style: String(body.style || 'cinematic editorial cartoon').slice(0, 200),
    language: String(body.language || '').slice(0, 80),
    audience: String(body.audience || '').slice(0, 160),
    voice: ['Kore','Puck','Charon','Fenrir','Aoede'].includes(body.voice) ? body.voice : 'Kore',
    quality: body.quality === 'draft' ? 'draft' : 'studio'
  };
}

function fingerprint(options) {
  return crypto.createHash('sha256').update(JSON.stringify(options)).digest('hex').slice(0, 24);
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(publicDir, normalized);
  if (!file.startsWith(publicDir)) return false;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return false;
    res.writeHead(200, { 'content-type': mime.get(path.extname(file)) || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        geminiConfigured: Boolean(config.geminiApiKey),
        textModel: config.textModel,
        liveModel: config.liveModel,
        geminiQuota: geminiQuotaStatus(),
        version: '0.2.0'
      });
    }

    if (req.method === 'GET' && pathname === '/api/productions') {
      const jobs = await listJobs();
      return json(res, 200, jobs.map(({ departments, plan, ...job }) => ({
        ...job,
        title: plan?.title || job.options?.prompt?.slice(0, 72) || 'Untitled'
      })));
    }

    if (req.method === 'POST' && pathname === '/api/productions') {
      if (!config.geminiApiKey) return json(res, 503, { error: 'Gemini is not configured. Add GEMINI_API_KEY to .env and restart Omnimate.' });
      const options = validateCreate(await readJson(req));
      const requestFingerprint = fingerprint(options);
      const existing = (await listJobs()).find((job) =>
        job.requestFingerprint === requestFingerprint && (job.status === 'queued' || job.status === 'running')
      );
      if (existing) return json(res, 202, { id: existing.id, status: existing.status, deduplicated: true });

      const id = `omni_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
      const now = new Date().toISOString();
      const job = {
        id,
        requestFingerprint,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        options,
        stages: makeInitialStages(),
        departments: {},
        geminiUsage: { requestsStarted: 0, rateLimitRetries: 0, lastRequestAt: null },
        plan: null,
        audio: null,
        error: null
      };
      await saveJob(job);
      setImmediate(() => runProduction(job, options));
      return json(res, 202, { id, status: job.status });
    }

    const jobMatch = pathname.match(/^\/api\/productions\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = await loadJob(jobMatch[1]);
      return job ? json(res, 200, job) : json(res, 404, { error: 'Production not found.' });
    }

    const audioMatch = pathname.match(/^\/api\/productions\/([a-zA-Z0-9_-]+)\/audio\.wav$/);
    if (req.method === 'GET' && audioMatch) {
      const file = path.join(projectDir(audioMatch[1]), 'audio.wav');
      try {
        const stat = await fsp.stat(file);
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': stat.size,
          'cache-control': 'no-store',
          'accept-ranges': 'bytes'
        });
        return fs.createReadStream(file).pipe(res);
      } catch {
        return json(res, 404, { error: 'Narration audio is not ready.' });
      }
    }

    const regenMatch = pathname.match(/^\/api\/productions\/([a-zA-Z0-9_-]+)\/regenerate-audio$/);
    if (req.method === 'POST' && regenMatch) {
      if (voiceRegenerations.has(regenMatch[1])) return json(res, 409, { error: 'Voice regeneration is already queued or running for this production.' });
      const job = await loadJob(regenMatch[1]);
      if (!job?.plan?.narration?.script) return json(res, 404, { error: 'A completed script is required first.' });
      const body = await readJson(req);
      const voice = ['Kore','Puck','Charon','Fenrir','Aoede'].includes(body.voice) ? body.voice : job.options.voice;
      voiceRegenerations.add(job.id);
      try {
        job.geminiUsage ||= { requestsStarted: 0, rateLimitRetries: 0, lastRequestAt: null };
        const onEvent = async (event) => {
          if (event.type === 'start') {
            job.geminiUsage.requestsStarted += 1;
            job.geminiUsage.lastRequestAt = new Date().toISOString();
          } else if (event.type === 'retry') {
            job.geminiUsage.rateLimitRetries += 1;
          }
          if (['start','retry'].includes(event.type)) await saveJob(job);
        };
        const audio = await generateNarrationAudio({
          label: 'Regenerate Gemini Live voice',
          onEvent,
          script: job.plan.narration.script,
          voice,
          delivery: job.plan.narration.delivery,
          outputPath: path.join(projectDir(job.id), 'audio.wav')
        });
        job.audio = { ...audio, url: `/api/productions/${job.id}/audio.wav?ts=${Date.now()}`, voice };
        job.plan = fitPlanToAudio(job.plan, audio.durationSec);
        job.updatedAt = new Date().toISOString();
        await saveJob(job);
        return json(res, 200, job);
      } finally {
        voiceRegenerations.delete(job.id);
      }
    }

    if (req.method === 'GET' && await serveStatic(req, res, pathname)) return;
    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error?.message || 'Unexpected server error.' });
  }
});

server.listen(config.port, config.host, () => {
  const displayHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  console.log(`Omnimate Studio running at http://${displayHost}:${config.port}`);
  console.log(`Gemini governor: ${config.geminiRpm} RPM, ${geminiQuotaStatus().minIntervalMs}ms minimum spacing.`);
  if (!config.geminiApiKey) console.log('Gemini is not configured yet. Copy .env.example to .env and add GEMINI_API_KEY.');
});
