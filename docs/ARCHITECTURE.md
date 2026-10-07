# Omnimate architecture

## Core contract

Every production converges on one canonical `ProductionPlan`. The plan is the boundary between probabilistic AI creativity and deterministic animation. The renderer never consumes raw model prose.

```text
Creative brief
   │
   ├─ Executive Producer ─┐
   ├─ Research Editor ────┼─> Screenwriter
   └─ Story Architect ────┘       │
                                  ├─ Art Director
                                  ├─ Animation Director
                                  └─ Performance/Camera Director
                                           │
                                           v
                                      Quality Critic
                                           │
                                           v
                                        Showrunner
                                           │
                                  canonical ProductionPlan
                                           │
                               Gemini Live narration performance
                                           │
                                  audio-duration conform
                                           │
                                     procedural renderer
```

## Why the schema is constrained

Allowing an LLM to invent arbitrary bone rotations, shader names or camera operators makes a renderer brittle. Omnimate instead exposes a small acting language such as `walk`, `explain`, `point`, `think`, `react`, `offer` and `receive`; a small expression set; and a small camera vocabulary. The local renderer interprets those verbs. A future Godot renderer can interpret the same verbs with skeletal animation and IK.

## Local persistence

Each project is stored under `.omnimate/projects/<id>/`:

- `job.json`: brief, department outputs, status, canonical plan and audio metadata.
- `audio.wav`: final Gemini Live voice performance.

Writes are serialized per project and committed by temporary-file rename so concurrent creative departments cannot partially overwrite the project ledger.

## Security

`GEMINI_API_KEY` is read only by the Node server. The browser calls `/api/*`; it never receives credentials. If Omnimate later exposes the Gemini Live API directly to untrusted browsers, use Gemini ephemeral tokens instead of forwarding the server API key.

## Cloud evolution

Railway is appropriate for the API, queue and project metadata. Heavy or GPU-backed workers can run on Modal or Runpod. The cloud job should accept a `ProductionPlan` and return render artifacts; it should not own creative product state.

A high-quality Godot worker would add:

- shared humanoid skeletons;
- layered animation blending;
- 2D IK for hand/foot targets;
- gaze and listener behavior;
- prop ownership/hand-off state;
- collision-aware blocking;
- phoneme mouth cues;
- fixed-FPS offline MovieWriter output;
- FFmpeg finishing;
- vision-based keyframe QA and selective re-render.
