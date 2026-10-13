import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { COOKIES_FILE_PATH, autoDetectCookies } from './cookies.js';

const execFileAsync = promisify(execFile);

function findPythonExe() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Python313\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
      'python',
      'py',
    ];
    for (const p of candidates) {
      try {
        if (p.includes('\\') && fs.existsSync(p)) return p;
      } catch {}
    }
  }
  return 'python';
}

/**
 * Downloads a YouTube video locally using the user's residential connection and cookies.
 * Serves as a resilient fallback whenever cloud datacenter IPs trigger YouTube bot blocks.
 */
export async function downloadYouTubeLocally(youtubeUrl, outputPath) {
  const py = findPythonExe();
  await autoDetectCookies();

  const outDir = path.dirname(outputPath);
  await fsp.mkdir(outDir, { recursive: true });

  const tempBase = path.join(outDir, `ytdl_${Date.now()}`);

  // First try: Resilient formats matching Omnibot
  const primaryArgs = [
    '-m', 'yt_dlp',
    '-f', '18/b[height<=720]/bv*[height<=720]+ba/b/best',
    '--merge-output-format', 'mp4',
    '--js-runtimes', 'node',
    '--geo-bypass',
    '--extractor-args', 'youtube:player_client=mweb,android,web',
  ];

  if (fs.existsSync(COOKIES_FILE_PATH)) {
    primaryArgs.push('--cookies', COOKIES_FILE_PATH);
  }
  primaryArgs.push('-o', `${tempBase}.%(ext)s`, youtubeUrl);

  try {
    await execFileAsync(py, primaryArgs, { timeout: 300000 });
  } catch (primaryErr) {
    // Second try: Pre-muxed format 18 (single stream MP4 requiring no ffmpeg merge)
    const fallbackArgs = [
      '-m', 'yt_dlp',
      '-f', '18/best[ext=mp4]/best',
      '--geo-bypass',
      '--extractor-args', 'youtube:player_client=mweb,android,web',
    ];
    if (fs.existsSync(COOKIES_FILE_PATH)) {
      fallbackArgs.push('--cookies', COOKIES_FILE_PATH);
    }
    fallbackArgs.push('-o', `${tempBase}.%(ext)s`, youtubeUrl);
    try {
      await execFileAsync(py, fallbackArgs, { timeout: 300000 });
    } catch (fallbackErr) {
      throw new Error(`Local YouTube download failed: ${fallbackErr.message || primaryErr.message}`);
    }
  }

  const entries = await fsp.readdir(outDir);
  const matching = entries.filter((f) => f.startsWith(path.basename(tempBase)));
  const chosen = matching.find((f) => f.endsWith('.mp4')) || matching[0];

  if (!chosen) {
    throw new Error('Local YouTube download completed but produced no output file.');
  }

  const chosenPath = path.join(outDir, chosen);
  const stat = await fsp.stat(chosenPath);
  if (stat.size < 1000) {
    try { await fsp.unlink(chosenPath); } catch {}
    throw new Error('Local YouTube download produced an empty video file.');
  }

  if (chosenPath !== outputPath) {
    try { await fsp.unlink(outputPath); } catch {}
    await fsp.rename(chosenPath, outputPath);
  }

  return outputPath;
}
