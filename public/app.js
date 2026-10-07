import { StudioRenderer } from './studio-renderer.js';

const $ = (id) => document.getElementById(id);
const els = {
  createView: $('createView'), studioView: $('studioView'), createForm: $('createForm'), createButton: $('createButton'),
  prompt: $('prompt'), durationSec: $('durationSec'), aspectRatio: $('aspectRatio'), voice: $('voice'), quality: $('quality'),
  style: $('style'), audience: $('audience'), formError: $('formError'), modelBadge: $('modelBadge'), recentList: $('recentList'), refreshRecent: $('refreshRecent'),
  backButton: $('backButton'), jobTitle: $('jobTitle'), jobStatus: $('jobStatus'), stageList: $('stageList'), projectState: $('projectState'), durationBadge: $('durationBadge'),
  stageCanvas: $('stageCanvas'), stagePlaceholder: $('stagePlaceholder'), playButton: $('playButton'), restartButton: $('restartButton'), scrubber: $('scrubber'), timecode: $('timecode'), narration: $('narration'),
  downloadPlan: $('downloadPlan'), exportButton: $('exportButton'), exportStatus: $('exportStatus'), details: $('details'), planTitle: $('planTitle'), planLogline: $('planLogline'), palette: $('palette'),
  narrationScript: $('narrationScript'), shotList: $('shotList'), crewNotes: $('crewNotes'), regenVoice: $('regenVoice')
};

const renderer = new StudioRenderer(els.stageCanvas);
let activeJob = null;
let pollTimer = null;
let audioGraph = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

async function boot() {
  try {
    const health = await api('/api/health');
    els.modelBadge.textContent = health.geminiConfigured ? `${health.textModel} + Live` : 'Gemini key required';
    els.modelBadge.classList.add(health.geminiConfigured ? 'ready' : 'error');
  } catch {
    els.modelBadge.textContent = 'Server unavailable';
    els.modelBadge.classList.add('error');
  }
  await loadRecent();
}

els.createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.formError.textContent = '';
  els.createButton.disabled = true;
  try {
    const body = {
      prompt: els.prompt.value,
      durationSec: Number(els.durationSec.value),
      aspectRatio: els.aspectRatio.value,
      voice: els.voice.value,
      quality: els.quality.value,
      style: els.style.value,
      audience: els.audience.value
    };
    const result = await api('/api/productions', { method: 'POST', body: JSON.stringify(body) });
    showStudio();
    await openJob(result.id);
  } catch (error) {
    els.formError.textContent = error.message;
  } finally {
    els.createButton.disabled = false;
  }
});

els.backButton.addEventListener('click', () => {
  stopPolling();
  els.narration.pause();
  els.createView.classList.remove('hidden');
  els.studioView.classList.add('hidden');
  loadRecent();
});
els.refreshRecent.addEventListener('click', loadRecent);

async function loadRecent() {
  try {
    const jobs = await api('/api/productions');
    if (!jobs.length) {
      els.recentList.innerHTML = '<p class="muted">No productions yet.</p>';
      return;
    }
    els.recentList.replaceChildren(...jobs.slice(0, 9).map((job) => {
      const button = document.createElement('button');
      button.className = 'recent-item';
      const title = escapeText(job.title || 'Untitled');
      const when = new Date(job.createdAt).toLocaleString();
      button.innerHTML = `<strong>${title}</strong><span>${escapeText(job.status)} · ${escapeText(when)}</span>`;
      button.addEventListener('click', () => { showStudio(); openJob(job.id); });
      return button;
    }));
  } catch (error) {
    els.recentList.innerHTML = `<p class="form-error">${escapeText(error.message)}</p>`;
  }
}

function showStudio() {
  els.createView.classList.add('hidden');
  els.studioView.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function openJob(id) {
  stopPolling();
  await refreshJob(id);
  if (activeJob?.status === 'queued' || activeJob?.status === 'running') {
    pollTimer = setInterval(() => refreshJob(id), 1300);
  }
}

async function refreshJob(id) {
  try {
    activeJob = await api(`/api/productions/${id}`);
    renderJob(activeJob);
    if (activeJob.status === 'completed' || activeJob.status === 'failed') stopPolling();
  } catch (error) {
    els.jobStatus.textContent = error.message;
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function renderJob(job) {
  els.jobTitle.textContent = job.plan?.title || job.options?.prompt?.slice(0, 58) || 'Creating production';
  els.jobStatus.textContent = statusSentence(job);
  els.projectState.textContent = job.status === 'completed' ? 'Ready' : job.status === 'failed' ? 'Failed' : 'Studio working';
  els.projectState.className = `state-pill ${job.status === 'completed' ? 'done' : job.status === 'failed' ? 'failed' : ''}`;
  renderStages(job.stages || []);
  if (job.status === 'failed') {
    els.stagePlaceholder.classList.remove('hidden');
    els.stagePlaceholder.innerHTML = `<strong>Production stopped.</strong><span>${escapeText(job.error || 'Unknown error')}</span>`;
    return;
  }
  if (job.plan) renderPlan(job);
}

function renderStages(stages) {
  els.stageList.replaceChildren(...stages.map((stage) => {
    const row = document.createElement('div');
    row.className = `stage-row ${stage.status}`;
    const icon = stage.status === 'done' ? '✓' : stage.status === 'error' ? '!' : stage.status === 'skipped' ? '–' : stage.status === 'working' ? '•' : '';
    row.innerHTML = `<span class="stage-icon">${icon}</span><div class="stage-copy"><strong>${escapeText(stage.label)}</strong><span>${escapeText(stage.note || stage.status)}</span></div>`;
    return row;
  }));
}

function renderPlan(job) {
  const plan = job.plan;
  renderer.setProduction(plan, els.narration);
  els.stagePlaceholder.classList.add('hidden');
  els.details.classList.remove('hidden');
  els.planTitle.textContent = plan.title;
  els.planLogline.textContent = plan.logline;
  els.narrationScript.textContent = plan.narration?.script || '';
  els.durationBadge.textContent = `${formatTime(plan.duration_sec)} · ${job.options?.aspectRatio || '16:9'} · ${plan.shots?.length || 0} shots`;
  els.palette.replaceChildren(...(plan.visual_identity?.palette || []).slice(0, 8).map((color) => {
    const swatch = document.createElement('span'); swatch.className = 'swatch';
    if (/^#[0-9a-f]{6}$/i.test(color)) swatch.style.background = color;
    swatch.title = color; return swatch;
  }));
  els.shotList.replaceChildren(...(plan.shots || []).map((shot) => {
    const item = document.createElement('div'); item.className = 'shot-item';
    item.innerHTML = `<span class="shot-time">${formatTime(shot.start_sec)}–${formatTime(shot.end_sec)}</span><strong>${escapeText(shot.purpose || shot.setting)}</strong><p>${escapeText(`${shot.camera} · ${shot.mood}${shot.on_screen_text ? ` · “${shot.on_screen_text}”` : ''}`)}</p>`;
    item.addEventListener('click', () => { if (els.narration.src) els.narration.currentTime = shot.start_sec; else renderer.setManualTime(shot.start_sec); });
    return item;
  }));
  const departments = Object.entries(job.departments || {});
  els.crewNotes.replaceChildren(...departments.map(([id, note]) => {
    const el = document.createElement('div'); el.className = 'crew-note';
    el.innerHTML = `<strong>${escapeText(note.department || id)}</strong><p>${escapeText(note.summary || '')}</p>`; return el;
  }));
  els.downloadPlan.disabled = false;
  els.downloadPlan.onclick = () => downloadJson(`${safeName(plan.title)}-production.json`, job);

  if (job.audio?.url) {
    const currentSrc = new URL(els.narration.src || location.href, location.href).pathname + new URL(els.narration.src || location.href, location.href).search;
    if (!els.narration.src || !currentSrc.startsWith(`/api/productions/${job.id}/audio.wav`)) {
      els.narration.src = job.audio.url;
      els.narration.load();
    }
    els.playButton.disabled = false;
    els.restartButton.disabled = false;
    els.scrubber.disabled = false;
    els.exportButton.disabled = false;
    els.scrubber.max = String(plan.duration_sec || job.audio.durationSec || 1);
  }
}

els.playButton.addEventListener('click', async () => {
  if (!els.narration.src) return;
  if (els.narration.paused) { await els.narration.play(); els.playButton.textContent = '❚❚'; }
  else { els.narration.pause(); els.playButton.textContent = '▶'; }
});
els.restartButton.addEventListener('click', async () => {
  els.narration.currentTime = 0; await els.narration.play(); els.playButton.textContent = '❚❚';
});
els.scrubber.addEventListener('input', () => {
  const t = Number(els.scrubber.value);
  if (els.narration.src) els.narration.currentTime = t;
  renderer.setManualTime(t);
});
els.narration.addEventListener('timeupdate', () => {
  els.scrubber.value = String(els.narration.currentTime);
  els.timecode.textContent = `${formatTime(els.narration.currentTime)} / ${formatTime(els.narration.duration || activeJob?.plan?.duration_sec || 0)}`;
});
els.narration.addEventListener('ended', () => { els.playButton.textContent = '▶'; });
els.narration.addEventListener('pause', () => { if (!els.narration.ended) els.playButton.textContent = '▶'; });
els.narration.addEventListener('play', () => { els.playButton.textContent = '❚❚'; });

els.regenVoice.addEventListener('click', async () => {
  if (!activeJob?.id) return;
  els.regenVoice.disabled = true;
  els.regenVoice.textContent = 'Generating…';
  try {
    activeJob = await api(`/api/productions/${activeJob.id}/regenerate-audio`, { method: 'POST', body: JSON.stringify({ voice: els.voice.value }) });
    renderJob(activeJob);
  } catch (error) {
    els.exportStatus.textContent = error.message;
  } finally {
    els.regenVoice.disabled = false;
    els.regenVoice.textContent = 'Regenerate voice';
  }
});

els.exportButton.addEventListener('click', exportWebM);

async function exportWebM() {
  if (!activeJob?.plan || !els.narration.src) return;
  if (!window.MediaRecorder || !els.stageCanvas.captureStream) {
    els.exportStatus.textContent = 'This browser cannot record the canvas. Use current Chrome or Edge.';
    return;
  }
  els.exportButton.disabled = true;
  els.exportStatus.textContent = 'Recording in real time. Keep this tab open until the film ends…';
  try {
    if (!audioGraph) {
      const context = new AudioContext();
      const source = context.createMediaElementSource(els.narration);
      const destination = context.createMediaStreamDestination();
      source.connect(destination);
      source.connect(context.destination);
      audioGraph = { context, source, destination };
    }
    await audioGraph.context.resume();
    const canvasStream = els.stageCanvas.captureStream(30);
    const combined = new MediaStream([...canvasStream.getVideoTracks(), ...audioGraph.destination.stream.getAudioTracks()]);
    const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
    const recorder = new MediaRecorder(combined, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
    recorder.start(1000);
    els.narration.currentTime = 0;
    await els.narration.play();
    await new Promise((resolve) => els.narration.addEventListener('ended', resolve, { once: true }));
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${safeName(activeJob.plan.title)}.webm`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15_000);
    els.exportStatus.textContent = 'Export finished. The WebM file was downloaded.';
  } catch (error) {
    els.exportStatus.textContent = `Export failed: ${error.message}`;
  } finally {
    els.exportButton.disabled = false;
  }
}

function statusSentence(job) {
  if (job.status === 'completed') return 'The showrunner has locked the film. Preview, inspect, regenerate the voice, or export it.';
  if (job.status === 'failed') return job.error || 'Production failed.';
  const stage = job.stages?.find((s) => s.status === 'working');
  return stage ? `${stage.label} is working.` : 'Preparing the studio.';
}
function formatTime(value) { const total = Math.max(0, Math.round(Number(value)||0)); return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`; }
function safeName(value) { return String(value || 'omnimate-film').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64) || 'omnimate-film'; }
function escapeText(value) { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; }
function downloadJson(name, data) { const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000); }

boot();
