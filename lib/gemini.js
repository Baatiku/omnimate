import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, Modality } from '@google/genai';
import { config } from './config.js';
import { pcm16ToWav, pcmDurationSeconds, normalizePcm16 } from './audio.js';
import { geminiGovernor, isTransientError, modelPoolSnapshot, scheduleOnModel } from './rate-limit.js';
import { voiceByName } from './voices.js';

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
    `Analyze the scene keyframe for speaker "${speakerLabel}".`,
    acousticGender ? `(Acoustic vocal pitch detected: ${acousticGender}, ~${Math.round(acousticPitch || 140)} Hz).` : '',
    '',
    'CRITICAL HUMAN VERIFICATION REQUIREMENT:',
    '1. You are scanning ONLY for living biological human beings who can be voice-dubbed.',
    '2. If this image frame shows an animal (e.g. snake, dog, cat, reptile, wildlife, predator, bird, livestock), cartoon character, mascot, statue, landscape, graphic, or inanimate object:',
    '   You MUST set:',
    '   - isHuman: false',
    '   - subjectCategory: "animal" (or "scenery" / "object")',
    '   - faceDetected: false',
    '   - gender: "Unknown"',
    '   - ageGroup: "Adult"',
    '   - estimatedAge: "Off-screen"',
    '   - expression: "neutral"',
    '   - vocalActingPrompt: "Natural off-screen narrative voiceover"',
    '   - recommendedTone: "warm"',
    '   NEVER identify animals as speakers, and NEVER assign human demographics (gender, ageGroup) to animals!',
    '',
    '3. ONLY IF A CLEAR LIVING HUMAN PERSON IS VISIBLE:',
    '   - Set isHuman: true, subjectCategory: "human", faceDetected: true.',
    '   - Identify their perceived gender presentation: "Female", "Male", or "Unknown".',
    '   - Identify their age group category: "Child" (3-12 yrs), "Teen" (13-19 yrs), "Young Adult" (20-35 yrs), "Adult" (36-55 yrs), or "Senior" (56+ yrs).',
    '   - Provide an estimated numerical age or age range string (e.g. "6-8", "25-30", "65+").',
    '   - Identify their facial expression / emotional mood (e.g. "smiling and playful", "serious and focused", "laughing", "sad").',
    '   - Formulate a precise "vocalActingPrompt" in English for an AI voice actor dubbing into Hausa. This instruction MUST command the tone, vocal energy, pitch inflection, and age personality (e.g., for a child: "Young child voice (approx 7-8 years old), bright energetic tone, playful inflection, natural lively cadence"; for an elder: "Elderly person voice (approx 65 years old), calm, warm, deliberate tempo, seasoned vocal resonance").',
    '   - Specify a "recommendedTone": "playful", "warm", "energetic", "authoritative", "gentle", "serious", or "casual".',
  ].filter(Boolean).join('\n');

  const schema = {
    type: 'object',
    properties: {
      isHuman: { type: 'boolean', description: 'Whether the subject is a living biological human being' },
      subjectCategory: { type: 'string', enum: ['human', 'animal', 'scenery', 'object', 'none'] },
      faceDetected: { type: 'boolean', description: 'Whether a visible human face is in the frame' },
      gender: { type: 'string', enum: ['Female', 'Male', 'Unknown'] },
      ageGroup: { type: 'string', enum: ['Child', 'Teen', 'Young Adult', 'Adult', 'Senior'] },
      estimatedAge: { type: 'string', description: 'Estimated age or age range e.g. 7-9, 28, 65, Off-screen' },
      expression: { type: 'string', description: 'Facial expression or mood' },
      vocalActingPrompt: { type: 'string', description: 'Performance and voice-age direction for Gemini TTS' },
      recommendedTone: { type: 'string', description: 'Tone adjective e.g. playful, warm, energetic' },
    },
    required: ['isHuman', 'subjectCategory', 'faceDetected', 'gender', 'ageGroup', 'estimatedAge', 'vocalActingPrompt', 'recommendedTone'],
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

/**
 * Context & Focus Analyzer for Video Dubbing:
 * Inspects video title, cast profiles, and transcript preview to identify:
 * 1. Focus Genre: Documentary, Movie/Drama, Podcast/Interview, News, Comedy, Explainer, Vlog, Sports.
 * 2. 2-sentence Narrative Synopsis: what the video is about and what is taking place.
 * 3. Overall Vocal Tone Guidance: delivery pacing, vocal projection, and gravitas for Gemini Live TTS.
 * 4. Hausa Translation Style Directives: genre-specific register, cultural phrasing, and calque prevention.
 */
export async function analyzeVideoContext({
  title = '',
  transcriptPreview = '',
  speakersMeta = {},
  label = 'Video context & genre analysis',
  onEvent = undefined,
}) {
  const speakerSummary = Object.entries(speakersMeta).map(([id, meta]) => {
    return `- ${id}: ${meta.gender || 'Person'} (${meta.ageGroup || 'Adult'}, ~${meta.estimatedAge || 'N/A'}), tone: ${meta.recommendedTone || 'natural'}`;
  }).join('\n');

  const prompt = [
    'You are a senior executive dubbing director and localization specialist.',
    'Analyze this video production to determine its overarching focus, genre, narrative context, and optimal vocal delivery style before dialogue translation begins.',
    '',
    title ? `Video Title / Source: "${title}"` : '',
    speakerSummary ? `Character Cast:\n${speakerSummary}` : '',
    '',
    'Transcript Excerpt / Timeline Sample:',
    transcriptPreview.slice(0, 3000),
    '',
    'Instructions:',
    '1. Identify the primary "genre": "Documentary", "Movie / Drama", "Podcast / Interview", "News Broadcast", "Educational / Explainer", "Comedy / Entertainment", "Vlog / Lifestyle", or "Sports / Commentary".',
    '2. Provide a 2-sentence "summary" explaining what the video is about and what is taking place.',
    '3. Formulate an "overallTone" (e.g. for a documentary: "Measured, inquisitive, authoritative broadcast gravitas with deliberate pauses"; for a podcast: "Casual, conversational, spontaneous banter, warm and responsive laughs"; for news: "Crisp, objective, urgent, articulate pacing"; for movies: "Expressive dramatic emotion, dynamic interpersonal pacing").',
    '4. Formulate "translationDirectives" for idiomatic Hausa localization:',
    '   - For Documentary: "Adopt rich, descriptive Hausa storytelling (Fim mai ilmantarwa). Use dignified, contemplative narrative phrasing like BBC Hausa / National Geographic. Zero English calques. Measured narrative gravitas."',
    '   - For News Broadcast: "Adopt formal standard journalistic Hausa (Hausar Labarai da Rahotanni). Dignified, professional vocabulary. Clear, articulate delivery without casual slang."',
    '   - For Movie / Drama: "Adopt living spoken conversational Hausa (Hausar yau da kullum kamar ta Kannywood). Real emotional exclamations (Kai!, Haba dai!, Ashe!, To fa!), natural banter, and authentic colloquial rhythm."',
    '   - For Podcast / Interview: "Adopt warm, spontaneous conversational Hausa (Tattaunawa). Natural conversational bridges and relatable colloquial expressions."',
    '   - For Educational / Explainer: "Adopt clear, lucid Hausa explanations. Demystify complex concepts with intuitive everyday analogies."',
    '',
    'Return JSON with keys: genre, summary, overallTone, translationDirectives',
  ].filter(Boolean).join('\n');

  const schema = {
    type: 'object',
    properties: {
      genre: {
        type: 'string',
        enum: [
          'Documentary',
          'Movie / Drama',
          'Podcast / Interview',
          'News Broadcast',
          'Educational / Explainer',
          'Comedy / Entertainment',
          'Vlog / Lifestyle',
          'Sports / Commentary',
          'General',
        ],
      },
      summary: { type: 'string', description: '2-sentence narrative synopsis of the video content' },
      overallTone: { type: 'string', description: 'Overarching vocal performance direction' },
      translationDirectives: { type: 'string', description: 'Stylistic localization guidance for Hausa translation' },
    },
    required: ['genre', 'summary', 'overallTone', 'translationDirectives'],
  };

  return generateJson({
    prompt,
    schema,
    label,
    onEvent,
  });
}

/**
 * System instruction for Gemini Multimodal Live native-audio voice actors.
 * Directs native Northern Nigerian Kano/Kaduna Hausa accent, authentic tonal prosody,
 * emotional delivery, and strict isolation of spoken lines without conversational chit-chat.
 */
export function buildLiveSystemInstruction({ targetLang = 'ha', persona = '', delivery = '' } = {}) {
  const isHausa = !targetLang || targetLang === 'ha';
  const langName = isHausa ? 'Hausa (Harshen Hausa)' : targetLang;

  const lines = [
    `You are an elite, professional broadcast voice actor and dubbing artist performing in ${langName}.`,
    persona ? `Character persona: ${persona}.` : '',
    delivery ? `Performance style: ${delivery}.` : '',
    '',
    isHausa
      ? 'CRITICAL HAUSA ACTING & DICTION RULES:\n' +
        '1. Speak authentic, fluent Northern Nigerian (Kano/Kaduna standard) Hausa with natural tonal inflections, proper vowel length (wasula), and lively cadence.\n' +
        '2. Pronounce glottalized and implosive consonants (ƙ, ɗ, ɓ, \'y) naturally as a native speaker.\n' +
        '3. Never sound like a robotic text-to-speech engine. Breathe life, emotion, rhythm, and conviction into every line.'
      : `1. Speak authentic, fluent native ${langName} with natural intonation, correct stress, and broadcast clarity.\n` +
        '2. Never sound like a robotic text-to-speech engine. Breathe life, emotion, and rhythm into every line.',
    '',
    'STRICT SCRIPT ISOLATION & VOCAL DISCIPLINE:',
    '1. When the user sends a message containing text between <SCRIPT> and </SCRIPT> tags, you must speak ONLY the words inside those tags.',
    '2. DO NOT utter any pleasantries, introductions (e.g. "Sure!", "Here is the audio", "Okay"), translations into English, stage notes, or sign-offs.',
    '3. Keep vocal projection, volume, microphone distance, and energy strictly even and consistent across every sentence.',
  ];

  return lines.filter(Boolean).join('\n');
}

async function performNarrationAudio({ script, voice = 'Charon', delivery = '', outputPath, targetLang = 'ha' }) {
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
      rejectTurn(new Error('Voice generation timed out.'));
      try { session?.close(); } catch {}
    }
  }, 120_000);

  const voiceMeta = voiceByName(voice);
  const personaLine = voiceMeta ? `Vocal persona: ${voiceMeta.gender} voice (${voiceMeta.style}).` : '';

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
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      systemInstruction: {
        parts: [{ text: buildLiveSystemInstruction({ targetLang, persona: personaLine, delivery }) }]
      }
    }
  });

  const exactPrompt = [
    'You are the lead voice actor in a premium animated documentary studio.',
    personaLine,
    `Performance direction: ${delivery || 'natural, cinematic, warm, intelligent, never announcer-like'}.`,
    'Speak ONLY the narration between <SCRIPT> tags. Do not add an introduction, commentary, stage directions, or a sign-off.',
    'Preserve the meaning and wording exactly; only natural pronunciation and prosody may vary.',
    '<SCRIPT>', script, '</SCRIPT>'
  ].filter(Boolean).join('\n');

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
  voice = 'Charon',
  delivery = '',
  outputPath,
  targetLang = 'ha',
  label = 'Gemini Live narration',
  onEvent = undefined
}) {
  return scheduleOnModel({
    model: config.liveModel,
    label,
    onEvent,
    task: () => performNarrationAudio({ script, voice, delivery, outputPath, targetLang })
  });
}

async function performSingleSegmentAudio({ script, voice = 'Charon', delivery = '', outputPath, targetLang = 'ha' }) {
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

  const voiceMeta = voiceByName(voice);
  const personaLine = voiceMeta ? `Vocal persona: ${voiceMeta.gender} voice (${voiceMeta.style}).` : '';

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
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      systemInstruction: {
        parts: [{ text: buildLiveSystemInstruction({ targetLang, persona: personaLine, delivery }) }]
      }
    }
  });

  const exactPrompt = [
    'You are the lead voice actor in a premium dubbing studio.',
    personaLine,
    `Performance direction: ${delivery || 'natural, warm, clear, steady pace'}.`,
    'Keep vocal projection, volume, microphone distance, and energy strictly even and consistent. Avoid sudden shouting or whispering.',
    'Speak ONLY the line between <SCRIPT> tags. Do not add an introduction, commentary, or a sign-off.',
    '<SCRIPT>', script, '</SCRIPT>'
  ].filter(Boolean).join('\n');

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
  voice = 'Charon',
  delivery = '',
  outputPath,
  targetLang = 'ha',
  label = 'Line audition voice',
  onEvent = undefined
}) {
  return scheduleOnModel({
    model: config.liveModel,
    label,
    onEvent,
    task: () => performSingleSegmentAudio({ script, voice, delivery, outputPath, targetLang })
  });
}

// Batch voice: speaks many short lines inside ONE Live session, in order.
// Dubbing needs one voice call per spoken line; opening a session per line
// would be far too slow, while one session costs a single paced request.
async function performSegmentAudios({ items, voice = 'Charon', delivery = '', outputDir, targetLang = 'ha' }) {
  const ai = getClient();
  const results = [];
  let collector = null;
  let session;
  const voiceMeta = voiceByName(voice);
  const personaLine = voiceMeta ? `Vocal persona: ${voiceMeta.gender} voice (${voiceMeta.style}).` : '';

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
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        systemInstruction: {
          parts: [{ text: buildLiveSystemInstruction({ targetLang, persona: personaLine, delivery }) }]
        }
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
        personaLine,
        `Performance direction: ${lineDelivery}.`,
        'Keep vocal projection, volume, microphone distance, and energy strictly even and consistent across every sentence, but act with authentic emotion, inflection, and pacing matching the performance direction.',
        'Speak ONLY the line between <SCRIPT> tags. Do not add an introduction, commentary, or a sign-off.',
        'Preserve the meaning and wording exactly; only natural pronunciation and prosody may vary.',
        '<SCRIPT>', item.script, '</SCRIPT>'
      ].filter(Boolean).join('\n');
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
  voice = 'Charon',
  delivery = '',
  outputDir,
  targetLang = 'ha',
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
      task: () => performSegmentAudios({ items: chunk, voice, delivery, outputDir, targetLang })
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
