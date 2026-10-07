import path from 'node:path';
import { TEAM_BRIEF_SCHEMA, WRITING_ROOM_SCHEMA, PRODUCTION_SCHEMA } from './schema.js';
import { generateJson, generateNarrationAudio } from './gemini.js';
import { fitPlanToAudio, normalizePlan } from './compiler.js';
import { projectDir, saveJob } from './storage.js';

const STAGE_LABELS = {
  producer: 'Executive Producer',
  research: 'Research Editor',
  story: 'Story Architect',
  writer: 'Screenwriter',
  art: 'Art Director',
  animation: 'Animation Director',
  camera: 'Performance & Camera Director',
  critic: 'Continuity & Quality Critic',
  showrunner: 'Showrunner',
  voice: 'Gemini Live Voice Actor',
  finishing: 'Finishing Editor'
};

export function makeInitialStages() {
  return Object.entries(STAGE_LABELS).map(([id, label]) => ({ id, label, status: 'waiting', note: '' }));
}

function baseContext(options) {
  return [
    `PROJECT PROMPT: ${options.prompt}`,
    `TARGET DURATION: ${options.durationSec} seconds`,
    `FORMAT: ${options.aspectRatio}`,
    `VISUAL STYLE: ${options.style}`,
    `LANGUAGE: ${options.language || 'Automatically choose the best language from the user prompt.'}`,
    `AUDIENCE: ${options.audience || 'general audience'}`,
    '',
    'The finished piece is a highly engaging 2D procedural cartoon/explainer. It must feel directed, acted and cinematic rather than like a slideshow. Prefer visual storytelling over putting every sentence on screen. Use recurring characters when useful. Keep scenes renderable with simple vector characters, props, typography, diagrams and camera motion.'
  ].join('\n');
}

const compact = (value) => JSON.stringify(value);

function normalizedDepartment(id, source, fallbackLabel) {
  return {
    department: source?.department || fallbackLabel || STAGE_LABELS[id] || id,
    summary: source?.summary || 'Completed as part of a bundled studio pass.',
    creative_decisions: source?.creative_decisions || [],
    must_keep: source?.must_keep || [],
    avoid: source?.avoid || [],
    material: source?.material || ''
  };
}

export async function runProduction(job, options) {
  const setStage = async (id, status, note = '') => {
    const stage = job.stages.find((item) => item.id === id);
    if (stage) Object.assign(stage, { status, note });
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
  };

  const setStages = async (ids, status, note = '') => {
    for (const id of ids) {
      const stage = job.stages.find((item) => item.id === id);
      if (stage) Object.assign(stage, { status, note });
    }
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
  };

  job.geminiUsage ||= { requestsStarted: 0, rateLimitRetries: 0, lastRequestAt: null };

  const quotaEvents = (stageIds) => async (event) => {
    if (event.type === 'start') {
      job.geminiUsage.requestsStarted += 1;
      job.geminiUsage.lastRequestAt = new Date().toISOString();
      await setStages(stageIds, 'working', event.attempt ? `Retry ${event.attempt + 1} started.` : 'Gemini is working…');
    } else if (event.type === 'wait') {
      await setStages(stageIds, 'working', `Waiting ${Math.ceil(event.waitMs / 1000)}s for Gemini quota capacity…`);
    } else if (event.type === 'retry') {
      job.geminiUsage.rateLimitRetries += 1;
      await setStages(stageIds, 'working', `Gemini rate limit reached. Retrying in ${Math.ceil(event.waitMs / 1000)}s…`);
    } else if (event.type === 'queued') {
      await setStages(stageIds, 'working', event.pending > 1 ? `Queued behind ${event.pending - 1} Gemini request(s)…` : 'Queued for Gemini…');
    }
  };

  const applyTeamBundle = async (ids, bundle) => {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      const source = bundle.departments?.find((item) => item.id === id) || bundle.departments?.[index];
      job.departments[id] = normalizedDepartment(id, source, STAGE_LABELS[id]);
      await setStage(id, 'done', job.departments[id].summary);
    }
  };

  try {
    job.status = 'running';
    await saveJob(job);
    const studioMode = options.quality !== 'draft';

    let foundation;
    let writer;

    if (studioMode) {
      const creativeIds = ['producer', 'research', 'story'];
      await setStages(creativeIds, 'working', 'Creative Council assembling…');
      const council = await generateJson({
        label: 'Creative Council',
        onEvent: quotaEvents(creativeIds),
        tools: [{ type: 'google_search' }],
        schema: TEAM_BRIEF_SCHEMA,
        prompt: [
          'You are one collaborative Creative Council containing three senior specialists: Executive Producer, Research Editor, and Story Architect.',
          'Each specialist must independently do their job, challenge weak ideas from the others, and then reconcile disagreements into one stronger foundation.',
          'Return exactly three department entries with ids producer, research, and story.',
          'The Research Editor must separate defensible factual claims from speculation and surface visualizable facts. The Producer owns hook/emotion/audience promise. The Story Architect owns scene-level escalation, reveals, motifs and payoff.',
          'Do not behave like one generic assistant merely wearing three labels.',
          baseContext(options)
        ].join('\n\n')
      });
      await applyTeamBundle(creativeIds, council);
      foundation = council;

      await setStage('writer', 'working', 'Writing Room preparing the final narration…');
      writer = await generateJson({
        label: 'Writing Room',
        onEvent: quotaEvents(['writer']),
        schema: WRITING_ROOM_SCHEMA,
        prompt: [
          'You are Omnimate’s senior Screenwriter. Turn the Creative Council foundation into the final spoken narration and scene beats.',
          'The narration must be human, economical, performable, correctly sized to the target duration, and have a strong opening plus satisfying ending.',
          'Keep factual claims inside the Research Editor guardrails. Put staging ideas in scene_beats and visual_opportunities, never as spoken stage directions.',
          baseContext(options),
          'CREATIVE COUNCIL:',
          compact(council)
        ].join('\n\n')
      });
      job.departments.writer = normalizedDepartment('writer', {
        department: 'Screenwriter',
        summary: writer.summary,
        material: compact(writer),
        creative_decisions: writer.scene_beats,
        must_keep: writer.factual_guardrails,
        avoid: []
      });
      await setStage('writer', 'done', writer.summary);

      const directionIds = ['art', 'animation', 'camera', 'critic'];
      await setStages(directionIds, 'working', 'Direction Council assembling…');
      const direction = await generateJson({
        label: 'Direction Council',
        onEvent: quotaEvents(directionIds),
        schema: TEAM_BRIEF_SCHEMA,
        prompt: [
          'You are one collaborative Direction Council containing four senior specialists: Art Director, Animation Director, Performance & Camera Director, and Continuity & Quality Critic.',
          'Return exactly four department entries with ids art, animation, camera, and critic.',
          'Art owns the coherent visual bible. Animation translates every beat into motivated acting and physical motion. Camera owns framing/blocking/rhythm. Critic aggressively finds boring stretches, continuity problems, impossible actions, factual risk, redundant exposition and missed visual opportunities, then prescribes exact fixes.',
          'Debate internally and make the recommendations mutually consistent before returning them.',
          baseContext(options),
          'CREATIVE FOUNDATION:',
          compact(council),
          'FINAL WRITING ROOM:',
          compact(writer)
        ].join('\n\n')
      });
      await applyTeamBundle(directionIds, direction);
      foundation = { council, writer, direction };
    } else {
      const draftIds = ['producer', 'research', 'story', 'writer'];
      await setStages(draftIds, 'working', 'Draft writing room assembling…');
      writer = await generateJson({
        label: 'Draft Creative + Writing Room',
        onEvent: quotaEvents(draftIds),
        tools: [{ type: 'google_search' }],
        schema: WRITING_ROOM_SCHEMA,
        prompt: [
          'You are a compact four-role writing room combining Executive Producer, Research Editor, Story Architect, and Screenwriter in one pass.',
          'Internally perform all four jobs before returning the final narration, scene beats, visual opportunities and factual guardrails.',
          'This is Draft mode: be fast and decisive, but keep facts defensible and the narration genuinely performable.',
          baseContext(options)
        ].join('\n\n')
      });
      for (const id of draftIds) {
        job.departments[id] = normalizedDepartment(id, {
          department: STAGE_LABELS[id],
          summary: writer.summary,
          material: compact(writer),
          creative_decisions: writer.scene_beats,
          must_keep: writer.factual_guardrails,
          avoid: []
        });
        await setStage(id, 'done', writer.summary);
      }
      await setStage('art', 'skipped', 'Draft mode');
      await setStage('camera', 'skipped', 'Draft mode');
      await setStage('critic', 'skipped', 'Draft mode');
      job.departments.animation = normalizedDepartment('animation', {
        department: STAGE_LABELS.animation,
        summary: 'Draft motion is derived directly from Writing Room scene beats.',
        material: writer.visual_opportunities.join('\n'),
        creative_decisions: writer.visual_opportunities,
        must_keep: [],
        avoid: []
      });
      await setStage('animation', 'done', job.departments.animation.summary);
      foundation = { writer };
    }

    await setStage('showrunner', 'working', 'Compiling the locked production plan…');
    const showrunnerPrompt = [
      'You are Omnimate’s Showrunner. Compile the approved studio material into ONE canonical production plan that the renderer can execute.',
      baseContext(options),
      '',
      'STRICT RENDERING RULES:',
      '- Shots must be chronological, contiguous, and cover the target duration.',
      '- Prefer 3–7 second shots, with shorter reaction inserts when useful.',
      '- Actor x/y are normalized 0..1 stage coordinates. Keep y around 0.65–0.82 for standing actors.',
      '- Only use the allowed actions, expressions, and camera values supplied by the schema.',
      '- Keep cast IDs stable across every shot.',
      '- Use on_screen_text sparingly: short emphasis only, never transcript dumps.',
      '- Use props and simple visual effects that a procedural 2D renderer can represent.',
      '- narration.script must preserve the Writing Room narration closely and remain the exact text the voice actor should speak.',
      '- In Studio mode, apply every important correction from the Direction Council critic.',
      '',
      'APPROVED STUDIO MATERIAL:',
      compact(foundation)
    ].join('\n');

    let plan = await generateJson({
      label: 'Showrunner',
      onEvent: quotaEvents(['showrunner']),
      prompt: showrunnerPrompt,
      schema: PRODUCTION_SCHEMA
    });
    plan = normalizePlan(plan, options.durationSec);
    job.plan = plan;
    await setStage('showrunner', 'done', `Locked ${plan.shots.length} shots.`);

    await setStage('voice', 'working', 'Gemini Live narration queued…');
    const audioPath = path.join(projectDir(job.id), 'audio.wav');
    const audio = await generateNarrationAudio({
      label: 'Gemini Live Voice Actor',
      onEvent: quotaEvents(['voice']),
      script: plan.narration.script,
      voice: options.voice,
      delivery: plan.narration.delivery,
      outputPath: audioPath
    });
    job.audio = { ...audio, url: `/api/productions/${job.id}/audio.wav`, voice: options.voice };
    job.plan = fitPlanToAudio(plan, audio.durationSec);
    await setStage('voice', 'done', `${Math.round(audio.durationSec)}s narration generated.`);

    await setStage('finishing', 'working', 'Conforming shots to final audio and preparing preview…');
    job.plan.render = {
      aspectRatio: options.aspectRatio,
      fps: 30,
      safeArea: 0.06,
      renderer: 'omnimate-procedural-2d-v1'
    };
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    await setStage('finishing', 'done', 'Production ready for playback and browser export.');
    await saveJob(job);
  } catch (error) {
    job.status = 'failed';
    job.error = error?.message || String(error);
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
  }
  return job;
}
