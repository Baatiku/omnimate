# Creative pipeline

Omnimate treats creativity as a reviewable multi-role production process, but API calls are deliberately bundled so the studio remains usable on a 5 RPM Gemini project.

## Studio request budget

Studio mode is limited to five normal Gemini request starts:

1. **Creative Council** — Executive Producer, Research Editor and Story Architect share one structured call. They produce distinct department records and reconcile disagreements.
2. **Writing Room** — the Screenwriter turns the council foundation into the locked narration, beats, visual opportunities and factual guardrails.
3. **Direction Council** — Art Director, Animation Director, Performance & Camera Director and Continuity & Quality Critic share one structured call while retaining distinct outputs.
4. **Showrunner** — compiles all approved material into the canonical constrained ProductionPlan.
5. **Gemini Live Voice Actor** — performs the narration. Actual PCM duration becomes the master clock for timeline conformance.

Draft mode uses three requests: a combined Creative + Writing Room pass, Showrunner, and Live Voice Actor.

## Global quota governor

All Gemini traffic goes through one process-wide queue in `lib/rate-limit.js`. Text calls, Live calls, regeneration, and multiple simultaneously submitted productions therefore cannot independently exceed the configured project budget.

Defaults:

- `OMNIMATE_GEMINI_RPM=5`
- `OMNIMATE_GEMINI_RATE_SAFETY_MS=1000`
- effective minimum spacing: 13 seconds
- `OMNIMATE_GEMINI_MAX_RETRIES=3`

429 / RESOURCE_EXHAUSTED failures consume another paced request slot and use bounded backoff instead of retrying immediately. The current stage note exposes queue/wait/retry state to the browser.

## Department responsibilities

**Executive Producer** owns the promise, hook, audience and emotional arc.

**Research Editor** owns factual defensibility and visualizable evidence, using Google Search grounding.

**Story Architect** owns escalation, reveals, motifs, payoff and ending.

**Screenwriter** owns exact spoken narration and scene beats.

**Art Director** owns the visual bible.

**Animation Director** owns physical acting, gestures, reactions, object interaction and secondary motion.

**Performance & Camera Director** owns blocking, shot size, camera movement and rhythm.

**Continuity & Quality Critic** attacks weak stretches, impossible actions, continuity errors, factual risk and missed visual opportunities.

**Showrunner** is the only role allowed to emit the final constrained render plan.

**Gemini Live Voice Actor** performs exactly the locked script.

## Quality principle

More API calls do not automatically create better films. Omnimate preserves specialist ownership while bundling roles that benefit from real-time debate inside one model context. The renderer still receives only one canonical production plan.
