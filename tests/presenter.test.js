import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePresenterCreate, presenterFingerprint, makePresenterJob, validateScriptPrompt, PRESENTER_VOICES, voiceByName } from '../lib/presenter.js';

const tinyJpeg = `data:image/jpeg;base64,${Buffer.alloc(20_000, 7).toString('base64')}`;

test('presenter validation accepts a photo, script, and voice', () => {
  const input = validatePresenterCreate({ script: 'Hello world, this is my presenter test.', voice: 'Fola', quality: 'high', title: 'Test', photoDataUrl: tinyJpeg });
  assert.equal(input.voice, 'Fola');
  assert.equal(input.quality, 'high');
  assert.ok(input.photoBuffer.length > 10_000);
});

test('presenter validation rejects missing photo and tiny script', () => {
  assert.throws(() => validatePresenterCreate({ script: 'hi', voice: 'Fola', quality: 'high', photoDataUrl: tinyJpeg }), /at least a sentence/);
  assert.throws(() => validatePresenterCreate({ script: 'Hello world, this is fine.', voice: 'Fola', quality: 'high', photoDataUrl: 'not-a-photo' }), /JPG or PNG/);
});

test('same script plus same photo reuses the running job fingerprint', () => {
  const first = validatePresenterCreate({ script: 'Same script here for dedupe.', voice: 'Bodi', quality: 'fast', photoDataUrl: tinyJpeg });
  const second = validatePresenterCreate({ script: 'Same script here for dedupe.', voice: 'Bodi', quality: 'fast', photoDataUrl: tinyJpeg });
  const a = presenterFingerprint({ script: first.script, voice: first.voice, quality: first.quality, photoBuffer: first.photoBuffer });
  const b = presenterFingerprint({ script: second.script, voice: second.voice, quality: second.quality, photoBuffer: second.photoBuffer });
  assert.equal(a, b);
  const job = makePresenterJob({ id: 'pres_test', fingerprint: a, input: first });
  assert.equal(job.status, 'queued');
  assert.equal(job.kind, 'realistic-presenter');
});

test('voice catalog holds 30 Google voices with gender labels', () => {
  assert.equal(PRESENTER_VOICES.length, 30);
  for (const voice of PRESENTER_VOICES) {
    assert.match(voice.name, /^[A-Z][a-z]+$/);
    assert.ok(['Female', 'Male'].includes(voice.gender));
  }
  // Check female voices
  assert.equal(voiceByName('Fola')?.gender, 'Female');
  assert.equal(voiceByName('Lumi')?.gender, 'Female');
  assert.equal(voiceByName('Sola')?.gender, 'Female');

  // Check male voices
  assert.equal(voiceByName('Bodi')?.gender, 'Male');
  assert.equal(voiceByName('Koda')?.gender, 'Male');

  // Old voices must be completely removed
  assert.equal(voiceByName('Kore'), null);
  assert.equal(voiceByName('Puck'), null);
  assert.equal(voiceByName('Zephyr'), null);
  assert.equal(voiceByName('Nobody'), null);
});

test('script prompt validation accepts topic plus length', () => {
  const input = validateScriptPrompt({ prompt: 'A morning football roundup.', durationSec: 90 });
  assert.equal(input.durationSec, 90);
  assert.throws(() => validateScriptPrompt({ prompt: 'hi' }), /talk about/);
});
