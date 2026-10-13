# Omnimate Dubbing Studio (Broadcast-Grade Translation & Voiceover)

Omnimate Dubbing is a professional video localization studio. Paste a YouTube video link, a direct MP4 link, or upload a video file. The studio extracts dialogue, transcribes with millisecond-accurate timestamps and speaker turns, isolates background music and sound effects, translates into natural spoken Hausa, Yoruba, or Igbo, levels character dialogue volume, and allows full human-in-the-loop review before final rendering.

---

## What Solves the Loudness & Character Consistency Issue

In previous builds, characters sounded louder in some scenes and calmer in others due to two core factors:
1. **Uncalibrated Segment PCM Levels**: Gemini Live outputs vary in vocal projection, gain, and microphone distance from turn to turn.
2. **FFmpeg `amix` Scaling Artifacts**: Using `amix=inputs=N` caused FFmpeg to dynamically re-scale and attenuate volume whenever audio segments started or stopped across silence boundaries.

### The Fix
* **Input RMS Normalization (`normalizePcm16`)**: Every synthesized speech slice is analyzed for Root Mean Square (RMS) level and clamped to a uniform target (-18 dBFS RMS) with a soft-knee peak limiter prior to WAV creation.
* **Master PCM Timeline Placement**: Segments are placed on a master PCM buffer at their exact millisecond marks using `numpy`, eliminating FFmpeg `amix` input attenuation.
* **Broadcast Mastering Bus**: The merged dialogue track passes through `dynaudnorm` (Dynamic Audio Normalizer with 250ms frame window) followed by `loudnorm` (EBU R128 standard targeting -16 LUFS, true-peak -1.5 dBFS), ensuring uniform speaking projection across all scenes.
* **Stem Separation & Sidechain Ducking**: Background music and ambient effects (M&E) are extracted and preserved. FFmpeg's `sidechaincompress` smoothly ducks the background bed by -12dB to -14dB during speech and smoothly restores it during pauses.

---

## Gemini Live Native-Audio API & Voice-Directed Acting

Omnimate bypasses legacy Cloud Text-to-Speech (TTS) engines entirely in favor of the **Gemini Multimodal Live Native-Audio API** (`ai.live.connect` over bi-directional streaming WebSockets using `@google/genai`):
1. **Gemini Live Native Audio vs Legacy TTS**:
   - Older Cloud TTS engines rely on rigid concatenative or basic neural diphone models with synthetic cadence and unnatural accents for African tonal languages.
   - The Gemini Live API synthesizes speech directly within end-to-end multimodal neural weights, returning pristine 24kHz 16-bit uncompressed PCM audio with authentic emotional nuance, breathing dynamics, and natural inflection.
2. **30 Official Google Gemini HD Voices**:
   - Powered by the full official catalog of 30 astronomical studio voices (15 Male, 15 Female, e.g. `Charon`, `Puck`, `Aoede`, `Kore`, `Zephyr`, `Orus`).
3. **Session-Level `systemInstruction` Steering (`buildLiveSystemInstruction`)**:
   - Each Gemini Live session is initialized with targeted system instructions configuring the model as an elite Northern Nigerian (Kano/Kaduna standard) broadcast voice actor.
   - Enforces authentic tonal inflections, proper vowel duration (*wasula*), and natural pronunciation of glottalized consonants (ƙ, ɗ, ɓ, 'y).
   - Enforces strict script isolation (`<SCRIPT>...</SCRIPT>`), preventing conversational chit-chat or unwanted introductory comments.
4. **Scene Emotion Detection & Performance Direction**:
   - Gemini analyzes the context of each dialogue line to detect emotional state (`enthusiastic`, `serious`, `humorous`, `warm`, `urgent`, `curious`, `somber`).
   - Every segment receives customized delivery guidance (e.g. `"enthusiastic and quick tempo"`, `"soft and warm"`, `"firm and authoritative"`) sent in the user turn.
5. **Speaking Duration Budgeting**:
   - Each segment tracks its exact duration limit (`sec`). The model rephrases translated dialogue to fit comfortably in the speaking slot without rushing.
6. **Target Languages (Hausa Default)**:
   - Hausa (`ha`) is the strict default target language across validation, schema generation, and the UI. Yoruba (`yo`), Igbo (`ig`), Swahili (`sw`), French (`fr`), Arabic (`ar`), and Spanish (`es`) are also fully supported.

---

## Visual Demographic Scanning & Human-Verified Face Detection

To solve the audio-only blindspot where children and adult women share high fundamental pitch ($F_0 \sim 220\text{--}300$ Hz) and young adults cannot be differentiated from elders, Omnimate pairs acoustic diarization with multimodal visual biometric scanning:
1. **Human Face Verification & Keyframe Extraction (`extract_speaker_keyframe`)**:
   - The Modal worker samples multiple candidate timestamps across the speaker's top speech turns.
   - Evaluates each candidate frame with OpenCV's human frontal face Haar cascade (`haarcascade_frontalface_default.xml`).
   - If a human face is detected, it selects that frame and marks `has_human_face: true`.
   - If no human face is found across all candidates (e.g., in nature/wildlife documentaries where animals or landscapes are on screen while a narrator speaks off-camera), it marks `has_human_face: false`.
2. **Zero-API-Call Rate Optimization (5 RPM Budget)**:
   - If `has_human_face: false`, Omnimate **bypasses the Gemini vision API call entirely**, saving valuable API quota and preventing animal photos from ever being misidentified as human speakers.
   - The speaker is immediately classified as an **Off-screen Narrator**, using acoustic pitch ($F_0$) to cast the voice with zero wasted Gemini API calls.
3. **Biological Human Filter in Gemini (`analyzeSpeakerVisualDemographics`)**:
   - For confirmed candidate frames, Gemini analyzes the image with strict biological human filtering (`isHuman: boolean`, `subjectCategory: 'human' | 'animal' | 'scenery' | 'object'`).
   - If an animal is present, Gemini sets `isHuman: false` and `faceDetected: false`.
   - For human subjects, extracts gender, age bracket (`Child`, `Teen`, `Young Adult`, `Adult`, `Senior`), estimated numerical age, expression, and tailored vocal acting performance prompt.
4. **Official 30 Google Gemini Prebuilt Voices (Astronomical Studio Catalog)**:
   - **Female Voices (15)**:
     - Youth / Child: `Zephyr`, `Autonoe`, `Leda`
     - Young Adult: `Aoede`, `Callirrhoe`, `Laomedeia`, `Despina`, `Erinome`
     - Adult / Broadcaster: `Kore`, `Aoede`, `Pulcherrima`, `Sulafat`, `Erinome`, `Rasalgethi`
     - Senior / Matriarch: `Gacrux`, `Vindemiatrix`, `Achernar`, `Kore`
   - **Male Voices (15)**:
     - Youth / Child: `Puck`, `Fenrir`, `Umbriel`
     - Young Adult: `Puck`, `Achird`, `Zubenelgenubi`, `Iapetus`, `Sadachbia`
     - Adult / Anchor: `Charon`, `Orus`, `Algieba`, `Alnilam`, `Schedar`, `Sadaltager`
     - Senior / Seasoned: `Algenib`, `Sadaltager`, `Charon`, `Alnilam`

> [!NOTE]
> **Why Unofficial Names Like "Bodi" Defaulted to Female Audio**:
> In Google Gemini Multimodal Live and TTS APIs, only the official astronomical voice identifiers (`Charon`, `Puck`, `Aoede`, `Kore`, etc.) are recognized. When an unlisted identifier like "Bodi" or "Fola" was sent, Gemini silently fell back to its default system voice (`Aoede`/`Kore`), which is female. Omnimate now exclusively uses Google's verified 30 prebuilt voices.

---

## Native Hausa Cultural & Idiomatic Transcreation (No Word-for-Word Calques)

English and Hausa have fundamentally different grammatical structures, aspectual dynamics, and idiomatic expressions. Word-for-word translation creates awkward, unnatural calques that sound broken to native Hausa listeners. Omnimate enforces **Native Hausa Cultural Transcreation**:
1. **Strict Calque Prohibition**:
   - Re-authors English dialogue into natural, fluent living Hausa (*Fassara mai 'yanci kuma karbabbiya a al'adance da harshen Hausa*).
   - Calque replacements:
     - *"It makes sense"* $\rightarrow$ Never *"yana yin azanci"*; uses *"wannan abu ne mai ma'ana"* or *"haka maganar take"*.
     - *"Take a look at this"* $\rightarrow$ Never *"dauki duba"*; uses *"kalli wannan"* or *"ka lura da wannan"*.
     - *"How are you doing today?"* $\rightarrow$ Never *"yaya kake yi yau"*; uses *"ina kwana"*, *"yaya lafiya"*, or *"barkanmu da yau"*.
     - *"At the end of the day"* $\rightarrow$ Never *"a karshen rana"*; uses *"daga karshe dai"* or *"ko ta yaya ma dai"*.
     - *"Don't get me wrong"* $\rightarrow$ Never *"kada ka fahimce ni ba daidai ba"*; uses *"kada ka dauka cewa..."*.
2. **Production Focus & Genre Adaptation (`analyzeVideoContext`)**:
   - **Documentary (Fim mai ilmantarwa / Tarihi)**: BBC Hausa / National Geographic storytelling style. Rich descriptive vocabulary, narrative gravitas, and steady contemplative cadence.
   - **News Broadcast (Labaran Duniya da Rahotanni)**: BBC / VOA Hausa journalistic standard. Formal grammatical Hausa (*Hausar Boko da ta Labarai*), dignified, articulate delivery without casual slang.
   - **Movies & Drama (Fina-finan Hausa da Wasan Kwaikwayo)**: Everyday living spoken Hausa (Kannywood / Kano dialect). Authentic emotional reactions (*Kai!*, *Haba dai!*, *Ashe!*, *To fa!*, *Ikon Allah!*), natural banter, and realistic conversational cadence.
   - **Podcasts & Interviews (Tattaunawa da Hira)**: Warm, interactive, conversational bridges (*"Kamar yadda kuka sani"*, *"To kaga"*, *"Idan muka duba"*).
   - **Educational & Tutorials (Koyarwa da Bayani)**: Intuitive native Hausa analogies that demystify technical terms.
3. **Aspectual Grammar & Gender Inflection**:
   - Enforces strict grammatical gender markers (*ya/ta*, *kai/ke*, *ka/ki*, *shi/ita*) and natural aspect markers (*yana/tana*, *ya/ta*, *zai/za ta*).
4. **Time Slot Duration Budgeting**:
   - Intelligently streamlines sentences so the translated lines fit comfortably within the segment's exact second duration (`sec`) without forcing the AI voice actor to rush.

---

## Acoustic Speaker Diarization & Gender-Balanced Voice Mapping

Omnimate features an acoustic speaker diarization engine:
1. **Frame-Level Pitch ($F_0$) Autocorrelation**: Analyzes voiced frames across 70 Hz to 380 Hz with normalized autocorrelation to measure median fundamental vocal pitch ($F_0$).
2. **Spectral Timbre Filterbanks**: Extracts 16-band normalized log mel filterbank energies spanning 150 Hz to 7500 Hz to fingerprint vocal tract characteristics and formant resonance.
3. **Dynamic Agglomerative Clustering**: Uses Ward-linkage clustering and silhouette evaluation to automatically discover the true number of speakers ($k \ge 1$, up to 6+), grouping all dialogue turns by distinct speaker identities.
4. **Gender Presentation & Auto Voice Balancing**:
   - Analyzes aggregate median pitch per cluster ($F_0 \ge 165.0$ Hz $\rightarrow$ Female; $< 165.0$ Hz $\rightarrow$ Male) reinforced by facial vision.
   - Automatically distributes distinct, non-colliding voices from the 30 official Google voice catalog (15 Female, 15 Male).
5. **Original Audio Sample Extraction**: Automatically locates the cleanest, longest utterance for each speaker. The Review Studio streams audio slices (`GET /api/dubs/:id/sample/:index.wav`) allowing the user to audition the real speaker's voice from the video clip with one click.
6. **Dynamic Speaker Creation & Segment Reassignment**: Users can click **+ Add Speaker** at any time and reassign segments across speakers in real time.

---

## Two-Stage Workflow

### Stage 1: Ingest, Transcribe, Scan Faces & Translate (`review` mode)
1. Provide a YouTube link, direct video URL, or upload a local `.mp4` file.
2. Select target language (pre-selected to **Hausa (Default)**) and default voice persona.
3. Configure Background Music & Ambient (M&E) volume slider (default: 25%) and Sidechain Ducking toggle.
4. Click **Start Dubbing**.
5. Live dubbing timer displays elapsed time and real-time processing stage.
6. Modal worker downloads/ingests the video, separates background audio bed, and transcribes speech using Whisper with millisecond timestamps and acoustic speaker identification.
7. Engine extracts speaker scene keyframes, runs multimodal biometric demographic analysis, assigns age-fitting Google voices, and generates vocal acting performance prompts.
8. Node.js translates segments using structured Gemini calls in chunks of 35 lines with character age awareness, emotion detection, and speaking-duration budgets.
9. Job enters `review` status and displays the **Interactive Review Studio**.

### Stage 2: Human-in-the-Loop Review Studio
* **Multi-Speaker Avatar Cards**: Circular face thumbnails, demographic badges (`👶 Child (~8 yrs)`, `🧑 Teen`, `👨 Adult`, `🧓 Senior`), facial mood, line counts, and speaking duration.
* **Editable Vocal Acting Prompt**: Inspect and refine the AI voice direction (e.g. child cadence or elder gravity) before final synthesis.
* **Original Voice Auditioning**: Click **🎧 Original voice clip** on any speaker card to hear what that speaker sounded like in the original video.
* **+ Add Speaker**: Add new speakers dynamically with automatic distinct voice allocation.
* **Segment Timeline List**: Each card displays the speaker's avatar, **🎧 Original** to hear the exact speech slice, editable acting direction, inline translation editing, and **🔊 Audition line** to preview the translated voice in Hausa.
* **Save Edits**: Persist custom text, acting directions, and speaker mappings to disk and regenerate `.srt` and `.vtt` subtitles on the fly.
* **Approve & Render**: Synthesizes all unvoiced lines in voice-consistent sessions, levels master audio (-16 LUFS), sidechain-ducks background audio (-14dB), muxes onto video without re-encoding video picture (`-c:v copy`), and exports the finalized broadcast file.

---

## API Endpoints

### Video Ingest & Management
* `POST /api/dubs/upload`: Upload raw video file or base64 data URL.
* `POST /api/dubs`: Create dub job (`mode: 'review'` or `'auto'`).
* `GET /api/dubs`: List recent dub jobs.
* `GET /api/dubs/:id`: Fetch job status, audio/video links, and segment transcript data.

### Studio Review & Auditioning
* `PATCH /api/dubs/:id/segments`: Update edited segments, speaker tags, and audio balance settings.
* `GET /api/dubs/:id/face/:speakerId.jpg`: Stream speaker face keyframe image with local caching.
* `GET /api/dubs/:id/sample/:index.wav`: Stream original audio slice from the source video.
* `POST /api/dubs/:id/preview-line`: Synthesize single line for auditioning.
* `GET /api/dubs/:id/preview/:index.wav`: Stream auditioned audio slice.
* `POST /api/dubs/:id/render`: Trigger final audio mastering, ducking, and video assembly.

### Cookies & YouTube Ingest API
* `GET /api/cookies`: Status of configured cookies (source, file size, connection state).
* `POST /api/cookies/auto-detect`: Auto-extract session cookies from local browsers (Firefox, Edge, Chrome).
* `POST /api/cookies/extract`: Extract from a designated browser (`{ browser: 'firefox' }`).
* `POST /api/cookies/upload`: Upload Netscape-format `cookies.txt` file content.
* `DELETE /api/cookies`: Clear stored cookies.

### Export & Subtitles
* `GET /api/dubs/:id/video.mp4`: Download finalized video (`dubbed.mp4`).
* `GET /api/dubs/:id/audio.wav`: Download finalized voiceover track (`voiceover.wav`).
* `GET /api/dubs/:id/subtitles.srt`: Download timed SubRip subtitle file.
* `GET /api/dubs/:id/subtitles.vtt`: Download timed WebVTT subtitle file.

---

## YouTube Bot-Check Protection & Cookie Architecture

Cloud datacenter IPs (Modal, AWS, GCP) frequently face YouTube bot challenges (`HTTP Error 403: Forbidden / Sign in to confirm you’re not a bot`). Omnimate employs a multi-tiered architecture:
1. **Netscape Cookie Store (`lib/cookies.js`)**: Materializes stored cookies into `.omnimate/cookies.txt` and forwards them in the multipart payload to Modal.
2. **Local Browser Auto-Extraction**: Automatically extracts YouTube session cookies from local browsers (Firefox, Edge, Chrome) without requiring manual terminal commands.
3. **Residential Auto-Heal Fallback (`lib/youtube-downloader.js`)**: If cloud datacenter IP download is blocked by YouTube, Omnimate automatically catches the error, downloads the video using the user's residential IP and local `yt-dlp` session, and uploads the source MP4 directly to Modal. This completely bypasses datacenter blocks with 100% reliability.

---

## Deploying Worker

```bash
python -X utf8 -m modal deploy modal/dub.py
```

Set the printed URL in `.env` as `MODAL_DUB_URL` and restart the server:

```powershell
npm start
```

