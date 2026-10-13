// Calls the Modal GPU worker that renders high-quality lip-sync video.
//
// The Modal endpoint expects multipart form data with `image` (jpg/png) and
// `audio` (wav) fields, and returns an MP4 file. Keeping this client thin
// means the Node server never needs CUDA, PyTorch, or model weights locally.
import { config } from './config.js';

export function modalConfigured() {
  return Boolean(config.modalPresenterUrl);
}

function authHeaders() {
  // Modal web endpoints can be public or bearer-protected. Only send the
  // header when the user configured a key, so public endpoints keep working.
  if (config.modalApiKey) return { authorization: `Bearer ${config.modalApiKey}` };
  return {};
}

// imageBuffer: jpg/png photo of the presenter. audioBuffer: 24kHz wav from Gemini.
// quality: 'high' (A100, LatentSync-class sharpness) or 'fast' (quicker draft).
export async function generateVideoOnModal({ imageBuffer, audioBuffer, quality = 'high', signal = undefined }) {
  if (!modalConfigured()) {
    throw new Error('Modal is not configured. Set MODAL_PRESENTER_URL in .env and redeploy the Modal worker (see modal/presenter.py).');
  }
  if (!imageBuffer?.length) throw new Error('A presenter photo is required.');
  if (!audioBuffer?.length) throw new Error('Narration audio is required before video rendering.');

  const form = new FormData();
  form.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'presenter.jpg');
  form.append('audio', new Blob([audioBuffer], { type: 'audio/wav' }), 'narration.wav');
  form.append('quality', quality);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Modal video render timed out.')), config.modalTimeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });

  try {
    const response = await fetch(config.modalPresenterUrl, {
      method: 'POST',
      headers: { ...authHeaders() },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '').then((text) => text.slice(0, 500));
      throw new Error(`Modal render failed (${response.status}). ${detail}`);
    }
    const video = Buffer.from(await response.arrayBuffer());
    if (video.length < 10_000) throw new Error('Modal returned an unexpectedly small video file.');
    return video;
  } finally {
    clearTimeout(timeout);
  }
}
