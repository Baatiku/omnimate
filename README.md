# Omnimate — Realistic Presenter

Omnimate is now a realistic presenter studio. Upload one photo of a presenter, write a script, and get a talking video back.

Gemini speaks the script. A Modal GPU worker (MuseTalk 1.5 plus face sharpening) moves the lips. No cartoon engine remains — the cartoon build is backed up at `../omnimate-backup-cartoon-2026-10-12`.

## Setup

Requirements: **Node.js 22+**, a Gemini API key, and Modal credits for video.

```bash
npm install
```

Copy `.env.example` to `.env` and add your keys:

```env
GEMINI_API_KEY=your_key_here
MODAL_PRESENTER_URL=https://your-user--omnimate-presenter-generate.modal.run
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

## Modal video worker

```bash
pip install modal
modal setup
modal deploy modal/presenter.py
```

Paste the printed URL into `.env` as `MODAL_PRESENTER_URL`. High quality renders on A100 and takes a few minutes on first run.

## Rules

- Only animate photos you own or have permission to use.
- Mark videos as AI-generated wherever you publish (YouTube requires it).

## Project layout

```text
server.js                 Presenter and Dubbing API studio server
lib/presenter.js          Presenter: Script -> voice -> video pipeline
lib/dub.js                Dubbing: Ingest -> review -> mastered audio & video
lib/modal-client.js       Modal GPU HTTP client
lib/gemini.js             Gemini Live voice & structured translation
lib/audio.js              PCM loudness normalization (-18 dBFS) & SRT/VTT formatters
lib/storage.js            Job and project storage
modal/presenter.py        Modal A100 lip-sync worker (MuseTalk 1.5)
modal/dub.py              Modal dubbing worker (Whisper, stem extraction, mastering)
public/                   Studio UI (Presenter + Dubbing review studio)
tests/                    Presenter, dubbing, and quota-governor tests
docs/PRESENTER.md         Presenter setup and quality notes
docs/DUBBING.md           Dubbing studio architecture, mastering, and review guide
```
