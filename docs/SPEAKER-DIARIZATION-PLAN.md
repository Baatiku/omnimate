# Multi-Speaker Dubbing Plan (professional grade)

Goal: upload a video with several people talking, and get back a Hausa
(Yoruba, Igbo) dub where EACH person keeps their own consistent voice,
with a review screen where the owner checks and fixes speaker assignment
before spending voice/render time. Single-speaker videos keep working
exactly as today (fast path, no extra cost).

Non-goals for this plan: cloning real guests' voices without consent
(prebuilt voices only, unless the owner opts their OWN voice in), and
full facial re-animation per speaker (tracked as Phase 3).

## How the pros do it (verified against HeyGen, Rask, and the best
## open-source dubbers)

1. Transcribe with word times (WhisperX-style forced alignment).
2. Diarize: decide WHO speaks WHEN (voice fingerprints + clustering).
3. Translate with whole-scene context (pronouns, names, tone stay consistent).
4. Voice each speaker separately (their own voice, their own lines).
5. Place every line at its mark with small speed fixes (our current engine).
6. Optional: redraw each visible speaker's lips to the new audio.
7. Always: a human review screen before the expensive steps. Every serious
   tool has one, because no diarization is perfect.

Our timing engine (stage 5) already matches this. This plan adds stages
2, 4 (per speaker), and 7, plus speaker-aware translation.

## Proposed pipeline (per video)

A. Scan (Modal dub worker, GPU):
   - Voice activity detection + word-level transcript (upgrade
     faster-whisper `base` to word timestamps; same model, no new cost).
   - Speaker diarization with pyannote.audio 3.x
     (`speaker-diarization-3.1`): outputs who-speaks-when turns with
     confidence. Runs on GPU in seconds per minute of audio.
   - Face tracking: detect every face per scene (InsightFace), track the
     same face across shots, save one thumbnail per face.
   - Voice fingerprint per turn (ECAPA embedding, comes with pyannote
     ecosystem) and cluster turns into speakers.
   - Face-voice binding via active-speaker detection (Light-ASD): which
     visible mouth moves in sync with each voice turn. Faces that never
     move while "their" voice sounds are marked voice-only (phone calls,
     off-camera) instead of mislabeled.
   - Output: `speakers.json` — per speaker: face thumbnail (or
     voice-only flag), turn list, line count, mean confidence, sample
     audio clip.
B. Caption attribution (Node, cheap): overlap whisper word times with
   diarization turns -> every transcript line gets a speaker tag +
   confidence. Export SRT/VTT per language as a bonus artifact.
C. Review screen (browser, human-in-the-loop, REQUIRED before voicing):
   - Roster: face photo (or voice-only icon), "Speaker 1..N", line
     count, confidence bar, play-sample button.
   - Actions per speaker: rename (e.g. "Pastor James"), merge two
     speakers wrongly split, split one speaker wrongly joined (by
     selecting lines), mark voice-only, choose voice (male/female
     dropdowns from our 30), preview one line in that voice.
   - Low-confidence lines highlighted in the caption list with one-click
     reassign. Nothing renders until the owner presses Approve.
D. Translation per speaker (Gemini, one call): whole scene at once, with
   speaker names + genders + relationship context, so pronouns and forms
   of address come out right in Hausa. Per-line speaking-time budgets
   stay (current mechanism).
E. Voice per speaker (Gemini batch sessions, current mechanism): one
   session per speaker keeps voices consistent; lines keep their marks on
   the shared timeline (current placement engine, extended with a
   speaker tag per line, no timing change).
F. Assemble + download (current worker, unchanged contract plus
   speaker-labeled voiceover + caption files).

## Accuracy strategy (why this beats "just diarization")

- Three independent signals must agree: voice fingerprint, face track,
  mouth-movement sync. 2-of-3 agreement = auto-accept; anything less =
  flagged for the owner, never silently guessed.
- Overlap handling: segments where two people talk at once are marked
  `overlap: true`, voiced by the dominant speaker, and listed in review.
- Same-voice confusion (two similar male voices): the review screen's
  merge/split + sample playback is the backstop; the plan budgets for it
  instead of pretending it never happens.
- Quality gate per video: diarization error estimate + % low-confidence
  lines shown BEFORE approve. Auto-pass threshold proposed at 90%;
  below that the screen says "check these 6 lines" instead of failing.
- Single-speaker fast path: if only one voice fingerprint exists with
  high confidence, the whole review collapses to one confirm button.

## Cost & latency estimate (10-minute video, Modal credits)

- Transcribe (words): ~2-4 min CPU, pennies.
- Diarization + embeddings (GPU seconds-minutes on T4): small.
- Face track + active-speaker (GPU, heaviest step): a few minutes.
- Translation: 1-2 Gemini calls. Voices: one session per speaker
  (2 speakers ~ 2 sessions). Assembly: ~1 min.
- Total: roughly 10-15 minutes wall time, nearly all of it today's
  existing voice/render cost plus a few GPU minutes for scan. No monthly
  fees; everything stays pay-per-video on credits already held.

## Risks and mitigations

- pyannote 3.x needs a free HuggingFace token (gated model). Mitigation:
  token stored as a Modal secret once; public fallback discussed below.
- Crowded/noisy audio (music, crowds): VAD + review flags; worst case
  falls back to today's single-voice dub rather than failing.
- Off-camera speakers: first-class voice-only roles, not errors.
- Face linking wrong in fast cuts: scene-aware tracking + confidence
  threshold; uncertain links stay unlinked (voice still correct).
- Compute creep: scan models pinned to small variants (T4-friendly);
  budgets per stage with caps in code.

## Open-source fallback (if pyannote access is an issue)

WhisperX-style alignment + Silero VAD + ECAPA clustering can be assembled
from ungated parts. Accuracy drops ~10-15% on hard cases, review screen
absorbs the rest. Decision point before Phase 1 (recommendation: try
pyannote first; one token, much better).

## Phased build (each phase shippable, each verified before the next)

- Phase 1 (scan + captions + review, single voice): diarization,
  speaker-tagged captions/SRT, review screen with merge/split/rename,
  then today's single-voice dub. Value from day one: captioned videos
  + correct line attribution + translation quality jump from
  speaker-aware context.
- Phase 2 (per-speaker voices): voice assignment + per-speaker batch
  sessions + speaker-tagged timeline. The professional result.
- Phase 3 (face-linked polish): thumbnails bound to voices, per-face
  lip-sync passes on close-ups, speaker-labeled downloads.

## Decisions needed from the owner

1. Phase 1 scope as above, or jump straight to per-speaker voices?
2. Voice for the channel host: keep a fixed prebuilt voice, or clone
   the owner's own voice into Hausa (Gemini voice replication; needs a
   short consent recording)?
3. Max speakers per video to support in review UI (propose 6)?
4. Caption downloads: SRT/VTT per language as free bonus files (propose yes)?
