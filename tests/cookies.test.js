import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getStoredCookies,
  saveCookies,
  getCookiesStatus,
  COOKIES_FILE_PATH,
} from '../lib/cookies.js';

test('cookies store saves and retrieves Netscape format cookies', async () => {
  const sampleCookies = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tTEST\t1\n';
  await saveCookies(sampleCookies);

  const stored = await getStoredCookies();
  assert.ok(stored.includes('TEST'));

  const status = await getCookiesStatus();
  assert.equal(status.configured, true);
  assert.ok(status.size > 10);
});

test('saveCookies validates cookie content before writing', async () => {
  await assert.rejects(async () => {
    await saveCookies('');
  }, /empty or invalid/);

  await assert.rejects(async () => {
    await saveCookies('too short');
  }, /empty or invalid/);
});
