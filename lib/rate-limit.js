import { config } from './config.js';

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRateLimitError(error) {
  const status = Number(error?.status || error?.code || error?.response?.status || 0);
  const message = String(error?.message || '');
  return status === 429 || /429|RESOURCE_EXHAUSTED|rate limit|quota/i.test(message);
}

// Overload errors (503, "high demand", UNAVAILABLE) are temporary just like
// 429s: back off, then hand the step to the next model. Kept separate from
// isRateLimitError so existing callers and tests keep their meaning.
export function isTransientError(error) {
  if (isRateLimitError(error)) return true;
  const status = Number(error?.status || error?.code || error?.response?.status || 0);
  if ([500, 502, 503, 504].includes(status)) return true;
  return /overload|unavailable|high demand|try again later|capacity|internal error|temporarily/i.test(String(error?.message || ''));
}

function retryAfterMs(error) {
  const header = error?.response?.headers?.get?.('retry-after') ?? error?.headers?.get?.('retry-after');
  if (header != null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  }
  const msg = String(error?.message || '');
  const match = /retryDelay["']?\s*:\s*["']?(\d+)s/i.exec(msg) || /retry in\s+(\d+)h/i.exec(msg);
  if (match) return Number(match[1]) * 1000;
  if (/quota exceeded|daily limit|free_tier_requests|limit: \d+/i.test(msg)) {
    return 3600_000;
  }
  return 0;
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
            const retryMs = retryAfterMs(error);
            if (!isTransientError(error) || attempt >= this.maxRetries || retryMs > 30_000) throw error;
            const exponential = Math.min(60_000, 2_000 * (2 ** attempt));
            const jitter = Math.floor(this.random() * 1_000);
            const waitMs = Math.max(retryMs, exponential + jitter, this.minIntervalMs);
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

// Per-model governors: Google enforces RPM/TPM/RPD separately for each model
// name, so each model gets its own pacing tracker. The default governor above
// is kept for backwards compatibility (tests, single-model callers).
const governorsByModel = new Map();

export function governorForModel(model) {
  const name = String(model || 'default');
  let governor = governorsByModel.get(name);
  if (!governor) {
    governor = new GeminiRateGovernor();
    governorsByModel.set(name, governor);
  }
  return governor;
}

export function scheduleOnModel({ model, label, task, onEvent }) {
  return governorForModel(model).schedule({
    label: label ? `${label} [${model}]` : String(model),
    task,
    onEvent: onEvent
      ? (event) => onEvent({ ...event, model })
      : undefined
  });
}

export function modelPoolSnapshot() {
  return [...governorsByModel.entries()].map(([model, governor]) => ({
    model,
    ...governor.snapshot()
  }));
}
