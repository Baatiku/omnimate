import fs from 'node:fs/promises';
import { GoogleGenAI, Modality } from '@google/genai';
import { config } from './config.js';
import { pcm16ToWav, pcmDurationSeconds } from './audio.js';
import { geminiGovernor } from './rate-limit.js';

let client;
function getClient() {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is missing. Copy .env.example to .env and add your key.');
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

export async function generateJson({
  prompt,
  schema,
  tools = undefined,
  model = config.textModel,
  label = 'Structured Gemini pass',
  onEvent = undefined
}) {
  return geminiGovernor.schedule({
    label,
    onEvent,
    task: async () => {
      const ai = getClient();
      const interaction = await ai.interactions.create({
        model,
        input: prompt,
        ...(tools ? { tools } : {}),
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema
        }
      });
      if (!interaction.output_text) throw new Error('Gemini returned no structured output.');
      return JSON.parse(interaction.output_text);
    }
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
  const pcm = Buffer.concat(chunks);
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
  voice = 'Kore',
  delivery = '',
  outputPath,
  label = 'Gemini Live narration',
  onEvent = undefined
}) {
  return geminiGovernor.schedule({
    label,
    onEvent,
    task: () => performNarrationAudio({ script, voice, delivery, outputPath })
  });
}

export function geminiQuotaStatus() {
  return geminiGovernor.snapshot();
}
