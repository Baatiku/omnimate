import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const checkOnly = process.argv.includes('--check-only');
const nodeMajor = Number(process.versions.node.split('.')[0]);
const checks = [
  ['Node.js 22+', nodeMajor >= 22, process.version],
  ['package.json', fs.existsSync('package.json'), 'required'],
  ['public UI', fs.existsSync('public/index.html') && fs.existsSync('public/app.js'), 'required'],
  ['Gemini key', Boolean(process.env.GEMINI_API_KEY) || fs.existsSync('.env'), 'set GEMINI_API_KEY in .env']
];
if (!checkOnly) {
  const ffmpeg = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  checks.push(['FFmpeg (optional MP4 conversion)', ffmpeg.status === 0, 'optional']);
}
for (const [label, ok, note] of checks) console.log(`${ok ? '✓' : '•'} ${label}${note ? ` — ${note}` : ''}`);
if (!checks.slice(0,3).every(([,ok]) => ok)) process.exitCode = 1;
