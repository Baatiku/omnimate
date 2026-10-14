import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePresenterCreate, presenterFingerprint, makePresenterJob, validateScriptPrompt, PRESENTER_VOICES, voiceByName } from '../lib/presenter.js';

const tinyJpeg = `data:image/jpeg;base64,${Buffer.alloc(20_000, 7).toString('base64')}`;

test('presenter validation accepts a photo, script, and voice', () => {
  const input = validatePresenterCreate({ script: 'Hello world, this is my presenter test.', voice: 'Aoede', quality: 'high', title: 'Test', photoDataUrl: tinyJpeg });
  assert.equal(input.voice, 'Aoede');
  assert.equal(input.quality, 'high');
  assert.ok(input.photoBuffer.length > 10_000);
});

test('presenter validation rejects missing photo and tiny script', () => {
  assert.throws(() => validatePresenterCreate({ script: 'hi', voice: 'Aoede', quality: 'high', photoDataUrl: tinyJpeg }), /at least a sentence/);
  assert.throws(() => validatePresenterCreate({ script: 'Hello world, this is fine.', voice: 'Aoede', quality: 'high', photoDataUrl: 'not-a-photo' }), /JPG or PNG/);
});

test('same script plus same photo reuses the running job fingerprint', () => {
  const first = validatePresenterCreate({ script: 'Same script here for dedupe.', voice: 'Charon', quality: 'fast', photoDataUrl: tinyJpeg });
  const second = validatePresenterCreate({ script: 'Same script here for dedupe.', voice: 'Charon', quality: 'fast', photoDataUrl: tinyJpeg });
  const a = presenterFingerprint({ script: first.script, voice: first.voice, quality: first.quality, photoBuffer: first.photoBuffer });
  const b = presenterFingerprint({ script: second.script, voice: second.voice, quality: second.quality, photoBuffer: second.photoBuffer });
  assert.equal(a, b);
  const job = makePresenterJob({ id: 'pres_test', fingerprint: a, input: first });
  assert.equal(job.status, 'queued');
  assert.equal(job.kind, 'realistic-presenter');
});

test('voice catalog holds official Google voices with gender labels', () => {
  assert.equal(PRESENTER_VOICES.length, 67);
  for (const voice of PRESENTER_VOICES) {
    assert.match(voice.name, /^[A-Z][a-z]+$/);
    assert.ok(['Female', 'Male'].includes(voice.gender));
  }
  // Check female voices
  assert.equal(voiceByName('Aoede')?.gender, 'Female');
  assert.equal(voiceByName('Fola')?.gender, 'Female');
  assert.equal(voiceByName('Lumi')?.gender, 'Female');
  assert.equal(voiceByName('Sola')?.gender, 'Female');
  assert.equal(voiceByName('Kore')?.gender, 'Female');
  assert.equal(voiceByName('Zephyr')?.gender, 'Female');

  // Check male voices
  assert.equal(voiceByName('Bodi')?.gender, 'Male');
  assert.equal(voiceByName('Koda')?.gender, 'Male');
  assert.equal(voiceByName('Charon')?.gender, 'Male');
  assert.equal(voiceByName('Puck')?.gender, 'Male');
  assert.equal(voiceByName('Fenrir')?.gender, 'Male');

  // Check female voices
  assert.equal(voiceByName('Fola')?.gender, 'Female');
  assert.equal(voiceByName('Aoede')?.gender, 'Female');

  // Fictional / hallucinated names must return null
  assert.equal(voiceByName('FictionalVoice'), null);
  assert.equal(voiceByName('Nobody'), null);
});

test('script prompt validation accepts topic plus length', () => {
  const input = validateScriptPrompt({ prompt: 'A morning football roundup.', durationSec: 90 });
  assert.equal(input.durationSec, 90);
  assert.throws(() => validateScriptPrompt({ prompt: 'hi' }), /talk about/);
});
