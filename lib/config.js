import fs from 'node:fs';
import path from 'node:path';

export function loadDotEnv(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parsePort(value, fallback) {
  // A bad PORT in .env (empty, words, out of range) must never kill the
  // studio. Fall back to the default and say so out loud.
  const parsed = Number(String(value == null || value === '' ? fallback : value).trim());
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  if (value != null && String(value).trim() !== '') {
    console.warn(`Ignoring invalid PORT ${JSON.stringify(String(value))}; using ${fallback}.`);
  }
  return fallback;
}

function parseModelList(value, fallback) {
  const list = String(value == null || value === '' ? fallback : value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : [...fallback];
}

loadDotEnv();

// Each named model gets its own RPM/TPM/RPD budget on Google's side, so
// rotating steps across several models multiplies effective throughput.
// Search grounding is free only on the 2.5 family; 3.x needs billing.
const DEFAULT_TEXT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite'
];
const DEFAULT_SEARCH_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];

const textModels = Object.freeze(
  process.env.OMNIMATE_TEXT_MODELS
    ? parseModelList(process.env.OMNIMATE_TEXT_MODELS, DEFAULT_TEXT_MODELS)
    : process.env.OMNIMATE_TEXT_MODEL
      // A single-model override still joins the default pool so one env var
      // cannot silently collapse rotation back to one budget.
      ? [...new Set([process.env.OMNIMATE_TEXT_MODEL.trim(), ...DEFAULT_TEXT_MODELS])]
      : [...DEFAULT_TEXT_MODELS]
);
const searchModels = Object.freeze(
  parseModelList(process.env.OMNIMATE_SEARCH_MODELS, DEFAULT_SEARCH_MODELS)
);

export const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: parsePort(process.env.PORT, 8787),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  textModel: textModels[0],
  textModels,
  searchModels,
  liveModel: process.env.OMNIMATE_LIVE_MODEL || 'gemini-3.8-live',
  geminiRpm: Math.max(1, Number(process.env.OMNIMATE_GEMINI_RPM || 5)),
  geminiRateSafetyMs: Math.max(0, Number(process.env.OMNIMATE_GEMINI_RATE_SAFETY_MS || 1000)),
  geminiMaxRetries: Math.max(0, Number(process.env.OMNIMATE_GEMINI_MAX_RETRIES || 3)),
  dataDir: path.resolve(process.env.OMNIMATE_DATA_DIR || '.omnimate'),
  // Photo uploads arrive as base64 data URLs, so the body limit is larger
  // than the old cartoon text-only API.
  maxBodyBytes: Number(process.env.OMNIMATE_MAX_BODY_BYTES || 15_000_000),
  // Modal GPU worker for high-quality lip-sync video.
  // Example: https://your-user--omnimate-presenter-generate.modal.run
  modalPresenterUrl: process.env.MODAL_PRESENTER_URL || '',
  modalDubUrl: process.env.MODAL_DUB_URL || '',
  modalApiKey: process.env.MODAL_API_KEY || '',
  modalTimeoutMs: Math.max(10_000, Number(process.env.MODAL_TIMEOUT_MS || 600_000)),
  maxScriptChars: 5000,
});
