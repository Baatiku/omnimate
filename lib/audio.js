export function pcm16ToWav(pcm, sampleRate = 24000, channels = 1) {
  if (!Buffer.isBuffer(pcm)) pcm = Buffer.from(pcm);
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function pcmDurationSeconds(pcmByteLength, sampleRate = 24000, channels = 1) {
  return pcmByteLength / (sampleRate * channels * 2);
}

/**
 * Calculate the Root Mean Square (RMS) level in dBFS of 16-bit mono PCM audio.
 */
export function calculatePcmRms(pcm) {
  if (!Buffer.isBuffer(pcm)) pcm = Buffer.from(pcm);
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return -Infinity;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const val = pcm.readInt16LE(i * 2);
    sumSquares += val * val;
  }
  const meanSquare = sumSquares / sampleCount;
  if (meanSquare <= 0) return -Infinity;
  const rms = Math.sqrt(meanSquare) / 32768;
  return 20 * Math.log10(Math.max(1e-9, rms));
}

/**
 * Normalize 16-bit mono PCM audio to a consistent target RMS level (in dBFS)
 * with a soft-knee peak limiter to prevent clipping and eliminate scene-to-scene
 * volume jumps.
 */
export function normalizePcm16(pcm, targetRmsDb = -18, maxPeakRatio = 0.95) {
  if (!Buffer.isBuffer(pcm)) pcm = Buffer.from(pcm);
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return pcm;

  const currentRmsDb = calculatePcmRms(pcm);
  if (!Number.isFinite(currentRmsDb) || currentRmsDb < -60) {
    // Silence or near-silence; leave untouched
    return pcm;
  }

  const gainDb = targetRmsDb - currentRmsDb;
  // Limit dynamic boost to between -24dB and +24dB to level dialogue without amplifying room hiss
  const clampedGainDb = Math.max(-24, Math.min(24, gainDb));
  const linearGain = Math.pow(10, clampedGainDb / 20);

  const maxAllowedPeak = Math.floor(32767 * maxPeakRatio);
  const out = Buffer.alloc(sampleCount * 2);

  for (let i = 0; i < sampleCount; i += 1) {
    let sample = pcm.readInt16LE(i * 2) * linearGain;
    // Soft limiter when exceeding target threshold
    if (sample > maxAllowedPeak) {
      const over = sample - maxAllowedPeak;
      sample = maxAllowedPeak + Math.tanh(over / 4000) * 1500;
    } else if (sample < -maxAllowedPeak) {
      const under = -sample - maxAllowedPeak;
      sample = -maxAllowedPeak - Math.tanh(under / 4000) * 1500;
    }
    const clamped = Math.max(-32768, Math.min(32767, Math.round(sample)));
    out.writeInt16LE(clamped, i * 2);
  }
  return out;
}

function pad(num, size = 2) {
  return String(Math.floor(num)).padStart(size, '0');
}

export function formatSrtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

export function formatVttTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
}

export function generateSrt(segments, textKey = 'text') {
  return (segments || []).map((seg, idx) => {
    const start = formatSrtTime(seg.start);
    const end = formatSrtTime(seg.end);
    const text = (seg[textKey] || seg.text || '').trim();
    return `${idx + 1}\n${start} --> ${end}\n${text}\n`;
  }).join('\n');
}

export function generateVtt(segments, textKey = 'text') {
  const lines = ['WEBVTT', ''];
  for (const [idx, seg] of (segments || []).entries()) {
    const start = formatVttTime(seg.start);
    const end = formatVttTime(seg.end);
    const text = (seg[textKey] || seg.text || '').trim();
    lines.push(`${idx + 1}`);
    lines.push(`${start} --> ${end}`);
    lines.push(text);
    lines.push('');
  }
  return lines.join('\n');
}

