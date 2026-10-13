import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDubCreate, placeSegments, DUB_TARGET_LANGS, autoAssignSpeakerVoices, FEMALE_VOICES, MALE_VOICES, FEMALE_VOICE_TIERS, MALE_VOICE_TIERS } from '../lib/dub.js';

test('dub validation needs one link and picks Hausa by default', () => {
  const input = validateDubCreate({ youtubeUrl: 'https://www.youtube.com/watch?v=abc123', voice: 'Fola' });
  assert.equal(input.targetLang, 'ha');
  assert.throws(() => validateDubCreate({}), /link/);
  assert.throws(() => validateDubCreate({ youtubeUrl: 'not a link' }), /invalid/);
});

test('dub target languages include Hausa', () => {
  assert.ok(DUB_TARGET_LANGS.some((lang) => lang.code === 'ha'));
});

test('lines that fit keep their exact start mark untouched', () => {
  const out = placeSegments([
    { i: 0, start: 0, end: 5, file: 'a.wav', dur: 4 },
    { i: 1, start: 6, end: 12, file: 'b.wav', dur: 5 },
  ], 30);
  assert.deepEqual(out, [
    { i: 0, file: 'a.wav', at_ms: 0, tempo: 1 },
    { i: 1, file: 'b.wav', at_ms: 6000, tempo: 1 },
  ]);
});

test('long lines spill into following silence at natural speed', () => {
  const out = placeSegments([
    { i: 0, start: 0, end: 5, file: 'a.wav', dur: 8 },
    { i: 1, start: 10, end: 15, file: 'b.wav', dur: 4 },
  ], 30);
  assert.equal(out[0].at_ms, 0);
  assert.equal(out[0].tempo, 1);
  assert.equal(out[1].at_ms, 10000);
});

test('overflowing lines compress at most 20 percent, never cut', () => {
  const out = placeSegments([
    { i: 0, start: 0, end: 5, file: 'a.wav', dur: 12 },
    { i: 1, start: 6, end: 11, file: 'b.wav', dur: 4 },
  ], 30);
  assert.equal(out[0].tempo, 1.2);
  // 12s at 1.2x ends at 10s, so the next line slides but keeps its voice.
  assert.equal(out[1].at_ms, 10000);
  assert.equal(out[1].tempo, 1);
});

test('dub validation accepts local files, review mode, and multi-speaker voice mapping', () => {
  const input = validateDubCreate({
    localFile: 'C:/videos/lecture.mp4',
    mode: 'review',
    bgVolume: 0.35,
    ducking: false,
    speakerVoices: { speaker_0: 'Bodi', speaker_1: 'Lumi' },
  });
  assert.equal(input.localFile, 'C:/videos/lecture.mp4');
  assert.equal(input.mode, 'review');
  assert.equal(input.bgVolume, 0.35);
  assert.equal(input.ducking, false);
  assert.equal(input.speakerVoices.speaker_0, 'Bodi');
  assert.equal(input.speakerVoices.speaker_1, 'Lumi');
});

test('placements preserve speaker attribution when provided', () => {
  const out = placeSegments([
    { i: 0, start: 0, end: 5, file: 'a.wav', dur: 4, speaker: 'speaker_0' },
    { i: 1, start: 6, end: 12, file: 'b.wav', dur: 5, speaker: 'speaker_1' },
  ], 30);
  assert.equal(out[0].speaker, 'speaker_0');
  assert.equal(out[1].speaker, 'speaker_1');
});

test('calculatePcmRms and normalizePcm16 level volume dynamically and avoid clipping', async () => {
  const { calculatePcmRms, normalizePcm16 } = await import('../lib/audio.js');

  // Create 1 second of quiet sine-like PCM audio (~ -36 dBFS)
  const sampleRate = 24000;
  const quietPcm = Buffer.alloc(sampleRate * 2);
  for (let i = 0; i < sampleRate; i += 1) {
    const val = Math.round(500 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
    quietPcm.writeInt16LE(val, i * 2);
  }

  const quietRms = calculatePcmRms(quietPcm);
  assert.ok(quietRms < -30, `Quiet RMS was ${quietRms}`);

  // Normalize to -18 dBFS
  const normalized = normalizePcm16(quietPcm, -18);
  const normalizedRms = calculatePcmRms(normalized);
  assert.ok(normalizedRms > quietRms, 'Normalized audio should be louder than quiet input');
  assert.ok(normalizedRms <= -17.5 && normalizedRms >= -23, `Normalized RMS should be near -18 to -22 dBFS, got ${normalizedRms}`);

  // Test peak clamping
  let maxPeak = 0;
  for (let i = 0; i < sampleRate; i += 1) {
    const s = Math.abs(normalized.readInt16LE(i * 2));
    if (s > maxPeak) maxPeak = s;
  }
  assert.ok(maxPeak <= 32767, 'Audio peak must never clip past 32767');
});

test('subtitle formatters produce valid SRT and WebVTT outputs', async () => {
  const { generateSrt, generateVtt } = await import('../lib/audio.js');
  const segments = [
    { i: 0, start: 1.5, end: 4.2, text: 'Sannu da zuwa.' },
    { i: 1, start: 5.0, end: 8.9, text: 'Wannan shiri ne na musamman.' },
  ];

  const srt = generateSrt(segments);
  assert.ok(srt.includes('1\n00:00:01,500 --> 00:00:04,200\nSannu da zuwa.'));
  assert.ok(srt.includes('2\n00:00:05,000 --> 00:00:08,900\nWannan shiri ne na musamman.'));

  const vtt = generateVtt(segments);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:01.500 --> 00:00:04.200'));
});

test('dub target languages default to Hausa with correct codes and labels', () => {
  assert.equal(DUB_TARGET_LANGS[0].code, 'ha');
  assert.equal(DUB_TARGET_LANGS[0].label, 'Hausa (Default)');
  const codes = DUB_TARGET_LANGS.map((l) => l.code);
  assert.deepEqual(codes, ['ha', 'yo', 'ig', 'sw', 'fr', 'ar', 'es']);
});

test('dub validation sets targetLang to Hausa when unspecified', () => {
  const req = validateDubCreate({ youtubeUrl: 'https://youtu.be/test12345' });
  assert.equal(req.targetLang, 'ha');
});

test('autoAssignSpeakerVoices balances gender presentation without collisions or legacy voices', () => {
  const speakersMeta = {
    speaker_0: { id: 'speaker_0', gender: 'Male', pitch_hz: 125.0 },
    speaker_1: { id: 'speaker_1', gender: 'Female', pitch_hz: 220.0 },
    speaker_2: { id: 'speaker_2', gender: 'Male', pitch_hz: 140.0 },
    speaker_3: { id: 'speaker_3', gender: 'Male', pitch_hz: 88.0 },
  };

  const assigned = autoAssignSpeakerVoices(speakersMeta, Object.keys(speakersMeta));

  // Assert distinct voice per speaker
  const values = Object.values(assigned);
  assert.equal(new Set(values).size, 4, 'All 4 speakers must receive distinct voices');

  // Assert female receives female voice
  assert.ok(FEMALE_VOICES.includes(assigned.speaker_1), `Female speaker must get a female voice, got ${assigned.speaker_1}`);

  // Assert males receive male voices
  assert.ok(MALE_VOICES.includes(assigned.speaker_0), `Male speaker 0 must get male voice, got ${assigned.speaker_0}`);
  assert.ok(MALE_VOICES.includes(assigned.speaker_2), `Male speaker 2 must get male voice, got ${assigned.speaker_2}`);
  assert.ok(MALE_VOICES.includes(assigned.speaker_3), `Male speaker 3 must get male voice, got ${assigned.speaker_3}`);

  // Assert retired legacy voices are NEVER assigned
  const forbidden = ['kore', 'puck', 'zephyr', 'fenrir', 'aoede', 'charon', 'leda', 'callirrhoe', 'orus', 'thallo'];
  for (const v of values) {
    assert.ok(!forbidden.includes(v.toLowerCase()), `Forbidden legacy voice detected: ${v}`);
  }
});

test('voice catalog lists 9 females and 21 males totaling 30 modern Google voices', () => {
  assert.equal(FEMALE_VOICES.length, 9);
  assert.equal(MALE_VOICES.length, 21);
  assert.equal(FEMALE_VOICES.length + MALE_VOICES.length, 30);
  assert.ok(FEMALE_VOICES.includes('Fola'));
  assert.ok(FEMALE_VOICES.includes('Lumi'));
  assert.ok(FEMALE_VOICES.includes('Sola'));
  assert.ok(MALE_VOICES.includes('Bodi'));
  assert.ok(MALE_VOICES.includes('Koda'));
  assert.ok(MALE_VOICES.includes('Brio'));
});

test('autoAssignSpeakerVoices matches visual demographic age tiers correctly', () => {
  const speakersMeta = {
    speaker_0: { id: 'speaker_0', gender: 'Female', ageGroup: 'Child', estimatedAge: '7' },
    speaker_1: { id: 'speaker_1', gender: 'Male', ageGroup: 'Child', estimatedAge: '9' },
    speaker_2: { id: 'speaker_2', gender: 'Female', ageGroup: 'Senior', estimatedAge: '68' },
    speaker_3: { id: 'speaker_3', gender: 'Male', ageGroup: 'Senior', estimatedAge: '72' },
  };

  const assigned = autoAssignSpeakerVoices(speakersMeta, Object.keys(speakersMeta));

  // Child female must get a youthful female voice from FEMALE_VOICE_TIERS.Child
  assert.ok(
    FEMALE_VOICE_TIERS.Child.includes(assigned.speaker_0),
    `Girl child should receive child voice (Lumi/Nika/Cleo), got ${assigned.speaker_0}`
  );

  // Child male must get a youthful male voice from MALE_VOICE_TIERS.Child
  assert.ok(
    MALE_VOICE_TIERS.Child.includes(assigned.speaker_1),
    `Boy child should receive child voice (Finn/Arlo/Jett/Tavi), got ${assigned.speaker_1}`
  );

  // Senior female must get a mature female voice from FEMALE_VOICE_TIERS.Senior
  assert.ok(
    FEMALE_VOICE_TIERS.Senior.includes(assigned.speaker_2),
    `Senior woman should receive senior voice (Enya/Tova/Kira), got ${assigned.speaker_2}`
  );

  // Senior male must get a mature male voice from MALE_VOICE_TIERS.Senior
  assert.ok(
    MALE_VOICE_TIERS.Senior.includes(assigned.speaker_3),
    `Senior man should receive senior voice (Daro/Sami/Gero/Neno/Olin/Knox), got ${assigned.speaker_3}`
  );

  // All 4 speakers must have distinct voices without collision
  assert.equal(new Set(Object.values(assigned)).size, 4);
});

test('analyzeVideoContext is exported and callable', async () => {
  const { analyzeVideoContext } = await import('../lib/gemini.js');
  assert.equal(typeof analyzeVideoContext, 'function');
});



