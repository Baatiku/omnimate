import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

export const COOKIES_FILE_PATH = path.join(config.dataDir, 'cookies.txt');

/**
 * Read currently saved / configured YouTube cookies in Netscape format.
 */
export async function getStoredCookies() {
  if (process.env.YOUTUBE_COOKIES && process.env.YOUTUBE_COOKIES.trim().length > 10) {
    return process.env.YOUTUBE_COOKIES.trim();
  }
  try {
    const stat = await fsp.stat(COOKIES_FILE_PATH);
    if (stat.isFile() && stat.size > 20) {
      const content = await fsp.readFile(COOKIES_FILE_PATH, 'utf8');
      if (content.includes('youtube.com') || content.includes('# Netscape HTTP Cookie File')) {
        return content.trim();
      }
    }
  } catch {}
  return null;
}

/**
 * Save Netscape-format cookie string to .omnimate/cookies.txt
 */
export async function saveCookies(cookiesText) {
  const clean = String(cookiesText || '').trim();
  if (!clean || clean.length < 20) {
    throw new Error('Provided cookies content is empty or invalid.');
  }
  await fsp.mkdir(config.dataDir, { recursive: true });
  const finalContent = clean.startsWith('# Netscape HTTP Cookie File')
    ? clean
    : `# Netscape HTTP Cookie File\n${clean}`;
  await fsp.writeFile(COOKIES_FILE_PATH, finalContent, 'utf8');
  return { success: true, path: COOKIES_FILE_PATH, size: Buffer.byteLength(finalContent) };
}

/**
 * Remove stored cookies
 */
export async function clearCookies() {
  try {
    await fsp.unlink(COOKIES_FILE_PATH);
  } catch {}
}

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
 * Extract YouTube cookies directly from a local browser using yt-dlp.
 * @param {'firefox' | 'edge' | 'chrome' | 'brave' | 'opera' | 'vivaldi'} browser
 */
export async function extractBrowserCookies(browser = 'firefox') {
  const py = findPythonExe();
  const tmpFile = path.join(os.tmpdir(), `omnimate_cookies_${browser}_${Date.now()}.txt`);

  try {
    const args = [
      '-m', 'yt_dlp',
      '--cookies-from-browser', browser,
      '--cookies', tmpFile,
      '--skip-download',
      'https://www.youtube.com',
    ];

    const { stdout, stderr } = await execFileAsync(py, args, { timeout: 35000 });
    if (fs.existsSync(tmpFile)) {
      const stat = fs.statSync(tmpFile);
      if (stat.size > 20) {
        const content = fs.readFileSync(tmpFile, 'utf8');
        try { fs.unlinkSync(tmpFile); } catch {}
        await saveCookies(content);
        return {
          success: true,
          browser,
          size: stat.size,
          source: browser,
        };
      }
    }
    try { fs.unlinkSync(tmpFile); } catch {}
    return {
      success: false,
      browser,
      error: `No cookies extracted from ${browser}.`,
      detail: stderr || stdout,
    };
  } catch (err) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    return {
      success: false,
      browser,
      error: err.message || `Failed to extract from ${browser}`,
    };
  }
}

/**
 * Auto-detect and obtain valid YouTube cookies.
 * 1. Checks stored .omnimate/cookies.txt
 * 2. Tries Firefox (most reliable on Windows without DPAPI locking)
 * 3. Tries Edge and Chrome
 */
export async function autoDetectCookies() {
  const stored = await getStoredCookies();
  if (stored) {
    return { success: true, source: 'file', cookies: stored };
  }

  // Auto-extraction across common local browsers
  const browserList = ['firefox', 'edge', 'chrome', 'brave'];
  for (const b of browserList) {
    const res = await extractBrowserCookies(b);
    if (res.success) {
      const fresh = await getStoredCookies();
      return { success: true, source: b, cookies: fresh };
    }
  }

  return { success: false, source: 'none', cookies: null };
}

/**
 * Get current cookie readiness and source.
 */
export async function getCookiesStatus() {
  const cookies = await getStoredCookies();
  if (cookies) {
    return {
      configured: true,
      source: 'cookies.txt',
      size: cookies.length,
      path: COOKIES_FILE_PATH,
    };
  }
  return {
    configured: false,
    source: 'none',
    size: 0,
    path: COOKIES_FILE_PATH,
  };
}
