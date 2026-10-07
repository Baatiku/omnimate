import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiRateGovernor, isRateLimitError } from '../lib/rate-limit.js';

test('governor spaces globally queued Gemini starts for a 5 RPM budget', async () => {
  let now = 0;
  const starts = [];
  const sleeps = [];
  const governor = new GeminiRateGovernor({
    rpm: 5, safetyMs: 1000, now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; }, random: () => 0
  });
  const makeTask = (id) => governor.schedule({
    label: id,
    onEvent: (event) => { if (event.type === 'start') starts.push(now); },
    task: async () => id
  });
  const values = await Promise.all([makeTask('a'), makeTask('b'), makeTask('c')]);
  assert.deepEqual(values, ['a','b','c']);
  assert.deepEqual(starts, [0,13000,26000]);
  assert.deepEqual(sleeps, [13000,13000]);
  assert.equal(governor.snapshot().pending, 0);
  assert.equal(governor.snapshot().minIntervalMs, 13000);
});

test('429 retries consume another paced request slot instead of hammering Gemini', async () => {
  let now = 0;
  let attempts = 0;
  const events = [];
  const governor = new GeminiRateGovernor({
    rpm: 5, safetyMs: 1000, maxRetries: 2, now: () => now,
    sleep: async (ms) => { now += ms; }, random: () => 0
  });
  const result = await governor.schedule({
    label: 'retry-test',
    onEvent: (event) => events.push({ type: event.type, at: now, waitMs: event.waitMs }),
    task: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('429 RESOURCE_EXHAUSTED');
        error.status = 429;
        throw error;
      }
      return 'ok';
    }
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.equal(events.filter((event) => event.type === 'start').length, 2);
  assert.equal(events.find((event) => event.type === 'retry').waitMs, 13000);
  assert.equal(events.filter((event) => event.type === 'start')[1].at, 13000);
});

test('rate-limit detection recognizes Gemini quota errors', () => {
  assert.equal(isRateLimitError(Object.assign(new Error('nope'), { status: 500 })), false);
  assert.equal(isRateLimitError(Object.assign(new Error('quota'), { status: 429 })), true);
  assert.equal(isRateLimitError(new Error('RESOURCE_EXHAUSTED: rate limit exceeded')), true);
});
