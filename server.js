import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { ensureStorage, listJobs, loadJob, projectDir, saveJob } from './lib/storage.js';
import { geminiQuotaStatus } from './lib/gemini.js';
import { modalConfigured } from './lib/modal-client.js';
import {
  validateDubCreate,
  newDubId,
  makeDubJob,
  runDubPipeline,
  renderDub,
  previewSegmentAudio,
  DUB_TARGET_LANGS,
} from './lib/dub.js';
import { voiceByName } from './lib/voices.js';
import { generateSrt, generateVtt } from './lib/audio.js';
import { getCookiesStatus, autoDetectCookies, saveCookies, clearCookies, extractBrowserCookies } from './lib/cookies.js';
import {
  validatePresenterCreate,
  validateScriptPrompt,
  generatePresenterScript,
  PRESENTER_VOICES,
  newPresenterId,
  presenterFingerprint,
  makePresenterJob,
  runPresenterPipeline,
  writePresenterPhoto,
} from './lib/presenter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
// Jobs with a render currently in flight. Prevents double Modal charges from
// double-clicks or a create/retry race on the same presenter.
const activeRuns = new Set();

function launchPresenter(job) {
  activeRuns.add(job.id);
  setImmediate(() => {
    runPresenterPipeline(job).catch((error) => {
      console.error('Presenter run failed:', error?.message || error);
    }).finally(() => {
      activeRuns.delete(job.id);
    });
  });
}

// A single failed file save must never kill the whole studio server.
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection (server still running):', error);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception (server still running):', error);
});
await ensureStorage();

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.wav', 'audio/wav'],
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
    if (size > config.maxBodyBytes) throw new Error('Upload is too large. Use a photo under 10 MB.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
        modalConfigured: modalConfigured(),
        liveModel: config.liveModel,
        geminiQuota: geminiQuotaStatus(),
        version: '0.5.0',
      });
    }

    if (req.method === 'GET' && pathname === '/api/voices') {
      return json(res, 200, PRESENTER_VOICES);
    }

    if (req.method === 'GET' && pathname === '/api/presenters') {
      // Old cartoon jobs (if any remain on disk) are hidden: this studio only
      // makes realistic presenters now.
      const jobs = (await listJobs()).filter((job) => job.kind === 'realistic-presenter');
      return json(res, 200, jobs.map((job) => ({
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        options: job.options,
        audio: job.audio ? { url: job.audio.url, durationSec: job.audio.durationSec } : null,
        video: job.video ? { url: job.video.url, bytes: job.video.bytes } : null,
        error: job.error,
      })));
    }

    if (req.method === 'POST' && pathname === '/api/presenters') {
      if (!config.geminiApiKey) return json(res, 503, { error: 'Gemini is not configured. Add GEMINI_API_KEY to .env and restart.' });
      const input = validatePresenterCreate(await readJson(req));
      const fingerprint = presenterFingerprint({ script: input.script, voice: input.voice, quality: input.quality, photoBuffer: input.photoBuffer });
      const existing = (await listJobs()).find((job) =>
        job.requestFingerprint === fingerprint && ['queued', 'voicing', 'rendering-video', 'running'].includes(job.status)
      );
      if (existing) return json(res, 202, { id: existing.id, status: existing.status, deduplicated: true });

      const id = newPresenterId();
      const now = new Date().toISOString();
      const job = { ...makePresenterJob({ id, fingerprint, input }), createdAt: now, updatedAt: now };
      await saveJob(job);
      await writePresenterPhoto(id, input.photoBuffer, input.photoExtension);
      launchPresenter(job);
      return json(res, 202, { id, status: job.status });
    }

    if (req.method === 'POST' && pathname === '/api/presenters/write-script') {
      if (!config.geminiApiKey) return json(res, 503, { error: 'Gemini is not configured. Add GEMINI_API_KEY to .env and restart.' });
      const input = validateScriptPrompt(await readJson(req));
      const result = await generatePresenterScript(input);
      return json(res, 200, result);
    }

    const jobMatch = pathname.match(/^\/api\/presenters\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = await loadJob(jobMatch[1]);
      return job ? json(res, 200, job) : json(res, 404, { error: 'Presenter not found.' });
    }

    const audioMatch = pathname.match(/^\/api\/presenters\/([a-zA-Z0-9_-]+)\/audio\.wav$/);
    if (req.method === 'GET' && audioMatch) {
      const file = path.join(projectDir(audioMatch[1]), 'audio.wav');
      try {
        const stat = await fsp.stat(file);
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': stat.size,
          'cache-control': 'no-store',
          'accept-ranges': 'bytes',
        });
        return fs.createReadStream(file).pipe(res);
      } catch {
        return json(res, 404, { error: 'Narration audio is not ready.' });
      }
    }

    const videoMatch = pathname.match(/^\/api\/presenters\/([a-zA-Z0-9_-]+)\/video\.mp4$/);
    if (req.method === 'GET' && videoMatch) {
      const file = path.join(projectDir(videoMatch[1]), 'presenter.mp4');
      try {
        const stat = await fsp.stat(file);
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': stat.size,
          'cache-control': 'no-store',
          'accept-ranges': 'bytes',
        });
        return fs.createReadStream(file).pipe(res);
      } catch {
        return json(res, 404, { error: 'Presenter video is not ready.' });
      }
    }

    if (req.method === 'GET' && pathname === '/api/dub-langs') {
      return json(res, 200, DUB_TARGET_LANGS);
    }

    if (req.method === 'GET' && pathname === '/api/cookies') {
      return json(res, 200, await getCookiesStatus());
    }

    if (req.method === 'POST' && pathname === '/api/cookies/extract') {
      const body = await readJson(req).catch(() => ({}));
      const result = await extractBrowserCookies(body.browser || 'firefox');
      return json(res, result.success ? 200 : 400, result);
    }

    if (req.method === 'POST' && pathname === '/api/cookies/auto-detect') {
      const result = await autoDetectCookies();
      return json(res, result.success ? 200 : 400, result);
    }

    if (req.method === 'POST' && pathname === '/api/cookies/upload') {
      const body = await readJson(req).catch(() => ({}));
      const text = String(body.cookiesText || body.text || '').trim();
      if (!text) return json(res, 400, { error: 'No cookies text provided.' });
      const result = await saveCookies(text);
      return json(res, 200, result);
    }

    if (req.method === 'DELETE' && pathname === '/api/cookies') {
      await clearCookies();
      return json(res, 200, { success: true });
    }

    if (req.method === 'GET' && pathname === '/api/dubs') {
      const jobs = (await listJobs()).filter((job) => job.kind === 'video-dub');
      return json(res, 200, jobs.map((job) => ({
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        options: job.options,
        audio: job.audio?.url ? { url: job.audio.url } : null,
        video: job.video ? { url: job.video.url, bytes: job.video.bytes } : null,
        error: job.error,
      })));
    }

    if (req.method === 'POST' && pathname === '/api/dubs/upload') {
      const uploadDir = path.join(config.dataDir, 'uploads');
      await fsp.mkdir(uploadDir, { recursive: true });
      const filename = `video_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`;
      const targetPath = path.join(uploadDir, filename);

      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        const body = await readJson(req);
        const dataUrl = body.dataUrl || '';
        const match = /^data:(?:video\/\w+);base64,(.+)$/.exec(dataUrl);
        if (match) {
          await fsp.writeFile(targetPath, Buffer.from(match[1], 'base64'));
        } else {
          return json(res, 400, { error: 'Invalid video data URL.' });
        }
      } else {
        const writeStream = fs.createWriteStream(targetPath);
        await new Promise((resolve, reject) => {
          req.pipe(writeStream);
          req.on('error', reject);
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
        });
      }
      return json(res, 200, { localFile: targetPath, filename });
    }

    if (req.method === 'POST' && pathname === '/api/dubs') {
      if (!config.geminiApiKey) return json(res, 503, { error: 'Gemini is not configured. Add GEMINI_API_KEY to .env and restart.' });
      const input = validateDubCreate(await readJson(req));
      const probe = makeDubJob({ id: 'probe', input });
      const existing = (await listJobs()).find((job) =>
        job.requestFingerprint === probe.requestFingerprint && !['done', 'failed', 'review'].includes(job.status)
      );
      if (existing) return json(res, 202, { id: existing.id, status: existing.status, deduplicated: true });

      const id = newDubId();
      const job = makeDubJob({ id, input });
      await saveJob(job);
      activeRuns.add(id);
      setImmediate(() => {
        runDubPipeline(job).catch((error) => {
          console.error('Dub run failed:', error?.message || error);
        }).finally(() => {
          activeRuns.delete(id);
        });
      });
      return json(res, 202, { id, status: job.status });
    }

    const dubMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'GET' && dubMatch) {
      const job = await loadJob(dubMatch[1]);
      return job ? json(res, 200, job) : json(res, 404, { error: 'Dub not found.' });
    }

    const dubSegmentsMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)\/segments$/);
    if (req.method === 'PATCH' && dubSegmentsMatch) {
      const id = dubSegmentsMatch[1];
      const job = await loadJob(id);
      if (!job) return json(res, 404, { error: 'Dub not found.' });
      const body = await readJson(req);
      if (Array.isArray(body.segments)) {
        job.segmentsData = body.segments;
        const pDir = projectDir(id);
        await fsp.writeFile(path.join(pDir, 'subtitles.srt'), generateSrt(job.segmentsData, 'text'));
        await fsp.writeFile(path.join(pDir, 'subtitles.vtt'), generateVtt(job.segmentsData, 'text'));
      }
      if (body.speakerVoices) {
        job.speakerVoices = { ...(job.speakerVoices || {}), ...body.speakerVoices };
        if (Array.isArray(job.segmentsData)) {
          for (const seg of job.segmentsData) {
            const spk = seg.speaker || 'speaker_0';
            if (job.speakerVoices[spk]) seg.voice = job.speakerVoices[spk];
          }
        }
        if (!job.speakersMeta) job.speakersMeta = {};
        for (const [spk, voiceName] of Object.entries(job.speakerVoices)) {
          const vMeta = voiceByName(voiceName);
          if (vMeta) {
            if (!job.speakersMeta[spk]) job.speakersMeta[spk] = { id: spk };
            job.speakersMeta[spk].voice = vMeta.name;
            job.speakersMeta[spk].gender = vMeta.gender;
          }
        }
      }
      if (body.speakersMeta) job.speakersMeta = { ...(job.speakersMeta || {}), ...body.speakersMeta };
      if (typeof body.bgVolume === 'number') job.bgVolume = body.bgVolume;
      if (typeof body.ducking === 'boolean') job.ducking = body.ducking;
      await saveJob(job);
      return json(res, 200, { ok: true, job });
    }

    const dubPreviewLineMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)\/preview-line$/);
    if (req.method === 'POST' && dubPreviewLineMatch) {
      if (!config.geminiApiKey) return json(res, 503, { error: 'Gemini is not configured.' });
      const id = dubPreviewLineMatch[1];
      const job = await loadJob(id);
      if (!job) return json(res, 404, { error: 'Dub not found.' });
      const body = await readJson(req);
      const segmentIndex = Number(body.segmentIndex || 0);
      const text = String(body.text || '').trim();
      const voice = String(body.voice || job.voice || 'Fola');
      const delivery = typeof body.delivery === 'string' ? body.delivery.trim() : '';
      const emotion = typeof body.emotion === 'string' ? body.emotion.trim() : '';
      if (!text) return json(res, 400, { error: 'Provide text to preview.' });
      const result = await previewSegmentAudio({
        jobId: job.id,
        segmentIndex,
        text,
        voice,
        targetLang: job.targetLang,
        delivery,
        emotion,
      });
      return json(res, 200, result);
    }

    const dubPreviewWavMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)\/preview\/(\d+)\.wav$/);
    if (req.method === 'GET' && dubPreviewWavMatch) {
      const file = path.join(projectDir(dubPreviewWavMatch[1]), `seg_preview_${dubPreviewWavMatch[2]}.wav`);
      try {
        const stat = await fsp.stat(file);
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': stat.size,
          'cache-control': 'no-store',
          'accept-ranges': 'bytes',
        });
        return fs.createReadStream(file).pipe(res);
      } catch {
        return json(res, 404, { error: 'Preview audio not ready.' });
      }
    }

    const dubSampleWavMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)\/sample\/(\d+)\.wav$/);
    if (req.method === 'GET' && dubSampleWavMatch) {
      const id = dubSampleWavMatch[1];
      const segmentIndex = dubSampleWavMatch[2];
      const job = await loadJob(id);
      if (!job) return json(res, 404, { error: 'Dub not found.' });

      // Check if already cached locally
      const pDir = projectDir(id);
      const cachedFile = path.join(pDir, `seg_sample_${segmentIndex}.wav`);
      try {
        const stat = await fsp.stat(cachedFile);
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': stat.size,
          'cache-control': 'public, max-age=3600',
        });
        return fs.createReadStream(cachedFile).pipe(res);
      } catch {}

      // Proxy from Modal worker if remoteJobId exists
      if (job.remoteJobId && config.modalDubUrl) {
        const modalUrl = `${config.modalDubUrl.replace(/\/+$/, '')}/sample/${encodeURIComponent(job.remoteJobId)}/${segmentIndex}`;
        try {
          const proxyRes = await fetch(modalUrl);
          if (!proxyRes.ok) {
            return json(res, proxyRes.status, { error: 'Sample audio not found on worker.' });
          }
          const buf = Buffer.from(await proxyRes.arrayBuffer());
          await fsp.mkdir(pDir, { recursive: true });
          await fsp.writeFile(cachedFile, buf).catch(() => {});
          res.writeHead(200, {
            'content-type': 'audio/wav',
            'content-length': buf.length,
            'cache-control': 'public, max-age=3600',
          });
          return res.end(buf);
        } catch (err) {
          return json(res, 502, { error: `Worker error: ${err.message}` });
        }
      }

      return json(res, 404, { error: 'Sample audio unavailable.' });
    }

    const dubFaceImageMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)\/face\/([a-zA-Z0-9_-]+)(?:\.jpg)?$/);
    if (req.method === 'GET' && dubFaceImageMatch) {
      const id = dubFaceImageMatch[1];
      const speakerId = dubFaceImageMatch[2];
      const job = await loadJob(id);
      if (!job) return json(res, 404, { error: 'Dub not found.' });

      const safeSpk = speakerId.replace(/[^A-Za-z0-9_-]/g, '');
      const pDir = projectDir(id);
      const cachedFile = path.join(pDir, `face_${safeSpk}.jpg`);
      try {
        const stat = await fsp.stat(cachedFile);
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': stat.size,
          'cache-control': 'public, max-age=3600',
        });
        return fs.createReadStream(cachedFile).pipe(res);
      } catch {}

      // Proxy from Modal worker if remoteJobId exists
      if (job.remoteJobId && config.modalDubUrl) {
        const modalUrl = `${config.modalDubUrl.replace(/\/+$/, '')}/frame/${encodeURIComponent(job.remoteJobId)}/${encodeURIComponent(safeSpk)}`;
        try {
          const proxyRes = await fetch(modalUrl);
          if (!proxyRes.ok) {
            return json(res, proxyRes.status, { error: 'Speaker face frame not found on worker.' });
          }
          const buf = Buffer.from(await proxyRes.arrayBuffer());
          await fsp.mkdir(pDir, { recursive: true });
          await fsp.writeFile(cachedFile, buf).catch(() => {});
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'content-length': buf.length,
            'cache-control': 'public, max-age=3600',
          });
          return res.end(buf);
        } catch (err) {
          return json(res, 502, { error: `Worker error: ${err.message}` });
        }
      }

      return json(res, 404, { error: 'Speaker face image unavailable.' });
    }

    const dubRenderMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)\/render$/);
    if (req.method === 'POST' && dubRenderMatch) {
      const id = dubRenderMatch[1];
      const job = await loadJob(id);
      if (!job) return json(res, 404, { error: 'Dub not found.' });
      const body = await readJson(req);
      if (body.speakerVoices) {
        job.speakerVoices = { ...(job.speakerVoices || {}), ...body.speakerVoices };
        if (Array.isArray(job.segmentsData)) {
          for (const seg of job.segmentsData) {
            const spk = seg.speaker || 'speaker_0';
            if (job.speakerVoices[spk]) seg.voice = job.speakerVoices[spk];
          }
        }
        if (!job.speakersMeta) job.speakersMeta = {};
        for (const [spk, voiceName] of Object.entries(job.speakerVoices)) {
          const vMeta = voiceByName(voiceName);
          if (vMeta) {
            if (!job.speakersMeta[spk]) job.speakersMeta[spk] = { id: spk };
            job.speakersMeta[spk].voice = vMeta.name;
            job.speakersMeta[spk].gender = vMeta.gender;
          }
        }
      }
      if (typeof body.bgVolume === 'number') job.bgVolume = body.bgVolume;
      if (typeof body.ducking === 'boolean') job.ducking = body.ducking;
      await saveJob(job);
      activeRuns.add(id);
      setImmediate(() => {
        renderDub(job).catch((error) => {
          console.error('Dub render failed:', error?.message || error);
        }).finally(() => {
          activeRuns.delete(id);
        });
      });
      return json(res, 202, { id, status: 'voicing' });
    }

    const srtMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)\/subtitles\.srt$/);
    if (req.method === 'GET' && srtMatch) {
      const file = path.join(projectDir(srtMatch[1]), 'subtitles.srt');
      try {
        const content = await fsp.readFile(file, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="${srtMatch[1]}.srt"`,
        });
        return res.end(content);
      } catch {
        return json(res, 404, { error: 'Subtitles not found.' });
      }
    }

    const vttMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)\/subtitles\.vtt$/);
    if (req.method === 'GET' && vttMatch) {
      const file = path.join(projectDir(vttMatch[1]), 'subtitles.vtt');
      try {
        const content = await fsp.readFile(file, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/vtt; charset=utf-8',
          'content-disposition': `attachment; filename="${vttMatch[1]}.vtt"`,
        });
        return res.end(content);
      } catch {
        return json(res, 404, { error: 'Subtitles not found.' });
      }
    }

    const dubAudioMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)\/audio\.wav$/);
    if (req.method === 'GET' && dubAudioMatch) {
      const file = path.join(projectDir(dubAudioMatch[1]), 'voiceover.wav');
      try {
        const stat = await fsp.stat(file);
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': stat.size,
          'cache-control': 'no-store',
          'accept-ranges': 'bytes',
        });
        return fs.createReadStream(file).pipe(res);
      } catch {
        return json(res, 404, { error: 'Hausa voice is not ready.' });
      }
    }

    const dubVideoMatch = pathname.match(/^\/api\/dubs\/([a-zA-Z0-9_-]+)\/video\.mp4$/);
    if (req.method === 'GET' && dubVideoMatch) {
      const file = path.join(projectDir(dubVideoMatch[1]), 'dubbed.mp4');
      try {
        const stat = await fsp.stat(file);
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': stat.size,
          'cache-control': 'no-store',
          'accept-ranges': 'bytes',
        });
        return fs.createReadStream(file).pipe(res);
      } catch {
        return json(res, 404, { error: 'Dubbed video is not ready.' });
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
  console.log(`Omnimate Presenter running at http://${displayHost}:${config.port}`);
  console.log(`Voice: ${config.liveModel} | Modal video: ${modalConfigured() ? 'configured' : 'set MODAL_PRESENTER_URL after modal deploy'}`);
  if (!config.geminiApiKey) console.log('Gemini is not configured yet. Copy .env.example to .env and add GEMINI_API_KEY.');
});
