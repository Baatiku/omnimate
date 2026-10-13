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

## Acoustic Speaker Diarization & Gender-Balanced Voice Mapping

Previous naive dubbers alternated turns between two fixed dummy labels (`speaker_0` and `speaker_1`), causing videos with 3 or 4+ speakers to collapse into two, while defaulting every speaker to a female voice.

Omnimate features an acoustic speaker diarization engine:
1. **Frame-Level Pitch ($F_0$) Autocorrelation**: Analyzes voiced frames across 70 Hz to 380 Hz with normalized autocorrelation to measure median fundamental vocal pitch ($F_0$).
2. **Spectral Timbre Filterbanks**: Extracts 16-band normalized log mel filterbank energies spanning 150 Hz to 7500 Hz to fingerprint vocal tract characteristics and formant resonance.
3. **Dynamic Agglomerative Clustering**: Uses Ward-linkage clustering and silhouette evaluation to automatically discover the true number of speakers ($k \ge 1$, up to 6+), grouping all dialogue turns by distinct speaker identities.
4. **Gender Presentation & Auto Voice Balancing**:
   - Analyzes aggregate median pitch per cluster ($F_0 \ge 165.0$ Hz $\rightarrow$ Female; $< 165.0$ Hz $\rightarrow$ Male).
   - Automatically distributes distinct, non-colliding voices from the 30 new Google voice catalog (9 Female, 21 Male). A 4-speaker video with 3 males and 1 female automatically receives distinct male voices for the 3 men and a distinct female voice for the woman.
5. **Original Audio Sample Extraction**: Automatically locates the cleanest, longest utterance for each speaker. The Review Studio streams audio slices (`GET /api/dubs/:id/sample/:index.wav`) allowing the user to audition the real speaker's voice from the video clip with one click.
6. **Dynamic Speaker Creation & Segment Reassignment**: Users can click **+ Add Speaker** at any time and reassign segments across speakers in real time.

---

## Two-Stage Workflow

### Stage 1: Ingest, Transcribe & Translate (`review` mode)
1. Provide a YouTube link, direct video URL, or upload a local `.mp4` file.
2. Select target language (pre-selected to **Hausa (Default)**) and default voice persona.
3. Configure Background Music & Ambient (M&E) volume slider (default: 25%) and Sidechain Ducking toggle.
4. Click **Start Dubbing**.
5. Live dubbing timer displays elapsed time and real-time processing stage.
6. Modal worker downloads/ingests the video, separates background audio bed, and transcribes speech using Whisper with millisecond timestamps and acoustic speaker identification.
7. Node.js translates segments using structured Gemini calls in chunks of 35 lines with emotion detection and speaking-duration budgets.
8. Job enters `review` status and displays the **Interactive Review Studio**.

### Stage 2: Human-in-the-Loop Review Studio
* **Multi-Speaker Voice Assignment**: Visual speaker cards with estimated pitch badges (`♂ Male (~124 Hz)`, `♀ Female (~215 Hz)`), line counts, and total speaking time.
* **Original Voice Auditioning**: Click **🎧 Original voice clip** on any speaker card to hear what that speaker sounded like in the original video.
* **+ Add Speaker**: Add new speakers dynamically with automatic distinct voice allocation.
* **Segment Timeline List**: Each card includes **🎧 Original** to hear the exact speech slice from the video, an editable acting direction, inline translation editing, and **🔊 Audition line** to preview the translated voice in Hausa.
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
