// Realistic presenter pipeline: script -> Gemini voice -> Modal lip-sync video.
//
// One presenter job owns a photo (photo.jpg), narration (audio.wav), and the
// final result (presenter.mp4). Steps run in order so a retry never repeats
// completed work: voice first, then video.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { generateNarrationAudio, generateJson } from './gemini.js';
import { modalConfigured, generateVideoOnModal } from './modal-client.js';
import { projectDir, saveJob } from './storage.js';

import {
  PRESENTER_VOICES,
  voiceByName,
  FEMALE_VOICES,
  MALE_VOICES,
  FEMALE_VOICE_TIERS,
  MALE_VOICE_TIERS,
} from './voices.js';

export {
  PRESENTER_VOICES,
  voiceByName,
  FEMALE_VOICES,
  MALE_VOICES,
  FEMALE_VOICE_TIERS,
  MALE_VOICE_TIERS,
};

function parsePhotoDataUrl(dataUrl) {
  // Browsers send the photo as "data:image/jpeg;base64,...". Accept jpeg/png
  // only, and cap at 10 MB to protect the server.
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error('Upload a JPG or PNG presenter photo.');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length < 10_000) throw new Error('That photo looks too small. Use a clear front-facing portrait.');
  if (buffer.length > 10_000_000) throw new Error('That photo is larger than 10 MB. Use a smaller image.');
  const extension = match[1] === 'image/png' ? 'png' : 'jpg';
  return { buffer, extension };
}

export function validatePresenterCreate(body) {
  const script = String(body.script || '').trim();
  if (script.length < 10) throw new Error('Write at least a sentence for the presenter to say.');
  if (script.length > config.maxScriptChars) throw new Error(`Keep the script under ${config.maxScriptChars} characters.`);
  const voice = voiceByName(body.voice) ? body.voice : 'Aoede';
  const quality = body.quality === 'fast' ? 'fast' : 'high';
  const title = String(body.title || script.slice(0, 60) || 'Untitled presenter').slice(0, 120);
  const { buffer: photoBuffer, extension } = parsePhotoDataUrl(body.photoDataUrl);
  return { script, voice, quality, title, photoBuffer, photoExtension: extension };
}

export function newPresenterId() {
  return `pres_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export function presenterFingerprint({ script, voice, quality, photoBuffer }) {
  // Same script + voice + photo + quality reuses the running job instead of
  // burning Modal credits twice on a double-click.
  const photoHash = crypto.createHash('sha256').update(photoBuffer).digest('hex').slice(0, 24);
  return crypto.createHash('sha256').update(JSON.stringify({ script, voice, quality, photoHash })).digest('hex').slice(0, 24);
}

export function makePresenterJob({ id, fingerprint, input }) {
  const now = new Date().toISOString();
  return {
    id,
    kind: 'realistic-presenter',
    requestFingerprint: fingerprint,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    options: { title: input.title, voice: input.voice, quality: input.quality, scriptChars: input.script.length },
    script: input.script,
    voice: input.voice,
    quality: input.quality,
    audio: null,
    video: null,
    error: null,
    geminiUsage: { requestsStarted: 0, rateLimitRetries: 0, lastRequestAt: null },
  };
}

async function writePresenterPhoto(jobId, buffer, extension) {
  const dir = projectDir(jobId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `photo.${extension}`), buffer);
}

async function readPresenterPhoto(jobId) {
  const dir = projectDir(jobId);
  for (const name of ['photo.jpg', 'photo.png']) {
    try {
      return await fs.readFile(path.join(dir, name));
    } catch {}
  }
  return null;
}

async function readJobAudio(jobId) {
  try {
    return await fs.readFile(path.join(projectDir(jobId), 'audio.wav'));
  } catch {
    return null;
  }
}

// Runs voice then video. Each stage saves to disk before the next starts, so
// a failed video render keeps the voice and can be retried without paying
// Gemini (voice) twice.
export async function runPresenterPipeline(job, { onEvent = undefined } = {}) {
  const trackEvent = async (event) => {
    if (event?.type === 'start') {
      job.geminiUsage.requestsStarted += 1;
      job.geminiUsage.lastRequestAt = new Date().toISOString();
    } else if (event?.type === 'retry') {
      job.geminiUsage.rateLimitRetries += 1;
    }
    if (event?.type === 'start' || event?.type === 'retry') await saveJob(job);
    await onEvent?.(event);
  };

  try {
    job.status = 'voicing';
    job.updatedAt = new Date().toISOString();
    await saveJob(job);

    const audioPath = path.join(projectDir(job.id), 'audio.wav');
    const audio = await generateNarrationAudio({
      label: 'Presenter Gemini voice',
      onEvent: trackEvent,
      script: job.script,
      voice: job.voice,
      delivery: 'natural broadcast presenter, warm, clear, steady pace',
      outputPath: audioPath,
    });
    job.audio = { ...audio, url: `/api/presenters/${job.id}/audio.wav?ts=${Date.now()}`, voice: job.voice };
    job.updatedAt = new Date().toISOString();
    await saveJob(job);

    job.status = 'rendering-video';
    job.updatedAt = new Date().toISOString();
    await saveJob(job);

    const [photoBuffer, audioBuffer] = await Promise.all([readPresenterPhoto(job.id), readJobAudio(job.id)]);
    if (!photoBuffer) throw new Error('Presenter photo is missing. Re-upload the photo and try again.');
    if (!audioBuffer) throw new Error('Narration audio is missing. Generate the voice first.');

    const videoBuffer = await generateVideoOnModal({ imageBuffer: photoBuffer, audioBuffer, quality: job.quality });
    await fs.writeFile(path.join(projectDir(job.id), 'presenter.mp4'), videoBuffer);
    job.video = {
      url: `/api/presenters/${job.id}/video.mp4?ts=${Date.now()}`,
      bytes: videoBuffer.length,
      quality: job.quality,
      modal: modalConfigured(),
    };
    job.status = 'done';
    job.error = null;
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    return job;
  } catch (error) {
    job.status = 'failed';
    job.error = error?.message || 'Presenter generation failed.';
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    throw error;
  }
}

export function validateScriptPrompt(body) {
  const prompt = String(body.prompt || '').trim();
  if (prompt.length < 8) throw new Error('Describe what the presenter should talk about.');
  const durationSec = [30, 60, 90].includes(Number(body.durationSec)) ? Number(body.durationSec) : 60;
  return { prompt: prompt.slice(0, 2000), durationSec };
}

// Turns a short topic prompt into a full speakable script using the existing
// Gemini text pool (same quota governor as everything else).
export async function generatePresenterScript({ prompt, durationSec }) {
  const targetWords = Math.round((140 * durationSec) / 60);
  const result = await generateJson({
    prompt: [
      'You are a radio scriptwriter for a lively human presenter.',
      'Topic from the user:',
      prompt,
      `Write a spoken script of about ${targetWords} words (about ${durationSec} seconds on air).`,
      'Rules: plain speakable sentences only. No stage directions, no sound-effect notes, no markup. Open with a hook, close with a smile.',
      'Return JSON with "script" (the full speakable text) and "title" (a short episode title).',
    ].join('\n'),
    schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Speakable presenter script, plain text only.' },
        title: { type: 'string', description: 'Short episode title.' },
      },
      required: ['script'],
    },
    label: 'Presenter scriptwriter',
  });
  const script = String(result.script || '').trim();
  if (script.length < 20) throw new Error('The writer returned an empty script. Try a clearer topic.');
  return { script: script.slice(0, config.maxScriptChars), title: String(result.title || '').slice(0, 120) };
}

export { writePresenterPhoto };
