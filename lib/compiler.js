import { ALLOWED_ACTIONS, ALLOWED_CAMERAS, ALLOWED_EXPRESSIONS } from './schema.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

export function normalizePlan(input, requestedDuration = 60) {
  if (!input || typeof input !== 'object') throw new Error('Showrunner returned an invalid production plan.');
  const plan = structuredClone(input);
  plan.cast = Array.isArray(plan.cast) ? plan.cast.slice(0, 8) : [];
  const castIds = new Set(plan.cast.map((item) => String(item.id)));
  const rawShots = Array.isArray(plan.shots) ? plan.shots : [];
  if (!rawShots.length) throw new Error('The showrunner did not create any shots.');

  let cursor = 0;
  plan.shots = rawShots.slice(0, 40).map((shot, index) => {
    let start = Number.isFinite(Number(shot.start_sec)) ? Number(shot.start_sec) : cursor;
    let end = Number.isFinite(Number(shot.end_sec)) ? Number(shot.end_sec) : start + 4;
    start = Math.max(cursor, start);
    end = Math.max(start + 1.5, end);
    cursor = end;
    const actors = (Array.isArray(shot.actors) ? shot.actors : []).filter((actor) => castIds.has(String(actor.id))).slice(0, 4).map((actor) => ({
      id: String(actor.id),
      x: clamp(actor.x ?? 0.5, 0.08, 0.92),
      y: clamp(actor.y ?? 0.72, 0.35, 0.9),
      scale: clamp(actor.scale ?? 1, 0.55, 1.5),
      action: ALLOWED_ACTIONS.has(actor.action) ? actor.action : 'idle',
      expression: ALLOWED_EXPRESSIONS.has(actor.expression) ? actor.expression : 'neutral',
      look_at: String(actor.look_at || 'camera')
    }));
    return {
      id: String(shot.id || `shot-${index + 1}`),
      start_sec: start,
      end_sec: end,
      purpose: String(shot.purpose || ''),
      setting: String(shot.setting || 'studio'),
      background: String(shot.background || 'graphic stage'),
      camera: ALLOWED_CAMERAS.has(shot.camera) ? shot.camera : 'medium',
      mood: String(shot.mood || 'engaging'),
      narration_excerpt: String(shot.narration_excerpt || ''),
      on_screen_text: String(shot.on_screen_text || ''),
      actors,
      props: Array.isArray(shot.props) ? shot.props.map(String).slice(0, 8) : [],
      visual_effects: Array.isArray(shot.visual_effects) ? shot.visual_effects.map(String).slice(0, 6) : []
    };
  });

  const planned = plan.shots.at(-1).end_sec;
  const target = clamp(requestedDuration, 15, 180);
  const scale = target / planned;
  for (const shot of plan.shots) {
    shot.start_sec = round(shot.start_sec * scale);
    shot.end_sec = round(shot.end_sec * scale);
  }
  plan.duration_sec = target;
  return plan;
}

export function fitPlanToAudio(plan, audioDuration) {
  const fitted = structuredClone(plan);
  const sourceDuration = Number(fitted.duration_sec || fitted.shots?.at(-1)?.end_sec || audioDuration || 1);
  const targetDuration = Math.max(1, Number(audioDuration || sourceDuration));
  const scale = targetDuration / sourceDuration;
  for (const shot of fitted.shots || []) {
    shot.start_sec = round(shot.start_sec * scale);
    shot.end_sec = round(shot.end_sec * scale);
  }
  fitted.duration_sec = round(targetDuration);
  return fitted;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
