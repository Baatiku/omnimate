# Omnimate

Omnimate is a local-first AI animation studio that turns one creative brief into a directed, voiced, procedural 2D film. Gemini handles the creative intelligence and voice performance; Omnimate turns the resulting production plan into repeatable animation using a constrained acting/camera grammar.

## Quota-safe studio architecture

Omnimate is designed to work with a Gemini project limited to **5 requests per minute** without rotating keys or firing parallel Gemini calls.

**Studio mode uses five normal Gemini request starts:**

1. **Creative Council** — Executive Producer + Research Editor + Story Architect collaborate inside one structured call.
2. **Writing Room** — Screenwriter produces the locked narration and scene beats.
3. **Direction Council** — Art Director + Animation Director + Performance/Camera Director + Continuity Critic collaborate inside one structured call.
4. **Showrunner** — compiles the approved material into the canonical renderable production plan.
5. **Gemini Live Voice Actor** — performs the locked narration.

**Draft mode uses three:** combined Creative + Writing Room, Showrunner, then Gemini Live Voice Actor.

Every Gemini operation shares one process-wide governor, including concurrent productions and voice regeneration. With the default 5 RPM setting, starts are separated by **13 seconds**: 12 seconds for the nominal rate plus a 1 second safety margin. 429 / RESOURCE_EXHAUSTED responses are retried through the same paced queue with bounded backoff.

The active department shows when it is waiting for quota capacity. Each project persists Gemini request/retry accounting.

## What is in the studio build

- Multiple logical specialist departments while related roles collaborate inside quota-efficient council calls.
- Google Search grounding during the Creative Council / Draft foundation pass.
- Structured Gemini production plans instead of fragile free-form prompts.
- A constrained 2D animation grammar for acting, expressions, gaze, camera, props and effects.
- Gemini Live native audio narration saved locally as 24 kHz WAV.
- Automatic shot-timeline conformance to the actual generated narration duration.
- Local persistent project history under `.omnimate/projects/`.
- Professional browser studio with progress, screenplay, department notes, shot list, preview playback and scrubbing.
- Procedural vector characters with acting poses, expressions, blinking, mouth motion, entrances/exits, simple set generation, camera motion and graphic effects.
- Real-time browser WebM recording with narration mixed into the export.
- Duplicate active production requests are deduplicated, and duplicate voice-regeneration calls are rejected.
- The Gemini API key never reaches the browser.

## Local setup

Requirements: **Node.js 22 or newer** and a Gemini API key.

```bash
npm install
```

Copy `.env.example` to `.env` and add your key:

```env
GEMINI_API_KEY=your_key_here
OMNIMATE_GEMINI_RPM=5
OMNIMATE_GEMINI_RATE_SAFETY_MS=1000
OMNIMATE_GEMINI_MAX_RETRIES=3
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
npm test
npm run check
npm start
```

Then open:

```text
http://127.0.0.1:8787
```

## Recommended first test

Use a 30-second production before trying 60–120 seconds:

> Create a visually surprising 30-second explainer showing why the sky looks blue. Use one curious teenager and one playful light-ray character. Start with a strange visual question, make the science accurate, keep text minimal, and end with a memorable visual payoff.

Choose **Studio** quality and **16:9**. With a 5 RPM key, pauses between departments are intentional quota protection.

## Gemini integration

The structured creative passes use the Gemini Interactions API with JSON Schema. The voice pass uses the Gemini Live API with native AUDIO output and output transcription.

```env
OMNIMATE_TEXT_MODEL=gemini-3.8-flash
OMNIMATE_LIVE_MODEL=gemini-3.8-live
```

## Export and MP4

The built-in exporter records WebM directly in current Chrome/Edge. If you want MP4 and have FFmpeg installed:

```bash
ffmpeg -i omnimate-film.webm -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k omnimate-film.mp4
```

## Project layout

```text
server.js                 Local HTTP API and studio server
lib/gemini.js             Gemini structured + Live audio integration
lib/rate-limit.js         Global RPM pacing, queueing and 429 retry governor
lib/orchestrator.js       Bundled multi-department creative pipeline
lib/schema.js             Structured studio + renderable production schemas
lib/compiler.js           Defensive normalization + audio timing conform
lib/storage.js            Atomic local production persistence
lib/audio.js              PCM -> WAV utilities
public/                    Studio UI + procedural renderer
tests/                     Compiler, audio, server and quota-governor tests
docs/                      Architecture and creative pipeline design
```

## Product philosophy

The target is not "AI makes a video." It is **AI runs a studio**. Specialists still have distinct responsibilities and outputs, but related departments deliberate inside a shared model call when that improves coherence and keeps Omnimate inside real API quotas.
