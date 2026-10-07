import { config } from './config.js';

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRateLimitError(error) {
  const status = Number(error?.status || error?.code || error?.response?.status || 0);
  const message = String(error?.message || '');
  return status === 429 || /429|RESOURCE_EXHAUSTED|rate limit|quota/i.test(message);
}

function retryAfterMs(error) {
  const header = error?.response?.headers?.get?.('retry-after') ?? error?.headers?.get?.('retry-after');
  if (header == null) return 0;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 0;
}

export class GeminiRateGovernor {
  constructor({
    rpm = config.geminiRpm,
    safetyMs = config.geminiRateSafetyMs,
    maxRetries = config.geminiMaxRetries,
    now = () => Date.now(),
    sleep = sleepDefault,
    random = Math.random
  } = {}) {
    this.rpm = Math.max(1, Number(rpm) || 1);
    this.minIntervalMs = Math.ceil(60_000 / this.rpm) + Math.max(0, Number(safetyMs) || 0);
    this.maxRetries = Math.max(0, Number(maxRetries) || 0);
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.tail = Promise.resolve();
    this.lastStartedAt = Number.NEGATIVE_INFINITY;
    this.pending = 0;
  }

  snapshot() {
    return {
      rpm: this.rpm,
      minIntervalMs: this.minIntervalMs,
      pending: this.pending,
      lastStartedAt: Number.isFinite(this.lastStartedAt) ? this.lastStartedAt : null
    };
  }

  schedule({ label = 'Gemini request', task, onEvent = undefined }) {
    if (typeof task !== 'function') throw new TypeError('GeminiRateGovernor.schedule requires a task function.');
    this.pending += 1;
    const run = this.tail.catch(() => {}).then(async () => {
      await onEvent?.({ type: 'queued', label, ...this.snapshot() });
      try {
        for (let attempt = 0; ; attempt += 1) {
          const spacingWait = Math.max(0, this.lastStartedAt + this.minIntervalMs - this.now());
          if (spacingWait > 0) {
            await onEvent?.({ type: 'wait', label, attempt, waitMs: spacingWait, ...this.snapshot() });
            await this.sleep(spacingWait);
          }
          this.lastStartedAt = this.now();
          await onEvent?.({ type: 'start', label, attempt, ...this.snapshot() });
          try {
            return await task({ attempt });
          } catch (error) {
            if (!isRateLimitError(error) || attempt >= this.maxRetries) throw error;
            const exponential = Math.min(60_000, 2_000 * (2 ** attempt));
            const jitter = Math.floor(this.random() * 1_000);
            const waitMs = Math.max(retryAfterMs(error), exponential + jitter, this.minIntervalMs);
            await onEvent?.({ type: 'retry', label, attempt: attempt + 1, waitMs, error, ...this.snapshot() });
            await this.sleep(waitMs);
          }
        }
      } finally {
        this.pending -= 1;
      }
    });
    this.tail = run;
    return run;
  }
}

export const geminiGovernor = new GeminiRateGovernor();
