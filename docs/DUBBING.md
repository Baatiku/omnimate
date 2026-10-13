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

## Emotion, Tone & Pacing-Aware Translation Engine

Google Gemini advanced models and Gemini Live TTS are combined into a voice-directed translation pipeline:
1. **Scene Emotion Detection**: When translating dialogue chunks, Gemini acts as a master voice director, analyzing the context to detect the genuine emotion of each line (e.g. `enthusiastic`, `serious`, `humorous`, `warm`, `urgent`, `curious`, `somber`).
2. **Vocal Performance Direction**: Every segment generates customized delivery guidance (e.g., `"enthusiastic and quick tempo"`, `"soft, warm, and thoughtful"`, `"firm and authoritative"`) fed directly to Gemini Live TTS turns to ensure natural prosody, pitch modulation, and human expression.
3. **Speaking Duration Budgeting**: Each segment includes its exact timestamp duration (`sec`). The model rephrases and adapts the translated dialogue so it fits comfortably within the speaking slot without feeling rushed.
4. **Target Languages (Hausa Default)**: Hausa (`ha`) is the strict default target language across validation, schema generation, and the UI. Yoruba (`yo`), Igbo (`ig`), Swahili (`sw`), French (`fr`), Arabic (`ar`), and Spanish (`es`) are also fully supported.

---

## Visual Demographic Scanning & Age-Appropriate Voice Casting

To solve the audio-only blindspot where children and adult women share high fundamental pitch ($F_0 \sim 220\text{--}300$ Hz) and young adults cannot be differentiated from elders, Omnimate pairs acoustic diarization with multimodal visual biometric scanning:
1. **Scene Keyframe Extraction**: The Modal worker isolates the midpoint timestamp of each speaker's longest clean speech turn and extracts a scene frame using FFmpeg (`frame_{spk_id}.jpg`).
2. **Visual Demographic Analysis (`analyzeSpeakerVisualDemographics`)**: Powered by Google Gemini multimodal intelligence, each speaker's frame is analyzed for:
   - **Facial Presence**: Detects whether a speaking person or face is in frame, with graceful fallback for off-camera narrators.
   - **Gender Presentation**: `Female`, `Male`, or `Unknown`.
   - **Age Group**: `Child` (3–12 yrs), `Teen` (13–19 yrs), `Young Adult` (20–35 yrs), `Adult` (36–55 yrs), or `Senior` (56+ yrs).
   - **Estimated Numerical Age**: e.g. `6-8`, `28`, `65+`.
   - **Facial Expression / Mood**: e.g. `smiling and playful`, `serious and focused`, `laughing`.
   - **Vocal Acting Performance Prompt**: Formulates precise voice-age performance instructions for Gemini Live TTS (e.g. for a child: *"Young child voice (approx 7-8 years old), bright energetic tone, playful inflection, natural lively cadence"*).
3. **Demographic Voice Tiers (30 Modern Google Voices)**:
   - **Female Youth / Kid**: `Lumi`, `Nika`, `Cleo`
   - **Female Young Adult**: `Fola`, `Sola`, `Hali`
   - **Female Senior / Mature**: `Enya`, `Tova`, `Kira`
   - **Male Youth / Kid**: `Finn`, `Arlo`, `Jett`, `Tavi`
   - **Male Young Adult**: `Bodi`, `Koda`, `Brio`, `Ludo`, `Mako`, `Jori`, `Rami`, `Enzo`, `Riko`
   - **Male Senior / Mature**: `Daro`, `Sami`, `Gero`, `Neno`, `Olin`, `Knox`, `Cruz`, `Elio`
4. **Tone & Age-Informed Hausa Translation**: Translation prompts receive each character's age, gender, and expression, ensuring vocabulary and honorifics in Hausa sound culturally authentic to the character's age.

---

## Acoustic Speaker Diarization & Gender-Balanced Voice Mapping

Omnimate features an acoustic speaker diarization engine:
1. **Frame-Level Pitch ($F_0$) Autocorrelation**: Analyzes voiced frames across 70 Hz to 380 Hz with normalized autocorrelation to measure median fundamental vocal pitch ($F_0$).
2. **Spectral Timbre Filterbanks**: Extracts 16-band normalized log mel filterbank energies spanning 150 Hz to 7500 Hz to fingerprint vocal tract characteristics and formant resonance.
3. **Dynamic Agglomerative Clustering**: Uses Ward-linkage clustering and silhouette evaluation to automatically discover the true number of speakers ($k \ge 1$, up to 6+), grouping all dialogue turns by distinct speaker identities.
4. **Gender Presentation & Auto Voice Balancing**:
   - Analyzes aggregate median pitch per cluster ($F_0 \ge 165.0$ Hz $\rightarrow$ Female; $< 165.0$ Hz $\rightarrow$ Male) reinforced by facial vision.
   - Automatically distributes distinct, non-colliding voices from the 30 new Google voice catalog (9 Female, 21 Male).
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

### Export & Subtitles
* `GET /api/dubs/:id/video.mp4`: Download finalized video (`dubbed.mp4`).
* `GET /api/dubs/:id/audio.wav`: Download finalized voiceover track (`voiceover.wav`).
* `GET /api/dubs/:id/subtitles.srt`: Download timed SubRip subtitle file.
* `GET /api/dubs/:id/subtitles.vtt`: Download timed WebVTT subtitle file.

---

## Deploying Worker

```bash
python -m modal deploy modal/dub.py
```

Set the printed URL in `.env` as `MODAL_DUB_URL` and restart the server:

```powershell
npm start
```
