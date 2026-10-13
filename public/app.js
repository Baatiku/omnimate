// Realistic presenter studio UI: photo + script -> video.
const photoInput = document.getElementById('photo');
const preview = document.getElementById('preview');
const scriptInput = document.getElementById('script');
const voiceSelect = document.getElementById('voice');
const qualitySelect = document.getElementById('quality');
const titleInput = document.getElementById('title');
const promptInput = document.getElementById('prompt');
const lengthSelect = document.getElementById('length');
const writeScriptButton = document.getElementById('writeScript');
const dubUrlInput = document.getElementById('dubUrl');
const dubDirectInput = document.getElementById('dubDirect');
const dubLangSelect = document.getElementById('dubLang');
const dubVoiceSelect = document.getElementById('dubVoice');
const dubGenerateButton = document.getElementById('dubGenerate');
const dubStatusEl = document.getElementById('dubStatus');
const dubResult = document.getElementById('dubResultCard');
const dubVideo = document.getElementById('dubVideo');
const dubDownload = document.getElementById('dubDownload');
const dubAudio = document.getElementById('dubAudio');

const dubFileInput = document.getElementById('dubFile');
const dubModeSelect = document.getElementById('dubMode');
const dubBgVolumeSlider = document.getElementById('dubBgVolume');
const dubBgVolumeVal = document.getElementById('dubBgVolumeVal');
const dubDuckingCheckbox = document.getElementById('dubDucking');
const dubStudioCard = document.getElementById('dubStudioCard');
const dubSpeakersGrid = document.getElementById('dubSpeakersGrid');
const dubAddSpeakerBtn = document.getElementById('dubAddSpeakerBtn');
const dubSegmentsList = document.getElementById('dubSegmentsList');
const dubSaveSegmentsBtn = document.getElementById('dubSaveSegments');
const dubSaveSegmentsTopBtn = document.getElementById('dubSaveSegmentsTop');
const dubApproveRenderBtn = document.getElementById('dubApproveRender');
const dubApproveRenderTopBtn = document.getElementById('dubApproveRenderTop');
const dubSrtLink = document.getElementById('dubSrt');
const dubVttLink = document.getElementById('dubVtt');
const dubTimerContainer = document.getElementById('dubTimer');
const dubTimerText = document.getElementById('dubTimerText');
const dubTimerPhase = document.getElementById('dubTimerPhase');
let dubTimerInterval = null;

function startDubTimer(startedAt = Date.now()) {
  if (dubTimerInterval) clearInterval(dubTimerInterval);
  if (dubTimerContainer) dubTimerContainer.hidden = false;
  const update = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    if (dubTimerText) dubTimerText.textContent = `${m}:${s}`;
  };
  update();
  dubTimerInterval = setInterval(update, 1000);
}

function stopDubTimer(finalPhase = '') {
  if (dubTimerInterval) {
    clearInterval(dubTimerInterval);
    dubTimerInterval = null;
  }
  if (finalPhase && dubTimerPhase) {
    dubTimerPhase.textContent = finalPhase;
  }
}

function setDubStatus(message) {
  dubStatusEl.textContent = message || '';
}
const generateButton = document.getElementById('generate');
const statusEl = document.getElementById('status');
const healthEl = document.getElementById('health');
const resultCard = document.getElementById('resultCard');
const resultVideo = document.getElementById('resultVideo');
const resultAudio = document.getElementById('resultAudio');
const recentList = document.getElementById('recent');
const recentDubsList = document.getElementById('recentDubs');
const navPresenter = document.getElementById('navPresenter');
const navDub = document.getElementById('navDub');
const tabPresenter = document.getElementById('tab-presenter');
const tabDub = document.getElementById('tab-dub');

function showTab(which) {
  const presenter = which !== 'dub';
  tabPresenter.hidden = !presenter;
  tabDub.hidden = presenter;
  navPresenter.classList.toggle('active', presenter);
  navDub.classList.toggle('active', !presenter);
}

navPresenter.addEventListener('click', () => showTab('presenter'));
navDub.addEventListener('click', () => showTab('dub'));

function elapsedText(since) {
  const secs = Math.floor((Date.now() - since) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

let photoDataUrl = '';

function setStatus(message) {
  statusEl.textContent = message || '';
}

async function refreshHealth() {
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    const parts = [];
    parts.push(health.geminiConfigured ? 'Gemini voice: ready' : 'Gemini voice: add GEMINI_API_KEY to .env');
    parts.push(health.modalConfigured ? 'Modal video: ready' : 'Modal video: set MODAL_PRESENTER_URL after modal deploy');
    healthEl.textContent = parts.join(' • ');
  } catch {
    healthEl.textContent = 'Studio server is not reachable.';
  }
}

async function refreshRecent() {
  try {
    const response = await fetch('/api/presenters');
    const jobs = await response.json();
    recentList.innerHTML = '';
    for (const job of jobs.slice(0, 10)) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = `${job.options?.title || 'Untitled'} — ${job.status}`;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        loadJob(job.id);
      });
      item.appendChild(link);
      recentList.appendChild(item);
    }
    if (!jobs.length) recentList.innerHTML = '<li>No presenters yet.</li>';
  } catch {
    recentList.innerHTML = '<li>Could not load recent presenters.</li>';
  }
}

async function loadJob(id) {
  const response = await fetch(`/api/presenters/${encodeURIComponent(id)}`);
  if (!response.ok) {
    setStatus('Could not load that presenter.');
    return;
  }
  const job = await response.json();
  if (job.video?.url) {
    resultCard.hidden = false;
    resultVideo.src = job.video.url;
  }
  if (job.audio?.url) resultAudio.src = job.audio.url;
  setStatus(`Status: ${job.status}${job.error ? ` — ${job.error}` : ''}`);
}

async function pollJob(id) {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const response = await fetch(`/api/presenters/${encodeURIComponent(id)}`);
    if (!response.ok) continue;
    const job = await response.json();
    setStatus(`[${elapsedText(startedAt)}] ${job.status}… (voice, then video — high quality takes a few minutes)`);
    if (job.status === 'done') {
      resultCard.hidden = false;
      if (job.video?.url) resultVideo.src = job.video.url;
      if (job.audio?.url) resultAudio.src = job.audio.url;
      setStatus('Done. Preview above.');
      refreshRecent();
      return;
    }
    if (job.status === 'failed') {
      setStatus(`Failed: ${job.error || 'unknown error'}`);
      refreshRecent();
      return;
    }
  }
  setStatus('Still working — refresh in a minute and check Recent presenters.');
}

photoInput.addEventListener('change', () => {
  const file = photoInput.files?.[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    setStatus('Use a JPG or PNG photo.');
    return;
  }
  if (file.size > 10_000_000) {
    setStatus('That photo is larger than 10 MB.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    photoDataUrl = String(reader.result || '');
    preview.src = photoDataUrl;
    preview.hidden = false;
    setStatus('');
  };
  reader.readAsDataURL(file);
});

async function loadVoices() {
  try {
    const response = await fetch('/api/voices');
    const voices = await response.json();
    cachedVoices = voices;
    voiceSelect.innerHTML = '';
    for (const gender of ['Female', 'Male']) {
      const group = document.createElement('optgroup');
      group.label = gender === 'Female' ? 'Female voices' : 'Male voices';
      for (const voice of voices.filter((v) => v.gender === gender)) {
        const option = document.createElement('option');
        option.value = voice.name;
        option.textContent = `${voice.name} — ${voice.style}`;
        group.appendChild(option);
      }
      voiceSelect.appendChild(group);
    }
    voiceSelect.value = voices[0]?.name || 'Charon';
    if (dubVoiceSelect) {
      dubVoiceSelect.innerHTML = '';
      const autoOption = document.createElement('option');
      autoOption.value = 'auto';
      autoOption.textContent = '✨ Auto-Cast Voices (Face & Age AI)';
      autoOption.selected = true;
      dubVoiceSelect.appendChild(autoOption);

      for (const gender of ['Female', 'Male']) {
        const group = document.createElement('optgroup');
        group.label = gender === 'Female' ? 'Force Female Voice (Solo Narrator)' : 'Force Male Voice (Solo Narrator)';
        for (const voice of voices.filter((v) => v.gender === gender)) {
          const option = document.createElement('option');
          option.value = voice.name;
          option.textContent = `${voice.name} — ${voice.style}`;
          group.appendChild(option);
        }
        dubVoiceSelect.appendChild(group);
      }
      dubVoiceSelect.value = 'auto';
    }
  } catch {
    voiceSelect.innerHTML = '<option>Charon</option>';
  }
}

async function loadDubLangs() {
  try {
    const response = await fetch('/api/dub-langs');
    const langs = await response.json();
    dubLangSelect.innerHTML = '';
    for (const lang of langs) {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = lang.label;
      if (lang.code === 'ha') option.selected = true;
      dubLangSelect.appendChild(option);
    }
    dubLangSelect.value = 'ha';
  } catch {
    /* Hausa default stays */
  }
}

let cachedVoices = [];
let currentReviewJob = null;

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function emotionIcon(emotion = '') {
  const e = String(emotion || '').toLowerCase();
  if (e.includes('enthusiastic') || e.includes('excited')) return '🔥';
  if (e.includes('humor') || e.includes('funny') || e.includes('laugh')) return '😄';
  if (e.includes('serious') || e.includes('solemn') || e.includes('firm')) return '🎭';
  if (e.includes('urgent') || e.includes('quick') || e.includes('alarm')) return '⚡';
  if (e.includes('warm') || e.includes('friendly') || e.includes('gentle')) return '😊';
  if (e.includes('curious') || e.includes('inquisitive') || e.includes('question')) return '🤔';
  if (e.includes('somber') || e.includes('sad') || e.includes('calm')) return '🍃';
  if (e.includes('authoritative') || e.includes('formal')) return '🏛️';
  return '💬';
}

function formatSec(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(s / 60);
  const secs = (s % 60).toFixed(1);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(4, '0')}`;
}

dubBgVolumeSlider?.addEventListener('input', () => {
  if (dubBgVolumeVal) {
    dubBgVolumeVal.textContent = `${Math.round(dubBgVolumeSlider.value * 100)}%`;
  }
});

function renderReviewStudio(job) {
  currentReviewJob = job;
  dubStudioCard.hidden = false;

  const segments = job.segmentsData || [];
  const speakerVoices = job.speakerVoices || {};
  const speakersMeta = job.speakersMeta || {};

  // Render Video Focus & Context Banner
  const contextBanner = document.getElementById('dubContextBanner');
  const contextGenreBadge = document.getElementById('dubContextGenreBadge');
  const contextTone = document.getElementById('dubContextTone');
  const contextSummary = document.getElementById('dubContextSummary');
  if (contextBanner) {
    if (job.context && job.context.summary) {
      contextBanner.hidden = false;
      const genreIcons = {
        'Documentary': '🎥',
        'Movie / Drama': '🎬',
        'Podcast / Interview': '🎙️',
        'News Broadcast': '📰',
        'Educational / Explainer': '📚',
        'Comedy / Entertainment': '🎭',
        'Vlog / Lifestyle': '📹',
        'Sports / Commentary': '⚽',
      };
      const icon = genreIcons[job.context.genre] || '🎬';
      if (contextGenreBadge) contextGenreBadge.textContent = `${icon} ${job.context.genre || 'Video'}`;
      if (contextTone) contextTone.textContent = job.context.overallTone ? `Tone: ${job.context.overallTone}` : '';
      if (contextSummary) contextSummary.textContent = job.context.summary || '';
    } else {
      contextBanner.hidden = true;
    }
  }

  // Find all unique speakers from metadata and segments
  const speakers = [...new Set([
    ...Object.keys(speakersMeta),
    ...segments.map((s) => s.speaker || 'speaker_0'),
  ])];
  if (!speakers.includes('speaker_0')) speakers.unshift('speaker_0');

  // Render speakers voice assignment panel
  dubSpeakersGrid.innerHTML = '';
  for (const spk of speakers) {
    const meta = speakersMeta[spk] || {};
    const spkSegs = segments.filter((s) => (s.speaker || 'speaker_0') === spk);
    const count = meta.count ?? spkSegs.length;
    const totalSec = meta.total_sec ?? spkSegs.reduce((sum, s) => sum + (s.end - s.start), 0).toFixed(1);
    const gender = meta.gender || (meta.pitch_hz >= 165 ? 'Female' : 'Male');
    const pitchText = meta.pitch_hz ? ` (~${Math.round(meta.pitch_hz)} Hz)` : '';
    const sampleSegIndex = meta.sample_seg_i ?? (spkSegs[0]?.i ?? 0);

    const card = document.createElement('div');
    card.className = 'speaker-card';
    card.id = `speaker-card-${spk}`;

    const ageGroup = meta.ageGroup || 'Adult';
    const estimatedAge = meta.estimatedAge || '';
    const expression = meta.expression || '';

    // Card Header: Avatar Thumbnail + Speaker Name + Demographic Badges
    const header = document.createElement('div');
    header.className = 'speaker-card-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'speaker-header-left';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'speaker-avatar-wrap';

    const fallbackEmoji = document.createElement('span');
    fallbackEmoji.className = 'speaker-avatar-fallback';
    fallbackEmoji.textContent = ageGroup === 'Child'
      ? (gender === 'Female' ? '👧' : '👦')
      : ageGroup === 'Senior'
        ? (gender === 'Female' ? '👵' : '👴')
        : (gender === 'Female' ? '👩' : '👨');

    const avatarImg = document.createElement('img');
    avatarImg.className = 'speaker-avatar-img';
    avatarImg.alt = spk;
    avatarImg.src = `/api/dubs/${encodeURIComponent(job.id)}/face/${encodeURIComponent(spk)}.jpg`;
    avatarImg.onerror = () => {
      avatarImg.style.display = 'none';
      fallbackEmoji.style.display = 'inline-block';
    };
    avatarImg.onload = () => {
      fallbackEmoji.style.display = 'none';
    };

    avatarWrap.appendChild(fallbackEmoji);
    avatarWrap.appendChild(avatarImg);
    headerLeft.appendChild(avatarWrap);

    const metaCol = document.createElement('div');
    metaCol.className = 'speaker-header-meta';

    const title = document.createElement('span');
    title.className = 'speaker-card-title';
    title.textContent = spk.replace('_', ' ').toUpperCase();
    metaCol.appendChild(title);

    const badgesWrap = document.createElement('div');
    badgesWrap.className = 'speaker-header-badges';

    const genderBadge = document.createElement('span');
    genderBadge.className = `gender-badge ${gender.toLowerCase()}`;
    genderBadge.textContent = gender === 'Female' ? `♀ Female${pitchText}` : `♂ Male${pitchText}`;
    genderBadge.title = meta.faceDetected ? 'Visual and acoustic detection' : `Acoustic pitch${pitchText}`;
    badgesWrap.appendChild(genderBadge);

    const ageBadge = document.createElement('span');
    const ageClass = ageGroup.toLowerCase().replace(/\s+/g, '-');
    ageBadge.className = `age-badge ${ageClass}`;
    const ageIcon = ageGroup === 'Child' ? '👶' : ageGroup === 'Teen' ? '🧑' : ageGroup === 'Senior' ? '🧓' : '👤';
    const ageText = estimatedAge && estimatedAge !== 'Off-screen' && estimatedAge !== 'Unknown'
      ? `${ageIcon} ${ageGroup} (~${estimatedAge})`
      : `${ageIcon} ${ageGroup}`;
    ageBadge.textContent = ageText;
    badgesWrap.appendChild(ageBadge);

    if (expression && expression !== 'neutral') {
      const exprBadge = document.createElement('span');
      exprBadge.className = 'expression-badge';
      exprBadge.textContent = `😊 ${expression}`;
      badgesWrap.appendChild(exprBadge);
    }

    metaCol.appendChild(badgesWrap);
    headerLeft.appendChild(metaCol);
    header.appendChild(headerLeft);
    card.appendChild(header);

    // Stats line
    const stats = document.createElement('div');
    stats.className = 'speaker-card-stats';
    stats.textContent = `${count} line${count === 1 ? '' : 's'} (${totalSec}s speaking time)`;
    card.appendChild(stats);

    // Voice Selector Row
    const selectRow = document.createElement('div');
    selectRow.className = 'speaker-card-select-row';

    const selectLabel = document.createElement('label');
    selectLabel.className = 'speaker-card-select-label';
    selectLabel.textContent = 'Voice (Google Gemini):';

    const select = document.createElement('select');
    select.setAttribute('data-speaker', spk);

    for (const g of ['Female', 'Male']) {
      const group = document.createElement('optgroup');
      group.label = g === 'Female' ? 'Female Voices (Google)' : 'Male Voices (Google)';
      for (const v of cachedVoices.filter((v) => v.gender === g)) {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.style})`;
        if (speakerVoices[spk] === v.name) {
          opt.selected = true;
        } else if (!speakerVoices[spk] && v.name === job.voice) {
          opt.selected = true;
        }
        group.appendChild(opt);
      }
      select.appendChild(group);
    }

    select.addEventListener('change', () => {
      if (!currentReviewJob.speakerVoices) currentReviewJob.speakerVoices = {};
      currentReviewJob.speakerVoices[spk] = select.value;
    });

    selectRow.appendChild(selectLabel);
    selectRow.appendChild(select);
    card.appendChild(selectRow);

    // Vocal Performance Direction / Tone Prompt Row
    const promptRow = document.createElement('div');
    promptRow.className = 'speaker-card-prompt-row';

    const promptLabel = document.createElement('label');
    promptLabel.className = 'speaker-card-select-label';
    promptLabel.textContent = 'Acting Direction (Gemini TTS):';

    const promptInput = document.createElement('input');
    promptInput.type = 'text';
    promptInput.className = 'speaker-acting-prompt-input';
    promptInput.value = meta.vocalActingPrompt || '';
    promptInput.placeholder = 'e.g. Young child voice, energetic, playful tone...';
    promptInput.title = 'Vocal acting instructions sent to Gemini Live TTS for all lines spoken by this character';
    promptInput.addEventListener('change', () => {
      if (!currentReviewJob.speakersMeta) currentReviewJob.speakersMeta = {};
      if (!currentReviewJob.speakersMeta[spk]) currentReviewJob.speakersMeta[spk] = {};
      currentReviewJob.speakersMeta[spk].vocalActingPrompt = promptInput.value.trim();
    });

    promptRow.appendChild(promptLabel);
    promptRow.appendChild(promptInput);
    card.appendChild(promptRow);

    // Action Row: Listen to original speaker audio from the video clip
    const actionRow = document.createElement('div');
    actionRow.className = 'speaker-card-actions';

    const listenBtn = document.createElement('button');
    listenBtn.type = 'button';
    listenBtn.className = 'speaker-listen-btn';
    listenBtn.innerHTML = '🎧 Original voice clip';
    listenBtn.title = 'Audition this speaker from the original video audio';

    const audioPlayer = document.createElement('audio');
    audioPlayer.className = 'speaker-audio-player';
    audioPlayer.controls = true;
    audioPlayer.hidden = true;

    listenBtn.addEventListener('click', () => {
      listenBtn.disabled = true;
      listenBtn.textContent = 'Loading clip…';
      audioPlayer.src = `/api/dubs/${encodeURIComponent(job.id)}/sample/${sampleSegIndex}.wav`;
      audioPlayer.hidden = false;
      audioPlayer.play().then(() => {
        listenBtn.textContent = '▶ Playing…';
      }).catch((err) => {
        listenBtn.textContent = '🎧 Original voice clip';
        listenBtn.disabled = false;
        alert(`Could not load audio sample: ${err.message}`);
      });
      audioPlayer.onended = () => {
        listenBtn.textContent = '🎧 Original voice clip';
        listenBtn.disabled = false;
      };
      audioPlayer.onerror = () => {
        listenBtn.textContent = '🎧 Original voice clip';
        listenBtn.disabled = false;
      };
    });

    actionRow.appendChild(listenBtn);
    card.appendChild(actionRow);
    card.appendChild(audioPlayer);

    dubSpeakersGrid.appendChild(card);
  }

  // Render segment cards
  dubSegmentsList.innerHTML = '';
  for (const seg of segments) {
    const card = document.createElement('div');
    card.className = 'segment-card';
    card.id = `seg-card-${seg.i}`;

    const durationBudget = Number(seg.durationBudget ?? (Math.round((seg.end - seg.start) * 10) / 10));

    const header = document.createElement('div');
    header.className = 'segment-header';

    const badges = document.createElement('div');
    badges.className = 'segment-header-badges';

    const timing = document.createElement('span');
    timing.className = 'segment-timing';
    timing.textContent = `[${formatSec(seg.start)} - ${formatSec(seg.end)}]`;
    badges.appendChild(timing);

    // Original clip playback button right on the segment header
    const origSampleBtn = document.createElement('button');
    origSampleBtn.type = 'button';
    origSampleBtn.className = 'segment-orig-sample-btn';
    origSampleBtn.innerHTML = '🎧 Original';
    origSampleBtn.title = 'Hear what was spoken in the original video for this line';
    const segOrigAudio = document.createElement('audio');
    segOrigAudio.hidden = true;
    origSampleBtn.addEventListener('click', () => {
      origSampleBtn.textContent = '▶ Playing…';
      segOrigAudio.src = `/api/dubs/${encodeURIComponent(job.id)}/sample/${seg.i}.wav`;
      segOrigAudio.play().catch(() => {
        origSampleBtn.textContent = '🎧 Original';
      });
      segOrigAudio.onended = () => {
        origSampleBtn.textContent = '🎧 Original';
      };
      segOrigAudio.onerror = () => {
        origSampleBtn.textContent = '🎧 Original';
      };
    });
    badges.appendChild(origSampleBtn);

    const budgetBadge = document.createElement('span');
    budgetBadge.className = 'segment-budget-badge';
    budgetBadge.textContent = `⏱️ ${durationBudget.toFixed(1)}s slot`;
    badges.appendChild(budgetBadge);

    const emotionBadge = document.createElement('span');
    emotionBadge.className = 'segment-emotion-badge';
    emotionBadge.textContent = `${emotionIcon(seg.emotion)} ${seg.emotion || 'warm'}`;
    emotionBadge.title = 'Detected scene emotion';
    badges.appendChild(emotionBadge);

    if (seg.pacing && seg.pacing !== 'normal') {
      const pacingBadge = document.createElement('span');
      pacingBadge.className = 'segment-pacing-badge';
      pacingBadge.textContent = `⚡ ${seg.pacing}`;
      badges.appendChild(pacingBadge);
    }

    const spkSelect = document.createElement('select');
    spkSelect.className = 'segment-speaker-select';
    spkSelect.setAttribute('data-seg-speaker', seg.i);
    for (const spk of speakers) {
      const opt = document.createElement('option');
      opt.value = spk;
      const spkMeta = speakersMeta[spk] || {};
      const ageTag = spkMeta.ageGroup ? ` [${spkMeta.ageGroup}]` : '';
      opt.textContent = `${spk.replace('_', ' ').toUpperCase()}${ageTag}`;
      if ((seg.speaker || 'speaker_0') === spk) opt.selected = true;
      spkSelect.appendChild(opt);
    }

    const spkWrap = document.createElement('div');
    spkWrap.style.display = 'inline-flex';
    spkWrap.style.alignItems = 'center';
    spkWrap.style.gap = '6px';

    const segSpkAvatar = document.createElement('img');
    segSpkAvatar.className = 'segment-speaker-avatar';
    segSpkAvatar.alt = seg.speaker || 'speaker_0';
    segSpkAvatar.src = `/api/dubs/${encodeURIComponent(job.id)}/face/${encodeURIComponent(seg.speaker || 'speaker_0')}.jpg`;
    segSpkAvatar.onerror = () => { segSpkAvatar.style.display = 'none'; };

    spkSelect.addEventListener('change', () => {
      segSpkAvatar.src = `/api/dubs/${encodeURIComponent(job.id)}/face/${encodeURIComponent(spkSelect.value)}.jpg`;
      segSpkAvatar.style.display = 'inline-block';
    });

    spkWrap.appendChild(segSpkAvatar);
    spkWrap.appendChild(spkSelect);

    header.appendChild(badges);
    header.appendChild(spkWrap);
    card.appendChild(header);

    const srcDiv = document.createElement('div');
    srcDiv.className = 'segment-src-text';
    srcDiv.textContent = seg.srcText || seg.text;
    card.appendChild(srcDiv);

    const textarea = document.createElement('textarea');
    textarea.className = 'segment-textarea';
    textarea.setAttribute('data-seg-i', seg.i);
    textarea.rows = 2;
    textarea.value = seg.text || '';
    card.appendChild(textarea);

    // Vocal Performance Direction
    const deliveryRow = document.createElement('div');
    deliveryRow.className = 'segment-delivery-row';

    const deliveryLabel = document.createElement('label');
    deliveryLabel.className = 'segment-delivery-label';
    deliveryLabel.textContent = 'Acting Direction:';

    const deliveryInput = document.createElement('input');
    deliveryInput.className = 'segment-delivery-input';
    deliveryInput.setAttribute('data-seg-delivery', seg.i);
    deliveryInput.value = seg.delivery || '';
    deliveryInput.placeholder = 'e.g. enthusiastic and fast, warm and thoughtful, serious...';

    deliveryRow.appendChild(deliveryLabel);
    deliveryRow.appendChild(deliveryInput);
    card.appendChild(deliveryRow);

    const footer = document.createElement('div');
    footer.className = 'segment-footer';

    const auditionBtn = document.createElement('button');
    auditionBtn.type = 'button';
    auditionBtn.className = 'audition-btn';
    auditionBtn.textContent = '🔊 Audition line';

    const feedbackSpan = document.createElement('span');
    feedbackSpan.className = 'audition-feedback';
    feedbackSpan.hidden = true;

    const audioPlayer = document.createElement('audio');
    audioPlayer.className = 'audition-audio';
    audioPlayer.controls = true;
    audioPlayer.hidden = true;

    auditionBtn.addEventListener('click', async () => {
      auditionBtn.disabled = true;
      auditionBtn.textContent = 'Voicing preview…';
      feedbackSpan.hidden = true;
      try {
        const activeVoice = currentReviewJob.speakerVoices?.[spkSelect.value] || currentReviewJob.voice || 'Charon';
        const res = await fetch(`/api/dubs/${encodeURIComponent(job.id)}/preview-line`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            segmentIndex: seg.i,
            text: textarea.value.trim(),
            voice: activeVoice,
            delivery: deliveryInput.value.trim(),
            emotion: seg.emotion || 'warm',
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Audition failed');
        audioPlayer.src = data.url;
        audioPlayer.hidden = false;
        audioPlayer.play().catch(() => {});

        const dur = Number(data.durationSec || 0);
        feedbackSpan.hidden = false;
        if (dur > durationBudget * 1.15) {
          feedbackSpan.className = 'audition-feedback warning';
          feedbackSpan.textContent = `🎙️ ${dur.toFixed(1)}s (slot: ${durationBudget.toFixed(1)}s — tight fit)`;
        } else {
          feedbackSpan.className = 'audition-feedback';
          feedbackSpan.textContent = `🎙️ ${dur.toFixed(1)}s (fits ${durationBudget.toFixed(1)}s slot)`;
        }
      } catch (err) {
        alert(`Audition error: ${err.message}`);
      } finally {
        auditionBtn.disabled = false;
        auditionBtn.textContent = '🔊 Audition line';
      }
    });

    footer.appendChild(auditionBtn);
    footer.appendChild(feedbackSpan);
    footer.appendChild(audioPlayer);
    card.appendChild(footer);

    dubSegmentsList.appendChild(card);
  }
}

dubAddSpeakerBtn?.addEventListener('click', () => {
  if (!currentReviewJob) return;
  const segments = currentReviewJob.segmentsData || [];
  const speakersMeta = currentReviewJob.speakersMeta || {};
  const currentSpeakers = [...new Set([
    ...Object.keys(speakersMeta),
    ...segments.map((s) => s.speaker || 'speaker_0'),
  ])];
  const newSpkId = `speaker_${currentSpeakers.length}`;
  if (!currentReviewJob.speakersMeta) currentReviewJob.speakersMeta = {};
  if (!currentReviewJob.speakerVoices) currentReviewJob.speakerVoices = {};

  const existingVoices = new Set(Object.values(currentReviewJob.speakerVoices));
  const candidate = cachedVoices.find((v) => !existingVoices.has(v.name)) || cachedVoices[0];
  const chosenVoice = candidate?.name || 'Charon';
  const chosenGender = candidate?.gender || 'Male';

  currentReviewJob.speakersMeta[newSpkId] = {
    id: newSpkId,
    gender: chosenGender,
    pitch_hz: chosenGender === 'Female' ? 210 : 130,
    count: 0,
    total_sec: 0,
  };
  currentReviewJob.speakerVoices[newSpkId] = chosenVoice;

  renderReviewStudio(currentReviewJob);
  setDubStatus(`Added ${newSpkId.replace('_', ' ').toUpperCase()} with voice ${chosenVoice}. Assign lines in the list below.`);
});

async function collectAndSaveSegments() {
  if (!currentReviewJob) return;
  const segments = (currentReviewJob.segmentsData || []).map((seg) => {
    const textarea = document.querySelector(`textarea[data-seg-i="${seg.i}"]`);
    const spkSelect = document.querySelector(`select[data-seg-speaker="${seg.i}"]`);
    const deliveryInput = document.querySelector(`input[data-seg-delivery="${seg.i}"]`);
    return {
      ...seg,
      text: textarea ? textarea.value.trim() : seg.text,
      speaker: spkSelect ? spkSelect.value : (seg.speaker || 'speaker_0'),
      delivery: deliveryInput ? deliveryInput.value.trim() : (seg.delivery || ''),
    };
  });

  const response = await fetch(`/api/dubs/${encodeURIComponent(currentReviewJob.id)}/segments`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      segments,
      speakerVoices: currentReviewJob.speakerVoices,
      speakersMeta: currentReviewJob.speakersMeta,
      bgVolume: Number(dubBgVolumeSlider?.value ?? 0.25),
      ducking: dubDuckingCheckbox?.checked ?? true,
    }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to save segments');
  }
  const payload = await response.json();
  currentReviewJob = payload.job;
  setDubStatus('Edits saved successfully.');
}

dubSaveSegmentsBtn?.addEventListener('click', async () => {
  dubSaveSegmentsBtn.disabled = true;
  try {
    await collectAndSaveSegments();
  } catch (err) {
    alert(err.message);
  } finally {
    dubSaveSegmentsBtn.disabled = false;
  }
});

dubSaveSegmentsTopBtn?.addEventListener('click', async () => {
  dubSaveSegmentsTopBtn.disabled = true;
  try {
    await collectAndSaveSegments();
  } catch (err) {
    alert(err.message);
  } finally {
    dubSaveSegmentsTopBtn.disabled = false;
  }
});

async function approveAndRender() {
  if (!currentReviewJob) return;
  setDubStatus('Saving edits and approving for render…');
  await collectAndSaveSegments();

  const response = await fetch(`/api/dubs/${encodeURIComponent(currentReviewJob.id)}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      speakerVoices: currentReviewJob.speakerVoices,
      bgVolume: Number(dubBgVolumeSlider?.value ?? 0.25),
      ducking: dubDuckingCheckbox?.checked ?? true,
    }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to start render');
  }
  setDubStatus('Approved! Voicing character lines and leveling audio…');
  await pollDub(currentReviewJob.id);
}

dubApproveRenderBtn?.addEventListener('click', async () => {
  dubApproveRenderBtn.disabled = true;
  try {
    await approveAndRender();
  } catch (err) {
    alert(err.message);
  } finally {
    dubApproveRenderBtn.disabled = false;
  }
});

dubApproveRenderTopBtn?.addEventListener('click', async () => {
  dubApproveRenderTopBtn.disabled = true;
  try {
    await approveAndRender();
  } catch (err) {
    alert(err.message);
  } finally {
    dubApproveRenderTopBtn.disabled = false;
  }
});

async function pollDub(id) {
  const startedAt = Date.now();
  startDubTimer(startedAt);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const response = await fetch(`/api/dubs/${encodeURIComponent(id)}`);
    if (!response.ok) continue;
    const job = await response.json();
    const detail = job.remote?.detail ? ` — ${job.remote.detail}` : '';
    setDubStatus(`[${elapsedText(startedAt)}] ${job.status}${detail}`);
    if (dubTimerPhase) {
      dubTimerPhase.textContent = `Stage: ${job.status}${detail}`;
    }

    if (job.status === 'review') {
      stopDubTimer('Ready for Review');
      setDubStatus('Transcript ready for review. Inspect and tweak lines below before rendering.');
      renderReviewStudio(job);
      refreshRecentDubs();
      return;
    }

    if (job.status === 'done') {
      stopDubTimer('Completed');
      dubResult.hidden = false;
      if (job.video?.url) {
        dubVideo.src = job.video.url;
        dubDownload.href = job.video.url;
      }
      if (job.audio?.url) dubAudio.href = job.audio.url;
      if (dubSrtLink) dubSrtLink.href = `/api/dubs/${encodeURIComponent(id)}/subtitles.srt`;
      if (dubVttLink) dubVttLink.href = `/api/dubs/${encodeURIComponent(id)}/subtitles.vtt`;
      setDubStatus('Done! Broadcast-grade dubbed video and subtitles ready.');
      refreshRecentDubs();
      return;
    }
    if (job.status === 'failed') {
      stopDubTimer('Failed');
      setDubStatus(`Failed: ${job.error || 'unknown error'}`);
      refreshRecentDubs();
      return;
    }
  }
  stopDubTimer('Timeout');
  setDubStatus('Still working — wait a little and refresh Recent dubs.');
}

async function refreshRecentDubs() {
  try {
    const response = await fetch('/api/dubs');
    const jobs = await response.json();
    recentDubsList.innerHTML = '';
    for (const job of jobs.slice(0, 10)) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = `${job.options?.title || 'Untitled'} — ${job.status}`;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        loadDub(job.id);
      });
      item.appendChild(link);
      recentDubsList.appendChild(item);
    }
    if (!jobs.length) recentDubsList.innerHTML = '<li>No dubs yet.</li>';
  } catch {
    recentDubsList.innerHTML = '<li>Could not load recent dubs.</li>';
  }
}

async function loadDub(id) {
  const response = await fetch(`/api/dubs/${encodeURIComponent(id)}`);
  if (!response.ok) {
    setDubStatus('Could not load that dub.');
    return;
  }
  const job = await response.json();
  if (job.segmentsData && (job.status === 'review' || job.status === 'done')) {
    renderReviewStudio(job);
  }
  if (job.video?.url) {
    dubResult.hidden = false;
    dubVideo.src = job.video.url;
    dubDownload.href = job.video.url;
  }
  if (job.audio?.url) dubAudio.href = job.audio.url;
  if (dubSrtLink) dubSrtLink.href = `/api/dubs/${encodeURIComponent(id)}/subtitles.srt`;
  if (dubVttLink) dubVttLink.href = `/api/dubs/${encodeURIComponent(id)}/subtitles.vtt`;
  setDubStatus(`Status: ${job.status}${job.error ? ` — ${job.error}` : ''}`);
}

dubGenerateButton.addEventListener('click', async () => {
  const youtubeUrl = dubUrlInput.value.trim();
  const directUrl = dubDirectInput.value.trim();
  const file = dubFileInput?.files?.[0];

  if (!youtubeUrl && !directUrl && !file) {
    setDubStatus('Paste a YouTube link, direct video link, or select a video file.');
    return;
  }

  dubGenerateButton.disabled = true;
  setDubStatus('Preparing video…');

  try {
    let localFile;
    if (file) {
      setDubStatus(`Uploading ${file.name}…`);
      const reader = new FileReader();
      const fileDataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const uploadRes = await fetch('/api/dubs/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataUrl: fileDataUrl, filename: file.name }),
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');
      localFile = uploadData.localFile;
    }

    const mode = dubModeSelect?.value || 'review';
    const bgVolume = Number(dubBgVolumeSlider?.value ?? 0.25);
    const ducking = dubDuckingCheckbox?.checked ?? true;

    const response = await fetch('/api/dubs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        youtubeUrl: youtubeUrl || undefined,
        directUrl: directUrl || undefined,
        localFile: localFile || undefined,
        targetLang: dubLangSelect.value,
        voice: dubVoiceSelect.value,
        mode,
        bgVolume,
        ducking,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || 'Could not start the dub.');

    setDubStatus(`Dub ${payload.id} started. Downloading & transcribing speech…`);
    await pollDub(payload.id);
  } catch (error) {
    setDubStatus(`Error: ${error.message}`);
  } finally {
    dubGenerateButton.disabled = false;
  }
});

writeScriptButton.addEventListener('click', async () => {
  const prompt = promptInput.value.trim();
  if (prompt.length < 8) {
    setStatus('Tell the AI what the presenter should talk about.');
    return;
  }
  writeScriptButton.disabled = true;
  setStatus('Writing your script…');
  try {
    const response = await fetch('/api/presenters/write-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, durationSec: Number(lengthSelect.value) }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || 'Could not write the script.');
    scriptInput.value = payload.script;
    if (payload.title && !titleInput.value.trim()) titleInput.value = payload.title;
    setStatus('Script ready. Read it, tweak anything, then press Generate.');
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    writeScriptButton.disabled = false;
  }
});

generateButton.addEventListener('click', async () => {
  if (!photoDataUrl) {
    setStatus('Upload a presenter photo first.');
    return;
  }
  const script = scriptInput.value.trim();
  if (script.length < 10) {
    setStatus('Write at least a sentence for the presenter to say.');
    return;
  }
  generateButton.disabled = true;
  setStatus('Starting… voice first, then video.');
  try {
    const response = await fetch('/api/presenters', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        script,
        voice: voiceSelect.value,
        quality: qualitySelect.value,
        title: titleInput.value.trim(),
        photoDataUrl,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || 'Could not start the presenter.');
    setStatus(`Job ${payload.id} started (${payload.status}). Voice first, then video…`);
    refreshRecent();
    await pollJob(payload.id);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    generateButton.disabled = false;
  }
});

refreshHealth();
refreshRecent();
refreshRecentDubs();
loadVoices();
loadDubLangs();
loadCookiesStatus();

async function loadCookiesStatus() {
  const cookieStatusText = document.getElementById('cookieStatusText');
  const cookieAutoBtn = document.getElementById('cookieAutoBtn');
  const cookieFileInput = document.getElementById('cookieFileInput');
  if (!cookieStatusText) return;

  try {
    const res = await fetch('/api/cookies');
    const data = await res.json();
    if (data.configured) {
      cookieStatusText.textContent = `🍪 Cookies Connected (${data.source} • ${data.size} B)`;
      cookieStatusText.className = 'cookie-status-indicator ready';
    } else {
      cookieStatusText.textContent = '🍪 No YouTube Cookies (Auto-extract available)';
      cookieStatusText.className = 'cookie-status-indicator';
    }
  } catch {
    cookieStatusText.textContent = '🍪 Cookies Ready';
  }

  if (cookieAutoBtn && !cookieAutoBtn.dataset.wired) {
    cookieAutoBtn.dataset.wired = 'true';
    cookieAutoBtn.addEventListener('click', async () => {
      cookieStatusText.textContent = '🍪 Extracting from local browser…';
      cookieStatusText.className = 'cookie-status-indicator';
      try {
        const res = await fetch('/api/cookies/auto-detect', { method: 'POST' });
        const result = await res.json();
        if (result.success) {
          cookieStatusText.textContent = `🍪 Connected to ${result.source}!`;
          cookieStatusText.className = 'cookie-status-indicator ready';
        } else {
          cookieStatusText.textContent = `⚠️ Extraction failed: ${result.error || 'Check browser'}`;
          cookieStatusText.className = 'cookie-status-indicator error';
        }
      } catch (err) {
        cookieStatusText.textContent = `⚠️ Error: ${err.message}`;
        cookieStatusText.className = 'cookie-status-indicator error';
      }
    });
  }

  if (cookieFileInput && !cookieFileInput.dataset.wired) {
    cookieFileInput.dataset.wired = 'true';
    cookieFileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      cookieStatusText.textContent = '🍪 Uploading cookies.txt…';
      try {
        const text = await file.text();
        const res = await fetch('/api/cookies/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookiesText: text }),
        });
        const result = await res.json();
        if (result.success) {
          cookieStatusText.textContent = `🍪 cookies.txt uploaded (${result.size} B)`;
          cookieStatusText.className = 'cookie-status-indicator ready';
        } else {
          cookieStatusText.textContent = `⚠️ Upload failed: ${result.error || 'Invalid file'}`;
          cookieStatusText.className = 'cookie-status-indicator error';
        }
      } catch (err) {
        cookieStatusText.textContent = `⚠️ Error: ${err.message}`;
        cookieStatusText.className = 'cookie-status-indicator error';
      }
    });
  }
}
