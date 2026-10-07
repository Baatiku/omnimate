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

loadDotEnv();

export const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  textModel: process.env.OMNIMATE_TEXT_MODEL || 'gemini-3.8-flash',
  liveModel: process.env.OMNIMATE_LIVE_MODEL || 'gemini-3.8-live',
  dataDir: path.resolve(process.env.OMNIMATE_DATA_DIR || '.omnimate'),
  maxBodyBytes: 1_000_000,
});
