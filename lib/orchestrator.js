import path from 'node:path';
import { DEPARTMENT_SCHEMA, PRODUCTION_SCHEMA } from './schema.js';
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

function departmentPrompt(role, mission, options, context = '') {
  return [
    `You are Omnimate's ${role}, working at the standard of a top animation studio.`,
    mission,
    'Be concrete. Make bold creative decisions. Avoid generic AI filler, repetitive scenes, talking-head monotony and visual clichés.',
    baseContext(options),
    context ? `\nMATERIAL FROM OTHER DEPARTMENTS:\n${context}` : '',
    '\nReturn the requested department brief. The material field should contain the most useful detailed work product from your department.'
  ].join('\n');
}

const compact = (value) => JSON.stringify(value);

export async function runProduction(job, options) {
  const setStage = async (id, status, note = '') => {
    const stage = job.stages.find((item) => item.id === id);
    if (stage) Object.assign(stage, { status, note });
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
  };

  const runDepartment = async (id, role, mission, context = '', tools) => {
    await setStage(id, 'working', 'Thinking…');
    try {
      const result = await generateJson({
        prompt: departmentPrompt(role, mission, options, context),
        schema: DEPARTMENT_SCHEMA,
        ...(tools ? { tools } : {})
      });
      job.departments[id] = result;
      await setStage(id, 'done', result.summary);
      return result;
    } catch (error) {
      await setStage(id, 'error', error.message);
      throw error;
    }
  };

  try {
    job.status = 'running';
    await saveJob(job);

    const studioMode = options.quality !== 'draft';
    const firstWave = await Promise.all([
      runDepartment('producer', 'Executive Producer', 'Define the irresistible core concept, hook, emotional arc, audience promise, pacing strategy, and what makes this film memorable.'),
      runDepartment('research', 'Research Editor', 'For factual/informative claims, create a concise fact brief with only defensible claims, useful context and visualizable facts. For fiction, instead establish internal-world facts and authenticity notes.', '', studioMode ? [{ type: 'google_search' }] : undefined),
      runDepartment('story', 'Story Architect', 'Design the narrative architecture: opening hook, escalation, reveals, emotional turns, visual motifs, payoff and ending. Think in scenes, not paragraphs.')
    ]);

    const foundation = firstWave.map(compact).join('\n\n');
    const writer = await runDepartment('writer', 'Screenwriter', 'Write the complete narration/script sized to the target duration. It must sound human, economical and performable, with a strong opening and satisfying ending. Include scene-beat hints in the material but do not clutter the spoken narration with directions.', foundation);

    if (!studioMode) {
      await setStage('art', 'skipped', 'Draft mode');
      await setStage('camera', 'skipped', 'Draft mode');
    }

    const secondWaveTasks = [
      studioMode
        ? runDepartment('art', 'Art Director', 'Create a coherent visual bible: character silhouette language, environments, prop motifs, color strategy, typography behavior, visual metaphors, and rules that keep every shot recognizably from the same film.', compact(writer))
        : Promise.resolve(null),
      runDepartment('animation', 'Animation Director', 'Translate the script into physical acting. Specify entrances, exits, gestures, gaze, reactions, object interactions, secondary motion, transitions and moments of stillness. Every few seconds should contain a motivated visual change.', compact(writer)),
      studioMode
        ? runDepartment('camera', 'Performance & Camera Director', 'Plan shot size, blocking, camera movement, reaction shots, emphasis, staging and rhythm. Make the camera support meaning; avoid random motion.', compact(writer))
        : Promise.resolve(null)
    ];
    const secondWave = await Promise.all(secondWaveTasks);

    const criticContext = [foundation, compact(writer), ...secondWave.filter(Boolean).map(compact)].join('\n\n');
    const critic = await runDepartment('critic', 'Continuity & Quality Critic', 'Attack the current plan like a demanding senior editor. Identify boring stretches, continuity problems, impossible actions, weak visuals, redundant exposition, factual risk, tone drift and missed opportunities. Then prescribe exact fixes.', criticContext);

    await setStage('showrunner', 'working', 'Compiling the locked production plan…');
    const showrunnerPrompt = [
      'You are Omnimate’s Showrunner. Compile the departments into ONE canonical production plan that the renderer can execute.',
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
      '- The narration.script must be the exact final text the voice actor should speak.',
      '- Apply every important correction from the critic.',
      '',
      'DEPARTMENT MATERIAL:',
      criticContext,
      '\nCRITIC:', compact(critic)
    ].join('\n');
    let plan = await generateJson({ prompt: showrunnerPrompt, schema: PRODUCTION_SCHEMA });
    plan = normalizePlan(plan, options.durationSec);
    job.plan = plan;
    await setStage('showrunner', 'done', `Locked ${plan.shots.length} shots.`);

    await setStage('voice', 'working', 'Performing final narration with Gemini Live…');
    const audioPath = path.join(projectDir(job.id), 'audio.wav');
    const audio = await generateNarrationAudio({
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
