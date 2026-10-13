import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, Modality } from '@google/genai';
import { config } from './config.js';
import { pcm16ToWav, pcmDurationSeconds, normalizePcm16 } from './audio.js';
import { geminiGovernor, isTransientError, modelPoolSnapshot, scheduleOnModel } from './rate-limit.js';

let client;
function getClient() {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is missing. Copy .env.example to .env and add your key.');
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

// Round-robin rotation: consecutive steps land on different model names,
// each of which owns a separate RPM/TPM/RPD budget on Google's side.
const rotationCursors = new Map();

function orderedPool(pool, count) {
  const unique = [...new Set(pool.filter(Boolean))];
  if (!unique.length) return [config.textModel];
  const key = unique.join('|');
  const start = rotationCursors.get(key) || 0;
  rotationCursors.set(key, start + 1);
  const candidates = [];
  for (let i = 0; i < Math.min(count, unique.length); i += 1) {
    candidates.push(unique[(start + i) % unique.length]);
  }
  return candidates;
}

// Models sometimes wrap JSON in code fences or prepend a sentence even when a
// JSON response format is requested. Salvage the payload before giving up.
export function extractJsonPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) throw Object.assign(new Error('Gemini returned an empty response.'), { code: 'BAD_JSON' });
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const attempts = [];
  if (fence) attempts.push(fence[1].trim());
  const firstBrace = text.search(/[{[]/);
  if (firstBrace >= 0) {
    const opener = text[firstBrace];
    const closer = opener === '[' ? ']' : '}';
    const lastCloser = text.lastIndexOf(closer);
    if (lastCloser > firstBrace) attempts.push(text.slice(firstBrace, lastCloser + 1).trim());
  }
  attempts.push(text);
  let lastError = null;
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  const preview = text.slice(0, 200).replace(/\s+/g, ' ');
  throw Object.assign(
    new Error(`Gemini answered with words instead of data (starts with: "${preview}").`),
    { code: 'BAD_JSON', cause: lastError, rawPreview: preview }
  );
}

async function stashBadOutput({ label, model, raw }) {
  try {
    const dir = path.join(config.dataDir, '_bad-outputs');
    await fs.mkdir(dir, { recursive: true });
    const safeLabel = String(label || 'step').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
    const safeModel = String(model || 'model').replace(/[^a-z0-9-_.]+/gi, '_').slice(0, 60);
    const file = path.join(dir, `${Date.now()}_${safeLabel}_${safeModel}.txt`);
    await fs.writeFile(file, String(raw || '').slice(0, 20000));
    return file;
  } catch {
    return null;
  }
}
// A search-grounding step sent to a model without free grounding fails with a
// tool-support error, not a 429. That is also worth failing over to the next
// candidate instead of killing the production.
function isToolSupportError(error, tools) {
  if (!tools) return false;
  const message = String(error?.message || '');
  if (/grounding|google_search|search grounding/i.test(message)) return true;
  return /not supported|not available|unsupported/i.test(message);
}

export async function generateJson({
  prompt,
  schema,
  tools = undefined,
  model = undefined,
  models = undefined,
  label = 'Structured Gemini pass',
  onEvent = undefined
}) {
  const pool = [...new Set(config.textModels.filter(Boolean))];
  let candidates;
  if (models && models.length) {
    // Rotate the requested pool too, so back-to-back productions start on
    // different budgets instead of always hammering the first name.
    candidates = orderedPool(models, models.length);
  } else {
    // First candidate is next in rotation; the rest follow in pool order so a
    // tired model hands off to a fresh budget instead of failing the film.
    const [first] = orderedPool(pool, 1);
    candidates = [first, ...pool.filter((name) => name !== first)];
    if (model && !candidates.includes(model)) candidates.unshift(model);
    else if (model) candidates = [model, ...candidates.filter((name) => name !== model)];
  }
  if (!candidates.length) candidates = [config.textModel];
  let lastError;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const result = await scheduleOnModel({
        model: candidate,
        label,
        onEvent,
        task: async () => {
          const ai = getClient();
          const interaction = await ai.interactions.create({
            model: candidate,
            input: `${prompt}\n\nReturn ONLY the JSON value, with no surrounding prose or code fences.`,
            ...(tools ? { tools } : {}),
            response_format: {
              type: 'text',
              mime_type: 'application/json',
              schema
            }
          });
          if (!interaction.output_text) throw new Error('Gemini returned no structured output.');
          try {
            return extractJsonPayload(interaction.output_text);
          } catch (error) {
            const file = await stashBadOutput({ label, model: candidate, raw: interaction.output_text });
            error.detail = file ? `Full reply saved to ${file}.` : error.detail;
            error.model = candidate;
            throw error;
          }
        }
      });
      return result;
    } catch (error) {
      lastError = error;
      const canFailOver = index < candidates.length - 1
        && (isTransientError(error) || isToolSupportError(error, tools) || error?.code === 'BAD_JSON');
      if (!canFailOver) throw error;
      await onEvent?.({ type: 'fallback', label, model: candidate, nextModel: candidates[index + 1], error });
    }
  }
  throw lastError;
}

export async function generateMultimodalJson({
  prompt,
  imageBuffer,
  mimeType = 'image/jpeg',
  schema,
  model = undefined,
  models = undefined,
  label = 'Multimodal Gemini pass',
  onEvent = undefined,
}) {
  const pool = [...new Set(config.textModels.filter(Boolean))];
  const [first] = orderedPool(pool, 1);
  const candidates = [first, ...pool.filter((name) => name !== first)];
  if (model && !candidates.includes(model)) candidates.unshift(model);

  let lastError;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const result = await scheduleOnModel({
        model: candidate,
        label,
        onEvent,
        task: async () => {
          const ai = getClient();
          const contents = [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType || 'image/jpeg',
                    data: Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : String(imageBuffer),
                  },
                },
                {
                  text: `${prompt}\n\nReturn ONLY the JSON value, with no surrounding prose or code fences.`,
                },
              ],
            },
          ];

          const response = await ai.models.generateContent({
            model: candidate,
            contents,
            config: {
              responseMimeType: 'application/json',
              responseSchema: schema,
            },
          });

          const rawText = response.text || '';
          if (!rawText) throw new Error('Gemini returned no structured output.');
          return extractJsonPayload(rawText);
        },
      });
      return result;
    } catch (error) {
      lastError = error;
      const canFailOver = index < candidates.length - 1
        && (isTransientError(error) || error?.code === 'BAD_JSON');
      if (!canFailOver) throw error;
      await onEvent?.({ type: 'fallback', label, model: candidate, nextModel: candidates[index + 1], error });
    }
  }
  throw lastError;
}

/**
 * Visual demographic & biometric scanning of a speaking face in a video frame.
 * Detects gender, age bracket (Child/Teen/Adult/Senior), estimated age, facial expression,
 * and formulates vocal acting directives for Gemini Live TTS.
 */
export async function analyzeSpeakerVisualDemographics({
  imageBuffer,
  mimeType = 'image/jpeg',
  speakerLabel = 'Speaker',
  acousticGender = null,
  acousticPitch = null,
  label = 'Visual Demographics Analysis',
  onEvent = undefined,
}) {
  const prompt = [
    'You are an expert casting director and demographic biometric analyst for a broadcast dubbing studio.',
    `Analyze the primary speaking face or prominent person visible in this video scene frame for "${speakerLabel}".`,
    acousticGender ? `(Acoustic vocal pitch detected: ${acousticGender}, ~${Math.round(acousticPitch || 140)} Hz).` : '',
    '',
    'Instructions:',
    '1. Determine whether a clear human face or person is present in the frame.',
    '2. Identify their perceived gender presentation: "Female", "Male", or "Unknown".',
    '3. Identify their age group category: "Child" (approx 3-12 yrs), "Teen" (13-19 yrs), "Young Adult" (20-35 yrs), "Adult" (36-55 yrs), or "Senior" (56+ yrs).',
    '4. Provide an estimated numerical age or age range string (e.g. "6-8", "25-30", "65+").',
    '5. Identify their facial expression / emotional mood (e.g. "smiling and playful", "serious and focused", "laughing", "sad").',
    '6. Formulate a precise "vocalActingPrompt" in English for an AI voice actor dubbing into Hausa. This instruction MUST command the tone, vocal energy, pitch inflection, and age personality (e.g., for a child: "Young child voice (approx 7-8 years old), bright energetic tone, playful inflection, natural lively cadence"; for an elder: "Elderly person voice (approx 65 years old), calm, warm, deliberate tempo, seasoned vocal resonance").',
    '7. Specify a "recommendedTone": "playful", "warm", "energetic", "authoritative", "gentle", "serious", or "casual".',
    '',
    'If no human face or person is clearly visible (e.g. landscape, title screen, background object):',
    'Return faceDetected: false, gender: "Unknown", ageGroup: "Adult", estimatedAge: "Unknown", expression: "neutral", vocalActingPrompt: "Natural broadcast presenter", recommendedTone: "warm".',
  ].join('\n');

  const schema = {
    type: 'object',
    properties: {
      faceDetected: { type: 'boolean', description: 'Whether a visible person or face is in the frame' },
      gender: { type: 'string', enum: ['Female', 'Male', 'Unknown'] },
      ageGroup: { type: 'string', enum: ['Child', 'Teen', 'Young Adult', 'Adult', 'Senior'] },
      estimatedAge: { type: 'string', description: 'Estimated age or age range e.g. 7-9, 28, 65' },
      expression: { type: 'string', description: 'Facial expression or mood' },
      vocalActingPrompt: { type: 'string', description: 'Performance and voice-age direction for Gemini TTS' },
      recommendedTone: { type: 'string', description: 'Tone adjective e.g. playful, warm, energetic' },
    },
    required: ['faceDetected', 'gender', 'ageGroup', 'estimatedAge', 'vocalActingPrompt', 'recommendedTone'],
  };

  return generateMultimodalJson({
    prompt,
    imageBuffer,
    mimeType,
    schema,
    label: `${label} (${speakerLabel})`,
    onEvent,
  });
}

async function performNarrationAudio({ script, voice, delivery, outputPath }) {
  const ai = getClient();
  const chunks = [];
  const transcript = [];
  let session;
  let settled = false;
  let resolveTurn;
  let rejectTurn;
  const turnDone = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectTurn(new Error('Gemini Live narration timed out.'));
      try { session?.close(); } catch {}
    }
  }, 150_000);

  session = await ai.live.connect({
    model: config.liveModel,
    callbacks: {
      onopen() {},
      onmessage(message) {
        const content = message?.serverContent;
        for (const part of content?.modelTurn?.parts || []) {
          if (part.inlineData?.data) chunks.push(Buffer.from(part.inlineData.data, 'base64'));
        }
        if (content?.outputTranscription?.text) transcript.push(content.outputTranscription.text);
        if (content?.turnComplete && !settled) {
          settled = true;
          resolveTurn();
        }
      },
      onerror(error) {
        if (!settled) {
          settled = true;
          rejectTurn(new Error(error?.message || 'Gemini Live connection failed.'));
        }
      },
      onclose(event) {
        if (!settled && !chunks.length) {
          settled = true;
          rejectTurn(new Error(event?.reason || 'Gemini Live closed before returning audio.'));
        }
      }
    },
    config: {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  });

  const exactPrompt = [
    'You are the lead voice actor in a premium animated documentary studio.',
    `Performance direction: ${delivery || 'natural, cinematic, warm, intelligent, never announcer-like'}.`,
    'Speak ONLY the narration between <SCRIPT> tags. Do not add an introduction, commentary, stage directions, or a sign-off.',
    'Preserve the meaning and wording exactly; only natural pronunciation and prosody may vary.',
    '<SCRIPT>', script, '</SCRIPT>'
  ].join('\n');

  session.sendClientContent({
    turns: [{ role: 'user', parts: [{ text: exactPrompt }] }],
    turnComplete: true
  });

  try {
    await turnDone;
  } finally {
    clearTimeout(timeout);
    try { session.close(); } catch {}
  }

  if (!chunks.length) throw new Error('Gemini Live completed without audio data.');
  const rawPcm = Buffer.concat(chunks);
  const pcm = normalizePcm16(rawPcm, -18);
  const wav = pcm16ToWav(pcm, 24000, 1);
  await fs.writeFile(outputPath, wav);
  return {
    durationSec: pcmDurationSeconds(pcm.length, 24000, 1),
    transcript: transcript.join(' ').replace(/\s+/g, ' ').trim(),
    bytes: wav.length
  };
}

export async function generateNarrationAudio({
  script,
  voice = 'Fola',
  delivery = '',
  outputPath,
  label = 'Gemini Live narration',
  onEvent = undefined
}) {
  return scheduleOnModel({
    model: config.liveModel,
    label,
    onEvent,
    task: () => performNarrationAudio({ script, voice, delivery, outputPath })
  });
}

// Single line preview: voices one line for quick auditioning or regeneration in the studio.
async function performSingleSegmentAudio({ script, voice, delivery, outputPath }) {
  const ai = getClient();
  const chunks = [];
  let session;
  let settled = false;
  let resolveTurn;
  let rejectTurn;
  const turnDone = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectTurn(new Error('Voice preview timed out.'));
      try { session?.close(); } catch {}
    }
  }, 90_000);

  session = await ai.live.connect({
    model: config.liveModel,
    callbacks: {
      onopen() {},
      onmessage(message) {
        const content = message?.serverContent;
        for (const part of content?.modelTurn?.parts || []) {
          if (part.inlineData?.data) chunks.push(Buffer.from(part.inlineData.data, 'base64'));
        }
        if (content?.turnComplete && !settled) {
          settled = true;
          resolveTurn();
        }
      },
      onerror(error) {
        if (!settled) {
          settled = true;
          rejectTurn(new Error(error?.message || 'Gemini Live connection failed.'));
        }
      },
      onclose(event) {
        if (!settled && !chunks.length) {
          settled = true;
          rejectTurn(new Error(event?.reason || 'Gemini Live closed before returning audio.'));
        }
      }
    },
    config: {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  });

  const exactPrompt = [
    'You are the lead voice actor in a premium dubbing studio.',
    `Performance direction: ${delivery || 'natural, warm, clear, steady pace'}.`,
    'Keep vocal projection, volume, microphone distance, and energy strictly even and consistent. Avoid sudden shouting or whispering.',
    'Speak ONLY the line between <SCRIPT> tags. Do not add an introduction, commentary, or a sign-off.',
    '<SCRIPT>', script, '</SCRIPT>'
  ].join('\n');

  session.sendClientContent({
    turns: [{ role: 'user', parts: [{ text: exactPrompt }] }],
    turnComplete: true
  });

  try {
    await turnDone;
  } finally {
    clearTimeout(timeout);
    try { session.close(); } catch {}
  }

  if (!chunks.length) throw new Error('Gemini Live completed without audio.');
  const rawPcm = Buffer.concat(chunks);
  const pcm = normalizePcm16(rawPcm, -18);
  const wav = pcm16ToWav(pcm, 24000, 1);
  await fs.writeFile(outputPath, wav);
  return {
    durationSec: pcmDurationSeconds(pcm.length, 24000, 1),
    bytes: wav.length
  };
}

export async function generateSingleSegmentAudio({
  script,
  voice = 'Fola',
  delivery = '',
  outputPath,
  label = 'Line audition voice',
  onEvent = undefined
}) {
  return scheduleOnModel({
    model: config.liveModel,
    label,
    onEvent,
    task: () => performSingleSegmentAudio({ script, voice, delivery, outputPath })
  });
}

// Batch voice: speaks many short lines inside ONE Live session, in order.
// Dubbing needs one voice call per spoken line; opening a session per line
// would be far too slow, while one session costs a single paced request.
async function performSegmentAudios({ items, voice, delivery, outputDir }) {
  const ai = getClient();
  const results = [];
  let collector = null;
  let session;
  try {
    session = await ai.live.connect({
      model: config.liveModel,
      callbacks: {
        onopen() {},
        onmessage(message) {
          const content = message?.serverContent;
          if (!collector) return;
          for (const part of content?.modelTurn?.parts || []) {
            if (part.inlineData?.data) collector.chunks.push(Buffer.from(part.inlineData.data, 'base64'));
          }
          if (content?.turnComplete && !collector.settled) {
            collector.settled = true;
            collector.resolve();
          }
        },
        onerror(error) {
          if (collector && !collector.settled) {
            collector.settled = true;
            collector.reject(new Error(error?.message || 'Gemini Live connection failed.'));
          }
        },
        onclose(event) {
          if (collector && !collector.settled && !collector.chunks.length) {
            collector.settled = true;
            collector.reject(new Error(event?.reason || 'Gemini Live closed before returning audio.'));
          }
        }
      },
      config: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    });

    for (const [n, item] of items.entries()) {
      collector = { chunks: [], settled: false, resolve: null, reject: null };
      const done = new Promise((resolve, reject) => {
        collector.resolve = resolve;
        collector.reject = reject;
      });
      const timer = setTimeout(() => {
        if (!collector.settled) {
          collector.settled = true;
          collector.reject(new Error(`Voice timed out on line ${n + 1}.`));
        }
      }, 150_000);
      const lineDelivery = item.delivery || delivery || 'natural, warm, clear, steady pace';
      const exactPrompt = [
        'You are the lead voice actor in a premium dubbing studio.',
        `Performance direction: ${lineDelivery}.`,
        'Keep vocal projection, volume, microphone distance, and energy strictly even and consistent across every sentence, but act with authentic emotion, inflection, and pacing matching the performance direction.',
        'Speak ONLY the line between <SCRIPT> tags. Do not add an introduction, commentary, or a sign-off.',
        'Preserve the meaning and wording exactly; only natural pronunciation and prosody may vary.',
        '<SCRIPT>', item.script, '</SCRIPT>'
      ].join('\n');
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: exactPrompt }] }],
        turnComplete: true
      });
      try {
        await done;
      } finally {
        clearTimeout(timer);
      }
      if (!collector.chunks.length) throw new Error(`Gemini Live completed without audio on line ${n + 1}.`);
      const rawPcm = Buffer.concat(collector.chunks);
      const pcm = normalizePcm16(rawPcm, -18);
      const wav = pcm16ToWav(pcm, 24000, 1);
      await fs.writeFile(path.join(outputDir, item.file), wav);
      results.push({ key: item.key, file: item.file, durationSec: pcmDurationSeconds(pcm.length, 24000, 1) });
      collector = null;
    }
  } finally {
    try { session?.close(); } catch {}
  }
  return results;
}

export async function generateSegmentAudios({
  items,
  voice = 'Fola',
  delivery = '',
  outputDir,
  label = 'Gemini Live batch voice',
  onEvent = undefined
}) {
  // Long sessions can get tired; split into chunks of 40 lines max so one
  // request still covers a whole video but no session runs forever.
  const all = [];
  for (let at = 0; at < items.length; at += 40) {
    const chunk = items.slice(at, at + 40);
    const part = await scheduleOnModel({
      model: config.liveModel,
      label: `${label} (lines ${at + 1}-${at + chunk.length})`,
      onEvent,
      task: () => performSegmentAudios({ items: chunk, voice, delivery, outputDir })
    });
    all.push(...part);
  }
  return all;
}

export function geminiQuotaStatus() {
  const base = geminiGovernor.snapshot();
  const models = modelPoolSnapshot();
  const pending = models.reduce((sum, entry) => sum + (entry.pending || 0), base.pending || 0);
  return { ...base, pending, models };
}
