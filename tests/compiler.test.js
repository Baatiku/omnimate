import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, fitPlanToAudio } from '../lib/compiler.js';
import { pcm16ToWav, pcmDurationSeconds } from '../lib/audio.js';

const base = {
  title: 'Test', logline: 'x', audience: 'all',
  visual_identity: { style:'x', palette:['#112233','#445566'], character_design:'x', motion_language:'x', camera_language:'x' },
  narration: { language:'English', delivery:'warm', script:'Hello' },
  cast: [{ id:'host', name:'Host', role:'host', appearance:'simple', personality:'warm' }],
  shots: [
    { id:'a', start_sec:0, end_sec:3, purpose:'hook', setting:'studio', background:'room', camera:'wide', mood:'bright', narration_excerpt:'', on_screen_text:'', actors:[{id:'host',x:2,y:-1,scale:4,action:'not-real',expression:'nope',look_at:''}], props:[], visual_effects:[] },
    { id:'b', start_sec:2, end_sec:6, purpose:'body', setting:'studio', background:'room', camera:'medium', mood:'bright', narration_excerpt:'', on_screen_text:'', actors:[], props:[], visual_effects:[] }
  ], quality_checklist: []
};

test('normalizer constrains actions and stage coordinates', () => {
  const plan = normalizePlan(base, 30);
  assert.equal(plan.duration_sec, 30);
  assert.equal(plan.shots[0].actors[0].action, 'idle');
  assert.equal(plan.shots[0].actors[0].expression, 'neutral');
  assert.equal(plan.shots[0].actors[0].x, .92);
  assert.equal(plan.shots[0].actors[0].y, .35);
  assert.ok(plan.shots[1].start_sec >= plan.shots[0].end_sec - .001);
});

test('audio conform scales the whole timeline', () => {
  const plan = normalizePlan(base, 30);
  const fitted = fitPlanToAudio(plan, 45);
  assert.equal(fitted.duration_sec, 45);
  assert.equal(fitted.shots.at(-1).end_sec, 45);
});

test('wav writer creates a valid PCM header', () => {
  const pcm = Buffer.alloc(48000);
  const wav = pcm16ToWav(pcm, 24000, 1);
  assert.equal(wav.toString('ascii',0,4), 'RIFF');
  assert.equal(wav.toString('ascii',8,12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(pcmDurationSeconds(pcm.length,24000,1), 1);
});
