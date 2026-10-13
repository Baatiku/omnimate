// YouTube and video dubbing pipeline: link/upload -> transcript -> Hausa/Yoruba/Igbo -> timed voice -> mastered video.
//
// Professional Timing & Audio Model:
// 1. Line-exact placement: preserves original start marks and pauses; allows natural overflow.
// 2. Consistent character volume & leveling: PCM RMS normalization + FFmpeg dynaudnorm + loudnorm (-16 LUFS).
// 3. Multi-speaker voice mapping: assigns distinct voices per speaker turn.
// 4. Background music & ambient (M&E) preservation: sidechain ducking keeps ambient score under dialogue.
// 5. Human-in-the-loop review studio: inspect, edit, preview, and regenerate lines before final rendering.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { generateSegmentAudios, generateSingleSegmentAudio, generateJson, analyzeSpeakerVisualDemographics } from './gemini.js';
import { generateSrt, generateVtt } from './audio.js';
import { projectDir, saveJob } from './storage.js';
import { voiceByName } from './presenter.js';

export const DUB_TARGET_LANGS = Object.freeze([
  { code: 'ha', label: 'Hausa (Default)' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'ig', label: 'Igbo' },
  { code: 'sw', label: 'Swahili' },
  { code: 'fr', label: 'French' },
  { code: 'ar', label: 'Arabic' },
  { code: 'es', label: 'Spanish' },
]);

export const LANG_NAMES = Object.freeze({
  ha: 'Hausa',
  yo: 'Yoruba',
  ig: 'Igbo',
  sw: 'Swahili',
  fr: 'French',
  ar: 'Arabic',
  es: 'Spanish',
});

export const SEGMENT_TEMPO_CAP = 1.2;

export const FEMALE_VOICES = Object.freeze([
  'Fola', 'Lumi', 'Sola', 'Nika', 'Kira', 'Cleo', 'Enya', 'Tova', 'Hali',
]);

export const MALE_VOICES = Object.freeze([
  'Bodi', 'Koda', 'Brio', 'Tavi', 'Ludo', 'Mako', 'Jori', 'Rami', 'Enzo',
  'Riko', 'Sami', 'Gero', 'Neno', 'Olin', 'Daro', 'Arlo', 'Finn', 'Jett',
  'Knox', 'Cruz', 'Elio',
]);

export const FEMALE_VOICE_TIERS = Object.freeze({
  Child: ['Lumi', 'Nika', 'Cleo'],
  Teen: ['Lumi', 'Nika', 'Cleo', 'Fola', 'Sola'],
  'Young Adult': ['Fola', 'Sola', 'Hali', 'Nika'],
  Adult: ['Fola', 'Sola', 'Hali', 'Kira', 'Enya', 'Tova'],
  Senior: ['Enya', 'Tova', 'Kira'],
});

export const MALE_VOICE_TIERS = Object.freeze({
  Child: ['Finn', 'Arlo', 'Jett', 'Tavi'],
  Teen: ['Finn', 'Arlo', 'Jett', 'Tavi', 'Bodi', 'Koda'],
  'Young Adult': ['Bodi', 'Koda', 'Brio', 'Ludo', 'Mako', 'Jori', 'Rami', 'Enzo', 'Riko'],
  Adult: ['Bodi', 'Koda', 'Brio', 'Cruz', 'Knox', 'Elio', 'Daro', 'Sami'],
  Senior: ['Daro', 'Sami', 'Gero', 'Neno', 'Olin', 'Knox'],
});

/**
 * Automatically assigns distinct, non-colliding, demographic and gender-balanced voices
 * from the 30 modern Google voices based on facial visual detection and acoustic pitch.
 * Age groups (Child, Teen, Young Adult, Adult, Senior) and gender are matched to dedicated
 * voice tiers so children get youthful voices, adults get natural versatile voices,
 * and seniors get seasoned, resonant voices.
 */
export function autoAssignSpeakerVoices(speakersMeta = {}, speakerIds = [], preferredVoice = 'Fola') {
  const assigned = {};
  const allSpeakers = (speakerIds && speakerIds.length > 0)
    ? speakerIds
    : Object.keys(speakersMeta);
  if (allSpeakers.length === 0) allSpeakers.push('speaker_0');

  const usedVoices = new Set();

  for (const spk of allSpeakers) {
    const meta = speakersMeta[spk] || {};
    const gender = meta.gender || ((meta.pitch_hz || 0) >= 165 ? 'Female' : 'Male');
    const ageGroup = meta.ageGroup || 'Adult';

    let tierCandidates;
    let fallbackCatalog;

    if (gender === 'Female') {
      tierCandidates = FEMALE_VOICE_TIERS[ageGroup] || FEMALE_VOICE_TIERS.Adult;
      fallbackCatalog = FEMALE_VOICES;
    } else {
      tierCandidates = MALE_VOICE_TIERS[ageGroup] || MALE_VOICE_TIERS.Adult;
      fallbackCatalog = MALE_VOICES;
    }

    // Pick an unused voice from the demographic tier first
    let chosen = tierCandidates.find((v) => !usedVoices.has(v));
    // If all in tier are used, try any unused voice from the gender catalog
    if (!chosen) {
      chosen = fallbackCatalog.find((v) => !usedVoices.has(v));
    }
    // If all voices in gender catalog are used (more speakers than voices), cycle
    if (!chosen) {
      chosen = tierCandidates[Object.keys(assigned).length % tierCandidates.length]
        || fallbackCatalog[Object.keys(assigned).length % fallbackCatalog.length];
    }

    usedVoices.add(chosen);
    assigned[spk] = chosen;
  }

  return assigned;
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value || '').trim());
}

export function validateDubCreate(body) {
  const youtubeUrl = String(body.youtubeUrl || '').trim();
  const directUrl = String(body.directUrl || '').trim();
  const localFile = String(body.localFile || '').trim();
  if (!youtubeUrl && !directUrl && !localFile) {
    throw new Error('Paste a YouTube link, direct video link, or upload a video file.');
  }
  if (youtubeUrl && !isHttpUrl(youtubeUrl)) throw new Error('That YouTube link looks invalid.');
  if (directUrl && !isHttpUrl(directUrl)) throw new Error('That file link looks invalid.');
  const targetLang = DUB_TARGET_LANGS.some((lang) => lang.code === body.targetLang)
    ? body.targetLang : 'ha';
  const srcLang = String(body.srcLang || 'en').trim() || 'en';
  const voice = voiceByName(body.voice) ? body.voice : 'Fola';
  const mode = body.mode === 'review' ? 'review' : 'auto';
  const title = String(body.title || youtubeUrl || directUrl || localFile || 'Dubbed Video').slice(0, 120);
  const bgVolume = typeof body.bgVolume === 'number' ? Math.max(0, Math.min(1, body.bgVolume)) : 0.25;
  const ducking = body.ducking !== false;
  const speakerVoices = typeof body.speakerVoices === 'object' && body.speakerVoices !== null
    ? { ...body.speakerVoices } : {};
  return { youtubeUrl, directUrl, localFile, targetLang, srcLang, voice, mode, title, bgVolume, ducking, speakerVoices };
}

export function newDubId() {
  return `dub_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export function makeDubJob({ id, input }) {
  const now = new Date().toISOString();
  return {
    id,
    kind: 'video-dub',
    requestFingerprint: crypto.createHash('sha256')
      .update(JSON.stringify([input.youtubeUrl, input.directUrl, input.localFile, input.targetLang, input.voice, input.mode]))
      .digest('hex').slice(0, 24),
    status: 'queued',
    mode: input.mode || 'auto',
    createdAt: now,
    updatedAt: now,
    options: {
      title: input.title,
      voice: input.voice,
      targetLang: input.targetLang,
      srcLang: input.srcLang,
      bgVolume: input.bgVolume,
      ducking: input.ducking,
      mode: input.mode,
    },
    source: { youtubeUrl: input.youtubeUrl, directUrl: input.directUrl, localFile: input.localFile },
    voice: input.voice,
    speakerVoices: input.speakerVoices || {},
    targetLang: input.targetLang,
    srcLang: input.srcLang,
    bgVolume: input.bgVolume ?? 0.25,
    ducking: input.ducking ?? true,
    remoteJobId: null,
    segments: null,
    segmentsData: null,
    blocks: null,
    translation: null,
    audio: null,
    video: null,
    error: null,
    geminiUsage: { requestsStarted: 0, rateLimitRetries: 0, lastRequestAt: null },
  };
}

// Line-exact placement (the professional dubbing strategy): every spoken
// line keeps its original start mark. Short lines leave the natural pause
// after them untouched. Long lines first spill into the following silence;
// only if they still overflow are they gently sped up (never more than 20
// percent, the industry cap), so words are never cut and drift never builds.
export function placeSegments(lines, videoDurSec) {
  const placements = [];
  let prevEnd = 0;
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    const nextStart = n + 1 < lines.length ? lines[n + 1].start : Number(videoDurSec) || Infinity;
    const at = Math.max(line.start, prevEnd);
    const slot = Math.max(0.2, line.end - at);
    const avail = Math.max(slot, nextStart - at);
    const dur = Math.max(0.2, line.dur);
    const tempo = dur <= avail ? 1 : Math.min(SEGMENT_TEMPO_CAP, dur / avail);
    prevEnd = at + dur / tempo;
    const p = {
      i: line.i,
      file: line.file,
      at_ms: Math.round(at * 1000),
      tempo: +tempo.toFixed(4),
    };
    if (line.speaker) p.speaker = line.speaker;
    placements.push(p);
  }
  return placements;
}

function dubBase() {
  const url = config.modalDubUrl;
  if (!url) throw new Error('Dub worker not configured. Deploy modal/dub.py, then set MODAL_DUB_URL in .env.');
  return url.replace(/\/+$/, '');
}

async function readError(response) {
  try {
    const payload = await response.json();
    return payload?.error || payload?.detail || `Worker said ${response.status}.`;
  } catch {
    return `Worker said ${response.status}.`;
  }
}

export async function dubStart({ youtubeUrl, directUrl, localFilePath, srcLang = 'en' }) {
  const form = new FormData();
  if (youtubeUrl) form.append('youtube_url', youtubeUrl);
  if (directUrl) form.append('direct_url', directUrl);
  if (localFilePath) {
    const buffer = await fs.readFile(localFilePath);
    form.append('video_file', new Blob([buffer], { type: 'video/mp4' }), path.basename(localFilePath));
  }
  form.append('src_lang', srcLang);

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${dubBase()}/start`, { method: 'POST', body: form });
      if (!response.ok) throw new Error(await readError(response));
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function dubAssemble(remoteJobId, plan, wavFiles) {
  const form = new FormData();
  form.append('plan', JSON.stringify(plan));
  for (const [filename, buffer] of wavFiles) {
    form.append('audio', new Blob([buffer], { type: 'audio/wav' }), filename);
  }
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${dubBase()}/assemble/${encodeURIComponent(remoteJobId)}`,
        { method: 'POST', body: form });
      if (!response.ok) throw new Error(await readError(response));
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function totalFromHeaders(response, start) {
  const range = response.headers.get('content-range') || '';
  const match = /\/(\d+)\s*$/.exec(range);
  if (match) return Number(match[1]);
  const length = Number(response.headers.get('content-length') || 0);
  return length > 0 ? start + length : 0;
}

export async function dubDownload(remoteJobId, file, destPath) {
  const url = `${dubBase()}/download/${encodeURIComponent(remoteJobId)}?file=${encodeURIComponent(file)}`;
  let start = 0;
  try { start = (await fs.stat(destPath)).size; } catch {}
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { headers: start > 0 ? { Range: `bytes=${start}-` } : {} });
    } catch {
      await sleep(5000);
      continue;
    }
    if (response.status === 416) return;
    if (response.status === 200 && start > 0) {
      await fs.unlink(destPath).catch(() => {});
      start = 0;
    }
    if (!response.ok && response.status !== 206) throw new Error(await readError(response));
    const total = totalFromHeaders(response, start);
    const stream = createWriteStream(destPath, { flags: start > 0 ? 'a' : 'w' });
    try {
      for await (const chunk of response.body) {
        if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
        start += chunk.length;
      }
      stream.end();
      await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });
    } catch {
      try { stream.destroy(); } catch {}
      await sleep(5000);
      continue;
    }
    if (total > 0 && start < total) {
      await sleep(2000);
      continue;
    }
    return;
  }
  throw new Error('Download kept breaking. Try again on a steadier connection.');
}

export async function dubFetchSpeakerFrame(remoteJobId, speakerId) {
  const safeSpk = String(speakerId).replace(/[^A-Za-z0-9_-]/g, '');
  const url = `${dubBase()}/frame/${encodeURIComponent(remoteJobId)}/${encodeURIComponent(safeSpk)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 404) return null;
      if (!response.ok) {
        await sleep(1500);
        continue;
      }
      const arrayBuf = await response.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch {
      await sleep(1500);
    }
  }
  return null;
}

async function translateChunk(chunk, targetLang, onEvent, speakersMeta = {}) {
  const langName = LANG_NAMES[targetLang] || targetLang || 'Hausa';
  const result = await generateJson({
    prompt: [
      `You are a master voice director and dubbing localization translator into ${langName}.`,
      `Translate each transcript segment into natural spoken ${langName}, while making full sense of the scene context, character persona, age, emotional subtext, and pacing.`,
      '',
      'Voice Acting & Dubbing Directives:',
      '1. Character & Age Awareness: Respect the speaker age, gender, and emotional tone (e.g. youthful, playful expressions for children; respectful, deliberate phrasing for elders; dynamic speech for young adults).',
      '2. Emotional Awareness: Detect the real emotion of the speaker (e.g. enthusiastic, humorous, serious, inquisitive, urgent, warm, sarcastic, somber, excited).',
      '3. Vocal Performance Direction: Provide concise delivery directions for a voice actor (e.g. "excited child voice with quick tempo", "soft, warm and thoughtful", "authoritative and firm", "curious and questioning").',
      '4. Speaking Duration Budget (sec): Each segment specifies its exact time slot in seconds. The translation MUST comfortably fit within this speaking duration. Shorten or rephrase intelligently so the actor never has to rush unnaturally.',
      '5. Plain Spoken Dialogue: Output only what the character speaks; do not include stage notes, speaker tags, or quotes in the text itself.',
      '',
      'Segments to translate (JSON array):',
      JSON.stringify(chunk.map(({ i, speaker, start, end, text }) => {
        const meta = speakersMeta[speaker] || {};
        const charDesc = meta.faceDetected
          ? `${meta.gender || 'Person'}, ${meta.ageGroup || 'Adult'} (~${meta.estimatedAge || 'N/A'}), mood: ${meta.expression || 'neutral'}`
          : `${meta.gender || 'Person'} (~${Math.round(meta.pitch_hz || 140)} Hz)`;
        return {
          i,
          speaker: speaker || 'speaker_0',
          character: charDesc,
          sec: Math.round((end - start) * 10) / 10,
          text,
        };
      })),
      '',
      'Return JSON: {"segments":[{"i":0,"text":"...","emotion":"...","delivery":"...","pacing":"..."}]}',
    ].join('\n'),
    schema: {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              i: { type: 'number' },
              text: { type: 'string', description: 'Translated speakable dialogue' },
              emotion: { type: 'string', description: 'Primary emotion: enthusiastic, serious, warm, urgent, curious, somber, etc.' },
              delivery: { type: 'string', description: 'Vocal acting guidance: pitch, energy, warmth, cadence' },
              pacing: { type: 'string', description: 'fast, normal, or slow' },
            },
            required: ['i', 'text', 'emotion', 'delivery'],
          },
        },
      },
      required: ['segments'],
    },
    label: `Dub emotional translator (${langName})`,
    onEvent,
  });

  return new Map((result.segments || []).map((s) => [
    Number(s.i),
    {
      text: String(s.text || '').trim(),
      emotion: String(s.emotion || 'warm').trim().toLowerCase(),
      delivery: String(s.delivery || 'natural, warm, clear, steady pace').trim(),
      pacing: String(s.pacing || 'normal').trim(),
    },
  ]));
}

async function translateSegments(segments, targetLang, onEvent, speakersMeta = {}) {
  const byIndex = new Map();
  // Chunk in batches of 35 lines to guarantee quality and avoid token exhaustion on long videos
  const chunkSize = 35;
  for (let idx = 0; idx < segments.length; idx += chunkSize) {
    const chunk = segments.slice(idx, idx + chunkSize);
    const chunkMap = await translateChunk(chunk, targetLang, onEvent, speakersMeta);
    for (const [key, val] of chunkMap.entries()) byIndex.set(key, val);
  }

  const translated = segments.map((seg) => {
    const meta = byIndex.get(seg.i) || {};
    return {
      ...seg,
      srcText: seg.text,
      text: meta.text || seg.text,
      emotion: meta.emotion || 'warm',
      delivery: meta.delivery || 'natural, warm, clear, steady pace',
      pacing: meta.pacing || 'normal',
      speaker: seg.speaker || 'speaker_0',
      durationBudget: Math.round((seg.end - seg.start) * 10) / 10,
    };
  });

  if (translated.some((seg) => seg.text.length < 2)) {
    throw new Error('Translation came back incomplete. Try again.');
  }
  return translated;
}

/**
 * Preview / audition a single line with its assigned voice in the Review Studio,
 * respecting emotional inflection and delivery instructions.
 */
export async function previewSegmentAudio({ jobId, segmentIndex, text, voice = 'Fola', delivery = '', emotion = '', targetLang = 'ha' }) {
  const outDir = projectDir(jobId);
  await fs.mkdir(outDir, { recursive: true });
  const filename = `seg_preview_${segmentIndex}.wav`;
  const destPath = path.join(outDir, filename);

  const langName = LANG_NAMES[targetLang] || 'Hausa';
  const effectiveDelivery = delivery || (emotion ? `${emotion} emotion, natural broadcast presenter speaking ${langName}, expressive` : `natural broadcast presenter speaking ${langName}, warm, clear, steady pace`);

  const result = await generateSingleSegmentAudio({
    script: text,
    voice: voiceByName(voice) ? voice : 'Fola',
    delivery: effectiveDelivery,
    outputPath: destPath,
    label: `Audition line ${segmentIndex + 1}`,
  });

  return {
    file: filename,
    url: `/api/dubs/${jobId}/preview/${segmentIndex}.wav?ts=${Date.now()}`,
    durationSec: result.durationSec,
  };
}

/**
 * Phase 1: Ingest, Transcribe, and Translate.
 * Prepares the video and transcript for human review or automated continuation.
 */
export async function prepareDub(job, { onEvent = undefined } = {}) {
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
  const touch = async (status, extra = {}) => {
    Object.assign(job, { status, updatedAt: new Date().toISOString() }, extra);
    await saveJob(job);
  };

  try {
    await touch('downloading');
    job.remote = { status: 'working', detail: 'Ingesting video, extracting background audio, and transcribing speech.' };
    await saveJob(job);

    let localPath;
    if (job.source.localFile) {
      localPath = path.isAbsolute(job.source.localFile)
        ? job.source.localFile
        : path.join(projectDir(job.id), job.source.localFile);
    }

    const started = await dubStart({
      youtubeUrl: job.source.youtubeUrl || undefined,
      directUrl: job.source.directUrl || undefined,
      localFilePath: localPath,
      srcLang: job.srcLang || 'en',
    });

    job.remoteJobId = started.job_id;
    const rawSegments = started.segments;
    job.speakersMeta = started.speakers || {};
    job.videoDurSec = Number(started.video_duration) || 0;
    job.segments = { count: rawSegments.length };

    const detectedSpeakerIds = [...new Set(rawSegments.map((s) => s.speaker || 'speaker_0'))];
    const pDir = projectDir(job.id);
    await fs.mkdir(pDir, { recursive: true });

    // Step 1b: Scan facial scene keyframes across detected speakers
    job.remote = { status: 'scanning_faces', detail: `Scanning scene keyframes for ${detectedSpeakerIds.length} speaker(s) to identify age, gender, and tone.` };
    await saveJob(job);

    for (const spk of detectedSpeakerIds) {
      const meta = job.speakersMeta[spk] || { id: spk };
      try {
        let frameBuf = null;
        if (job.remoteJobId && config.modalDubUrl) {
          frameBuf = await dubFetchSpeakerFrame(job.remoteJobId, spk);
        }
        if (frameBuf && frameBuf.length > 0) {
          const localFramePath = path.join(pDir, `face_${spk}.jpg`);
          await fs.writeFile(localFramePath, frameBuf);

          const demo = await analyzeSpeakerVisualDemographics({
            imageBuffer: frameBuf,
            mimeType: 'image/jpeg',
            speakerLabel: spk,
            acousticGender: meta.gender,
            acousticPitch: meta.pitch_hz,
            label: `Demographic Scanner (${spk})`,
            onEvent: trackEvent,
          });

          if (demo) {
            job.speakersMeta[spk] = {
              ...meta,
              faceDetected: demo.faceDetected ?? true,
              gender: demo.gender && demo.gender !== 'Unknown' ? demo.gender : (meta.gender || 'Female'),
              ageGroup: demo.ageGroup || 'Adult',
              estimatedAge: demo.estimatedAge || '',
              expression: demo.expression || 'neutral',
              vocalActingPrompt: demo.vocalActingPrompt || '',
              recommendedTone: demo.recommendedTone || 'warm',
              faceUrl: `/api/dubs/${job.id}/face/${spk}.jpg`,
            };
          }
        } else {
          job.speakersMeta[spk] = {
            ...meta,
            faceDetected: false,
            ageGroup: 'Adult',
            estimatedAge: 'Off-screen',
            expression: 'neutral',
            vocalActingPrompt: 'Natural broadcast presenter, clear spoken tone',
            recommendedTone: 'warm',
          };
        }
      } catch (err) {
        console.warn(`[Demographics] Visual scan for ${spk} skipped:`, err?.message || err);
        job.speakersMeta[spk] = {
          ...meta,
          faceDetected: false,
          ageGroup: 'Adult',
          vocalActingPrompt: 'Natural broadcast presenter',
          recommendedTone: 'warm',
        };
      }
    }

    // Auto-balance speaker voices matching demographic age tier and gender
    if (!job.speakerVoices || Object.keys(job.speakerVoices).length === 0) {
      job.speakerVoices = autoAssignSpeakerVoices(job.speakersMeta, detectedSpeakerIds, job.voice || 'Fola');
    }

    job.remote = { status: 'transcribed', detail: `${rawSegments.length} spoken segments identified with ${detectedSpeakerIds.length} speaker turn(s).` };
    await saveJob(job);

    await touch('translating');
    const translated = await translateSegments(rawSegments, job.targetLang, trackEvent, job.speakersMeta);
    job.translation = { chars: translated.reduce((n, s) => n + s.text.length, 0) };

    // Format and persist translated script and subtitles
    await fs.writeFile(path.join(pDir, 'script_ha.txt'),
      translated.map((s) => `[${s.start}s - ${s.speaker}] ${s.text}`).join('\n'));
    await fs.writeFile(path.join(pDir, 'subtitles.srt'), generateSrt(translated, 'text'));
    await fs.writeFile(path.join(pDir, 'subtitles.vtt'), generateVtt(translated, 'text'));

    job.segmentsData = translated.map((seg, idx) => {
      const spk = seg.speaker || 'speaker_0';
      const spkMeta = job.speakersMeta?.[spk] || {};
      const actingPrompt = spkMeta.vocalActingPrompt || '';
      const lineDelivery = seg.delivery || 'natural, warm, clear, steady pace';
      const effectiveDelivery = actingPrompt
        ? `${actingPrompt}. Line delivery: ${lineDelivery}. Emotion: ${seg.emotion || 'natural'}`
        : `${lineDelivery}. Emotion: ${seg.emotion || 'natural'}`;

      return {
        i: seg.i ?? idx,
        start: seg.start,
        end: seg.end,
        durationBudget: seg.durationBudget ?? (Math.round((seg.end - seg.start) * 10) / 10),
        srcText: seg.srcText || seg.text,
        text: seg.text,
        emotion: seg.emotion || 'warm',
        delivery: effectiveDelivery,
        pacing: seg.pacing || 'normal',
        speaker: spk,
        gender: seg.gender || spkMeta.gender || 'Female',
        ageGroup: spkMeta.ageGroup || 'Adult',
        estimatedAge: spkMeta.estimatedAge || '',
        faceUrl: spkMeta.faceUrl || '',
        pitchHz: seg.pitch_hz ?? seg.pitchHz ?? spkMeta.pitch_hz,
        voice: (job.speakerVoices && job.speakerVoices[spk]) || job.voice || 'Fola',
      };
    });

    if (job.mode === 'review') {
      await touch('review', { error: null });
      return job;
    }
    return job;
  } catch (error) {
    await touch('failed', { error: error?.message || 'Dub preparation failed.' });
    throw error;
  }
}

/**
 * Phase 2: Voice Generation, Loudness Leveling, and Video Assembly.
 */
export async function renderDub(job, { onEvent = undefined } = {}) {
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
  const touch = async (status, extra = {}) => {
    Object.assign(job, { status, updatedAt: new Date().toISOString() }, extra);
    await saveJob(job);
  };

  try {
    if (!job.segmentsData || !job.segmentsData.length) {
      throw new Error('No transcript segments available to voice.');
    }

    await touch('voicing');
    const pDir = projectDir(job.id);
    await fs.mkdir(pDir, { recursive: true });

    // Group items by assigned voice to maintain consistent voice persona sessions
    const items = job.segmentsData.map((seg, n) => ({
      key: seg.i,
      file: `seg_${String(n).padStart(4, '0')}.wav`,
      script: seg.text,
      voice: (job.speakerVoices && job.speakerVoices[seg.speaker]) || seg.voice || job.voice || 'Fola',
      delivery: seg.delivery || (seg.emotion ? `${seg.emotion} emotion, expressive, natural pace` : 'natural, warm, clear, steady pace'),
      speaker: seg.speaker,
    }));

    job.audio = { linesDone: 0, linesTotal: items.length };
    await saveJob(job);

    const durByIndex = new Map();

    // Check if any line was already auditioned/previewed
    const needed = [];
    for (const item of items) {
      const previewFile = path.join(pDir, `seg_preview_${item.key}.wav`);
      const targetFile = path.join(pDir, item.file);
      try {
        await fs.copyFile(previewFile, targetFile);
        const stat = await fs.stat(targetFile);
        durByIndex.set(item.key, stat.size / (24000 * 2));
      } catch {
        needed.push(item);
      }
    }

    // Synthesize unvoiced items in voice-grouped batches
    if (needed.length > 0) {
      // Group by voice so that each speaker's voice session remains consistent
      const byVoice = new Map();
      for (const item of needed) {
        if (!byVoice.has(item.voice)) byVoice.set(item.voice, []);
        byVoice.get(item.voice).push(item);
      }

      for (const [voiceName, voiceItems] of byVoice.entries()) {
        const voiced = await generateSegmentAudios({
          items: voiceItems,
          voice: voiceName,
          delivery: `natural broadcast presenter speaking ${LANG_NAMES[job.targetLang] || 'Hausa'}, warm, clear, steady pace, consistent projection`,
          outputDir: pDir,
          label: `Dub voice (${voiceName})`,
          onEvent: trackEvent,
        });
        for (const v of voiced) durByIndex.set(v.key, v.durationSec);
      }
    }

    const lines = job.segmentsData.map((seg, n) => ({
      i: seg.i,
      start: seg.start,
      end: seg.end,
      file: items[n].file,
      speaker: seg.speaker,
      dur: durByIndex.get(seg.i) ?? Math.max(0.5, seg.end - seg.start),
    }));

    const placements = placeSegments(lines, job.videoDurSec || 0);
    const wavFiles = [];
    for (const line of lines) {
      wavFiles.push([line.file, await fs.readFile(path.join(pDir, line.file))]);
    }

    job.audio = { linesTotal: lines.length };
    await saveJob(job);

    await touch('assembling');
    job.remote = {
      status: 'assembling',
      detail: 'Leveling character speech (-16 LUFS), sidechain ducking background M&E, and assembling video.',
    };
    await saveJob(job);

    const plan = {
      placements,
      bg_volume: typeof job.bgVolume === 'number' ? job.bgVolume : 0.25,
      ducking: job.ducking !== false,
      target_lufs: -16.0,
    };

    await dubAssemble(job.remoteJobId, plan, wavFiles);

    await touch('fetching');
    job.remote = { status: 'fetching', detail: 'Fetching your finalized broadcast-grade video.' };
    await saveJob(job);

    const videoPath = path.join(pDir, 'dubbed.mp4');
    const voicePath = path.join(pDir, 'voiceover.wav');
    await dubDownload(job.remoteJobId, 'dubbed.mp4', videoPath);
    await dubDownload(job.remoteJobId, 'voiceover.wav', voicePath);

    const [videoStat, voiceStat] = await Promise.all([fs.stat(videoPath), fs.stat(voicePath)]);
    if (videoStat.size < 50_000) throw new Error('The video arrived damaged. Try rendering again.');

    job.video = { url: `/api/dubs/${job.id}/video.mp4?ts=${Date.now()}`, bytes: videoStat.size };
    job.audio = { ...(job.audio || {}), url: `/api/dubs/${job.id}/audio.wav?ts=${Date.now()}`, bytes: voiceStat.size };
    await touch('done', { error: null });
    return job;
  } catch (error) {
    await touch('failed', { error: error?.message || 'Dub rendering failed.' });
    throw error;
  }
}

/**
 * End-to-end dub pipeline: automatically executes preparation and rendering,
 * or pauses at the review stage if job.mode === 'review'.
 */
export async function runDubPipeline(job, opts = {}) {
  if (job.status === 'review') {
    return renderDub(job, opts);
  }
  await prepareDub(job, opts);
  if (job.mode === 'review') {
    return job;
  }
  return renderDub(job, opts);
}
