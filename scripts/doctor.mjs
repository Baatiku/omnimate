import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const checkOnly = process.argv.includes('--check-only');
const nodeMajor = Number(process.versions.node.split('.')[0]);

function sourceFiles() {
  const roots = ['lib', 'public', 'scripts', 'tests'];
  const files = [path.join(root, 'server.js')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:m?js)$/.test(entry.name)) files.push(full);
    }
  };
  for (const relative of roots) {
    const dir = path.join(root, relative);
    if (fs.existsSync(dir)) walk(dir);
  }
  return files;
}

function syntaxCheck() {
  const failures = [];
  for (const file of sourceFiles()) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`${path.relative(root, file)}: ${(result.stderr || result.stdout).trim()}`);
  }
  return failures;
}

const syntaxFailures = syntaxCheck();
const checks = [
  ['Node.js 22+', nodeMajor >= 22, process.version],
  ['package.json', fs.existsSync(path.join(root, 'package.json')), 'required'],
  ['public UI', fs.existsSync(path.join(root, 'public/index.html')) && fs.existsSync(path.join(root, 'public/app.js')), 'required'],
  ['JavaScript syntax', syntaxFailures.length === 0, syntaxFailures.length ? syntaxFailures.join(' | ') : `${sourceFiles().length} files checked`],
  ['Gemini key', Boolean(config.geminiApiKey), config.geminiApiKey ? 'configured' : 'set GEMINI_API_KEY in .env before generating a film']
];

if (!checkOnly) {
  const ffmpeg = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  checks.push(['FFmpeg (optional MP4 conversion)', ffmpeg.status === 0, 'optional']);
}

for (const [label, ok, note] of checks) console.log(`${ok ? '✓' : '•'} ${label}${note ? ` — ${note}` : ''}`);
if (!checks.slice(0, 4).every(([, ok]) => ok)) process.exitCode = 1;
