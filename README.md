# Omnimate

Omnimate is a local-first AI animation studio that turns one creative brief into a directed, voiced, procedural 2D film. It is deliberately **not** a frame-by-frame generative-video wrapper. Gemini handles the creative intelligence and voice performance; Omnimate turns the resulting production plan into repeatable animation using a constrained acting/camera grammar.

## What is in the first studio build

- One-click **Studio mode** with multiple specialist AI departments: Executive Producer, Research Editor, Story Architect, Screenwriter, Art Director, Animation Director, Performance & Camera Director, Continuity Critic, Showrunner, and Gemini Live Voice Actor.
- Google Search grounding for the Research Editor in Studio mode.
- Structured Gemini production plans instead of fragile free-form prompts.
- A constrained 2D animation grammar (blocking, actions, expressions, gaze, camera, props, visual effects).
- Gemini Live native audio narration, saved locally as 24 kHz WAV.
- Automatic shot-timeline conformance to the *actual* generated audio duration.
- Local persistent project history under `.omnimate/projects/`.
- Professional browser studio with progress, screenplay, department notes, shot list, preview playback and scrubbing.
- Procedural vector characters with acting poses, expressions, blinking, mouth motion, entrances/exits, simple set generation, camera motion and graphic effects.
- Real-time browser WebM recording with the Gemini narration mixed into the export.
- No Gemini API key is ever sent to the browser.

## Local setup (Windows / macOS / Linux)

Requirements: **Node.js 22 or newer** and a Gemini API key.

```bash
npm install
```

Copy `.env.example` to `.env` and add your key:

```env
GEMINI_API_KEY=your_key_here
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
npm start
```

Then open:

```text
http://127.0.0.1:8787
```

Run the deterministic tests with:

```bash
npm test
```

Run the environment check with:

```bash
npm run check
```

## Recommended first test

Use a 30-second production before trying 60–120 seconds:

> Create a visually surprising 30-second explainer showing why the sky looks blue. Use one curious teenager and one playful light-ray character. Start with a strange visual question, make the science accurate, keep text minimal, and end with a memorable visual payoff.

Choose **Studio** quality and **16:9**. When the pipeline finishes, play the result and inspect the shot list. Use **Record WebM** to record the procedural preview plus narration in real time.

## Gemini integration

The structured creative departments use the Gemini Interactions API with JSON Schema. The voice pass uses the Gemini Live API with native AUDIO output and output transcription. Current defaults are configurable in `.env`:

```env
OMNIMATE_TEXT_MODEL=gemini-3.8-flash
OMNIMATE_LIVE_MODEL=gemini-3.8-live
```

The Live API returns 16-bit little-endian PCM audio at 24 kHz. Omnimate wraps those PCM chunks into a WAV file locally, without requiring FFmpeg for playback.

Official references:

- https://ai.google.dev/gemini-api/docs/get-started
- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/live-api/capabilities

## Export and MP4

The built-in exporter records WebM directly in current Chrome/Edge. This keeps the app dependency-light and lets the rendered canvas and exact audio stay synchronized. If you want MP4 immediately and have FFmpeg installed:

```bash
ffmpeg -i omnimate-film.webm -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k omnimate-film.mp4
```

A later cloud-render worker can move the same canonical production plan to Godot/FFmpeg on Modal or Runpod without changing the creative pipeline.

## Project layout

```text
server.js                 Local HTTP API and studio server
lib/gemini.js             Gemini structured + Live audio integration
lib/orchestrator.js       Multi-department creative pipeline
lib/schema.js             Renderable production JSON grammar
lib/compiler.js           Defensive normalization + audio timing conform
lib/storage.js            Atomic local production persistence
lib/audio.js              PCM -> WAV utilities
public/                    Studio UI + procedural renderer
tests/                     Deterministic compiler/audio tests
docs/                      Architecture and creative pipeline design
```

## Product philosophy

The target is not "AI makes a video." It is **AI runs a studio**. Creative models decide what should happen; the animation engine owns how valid motion happens. That separation lets Omnimate improve its acting library, character rigs, IK, camera grammar and render quality without rewriting the story system—and lets the same creative plan render locally or on cloud workers.
