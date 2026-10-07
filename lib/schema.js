export const DEPARTMENT_SCHEMA = {
  type: 'object',
  properties: {
    department: { type: 'string' },
    summary: { type: 'string' },
    creative_decisions: { type: 'array', items: { type: 'string' } },
    must_keep: { type: 'array', items: { type: 'string' } },
    avoid: { type: 'array', items: { type: 'string' } },
    material: { type: 'string' }
  },
  required: ['department', 'summary', 'creative_decisions', 'must_keep', 'avoid', 'material']
};

const actorAction = ['idle','enter','exit','walk','run','explain','point','think','surprised','agree','disagree','celebrate','inspect','hold','offer','receive','react'];
const expression = ['neutral','warm','happy','serious','curious','surprised','concerned','excited','thinking','confident'];
const camera = ['wide','medium','close','two-shot','object-close','push-in','pull-out','pan-left','pan-right','tracking'];

export const PRODUCTION_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    logline: { type: 'string' },
    audience: { type: 'string' },
    visual_identity: {
      type: 'object',
      properties: {
        style: { type: 'string' },
        palette: { type: 'array', items: { type: 'string' } },
        character_design: { type: 'string' },
        motion_language: { type: 'string' },
        camera_language: { type: 'string' }
      },
      required: ['style','palette','character_design','motion_language','camera_language']
    },
    narration: {
      type: 'object',
      properties: {
        language: { type: 'string' },
        delivery: { type: 'string' },
        script: { type: 'string' }
      },
      required: ['language','delivery','script']
    },
    cast: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string' },
          appearance: { type: 'string' },
          personality: { type: 'string' }
        },
        required: ['id','name','role','appearance','personality']
      }
    },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          start_sec: { type: 'number' },
          end_sec: { type: 'number' },
          purpose: { type: 'string' },
          setting: { type: 'string' },
          background: { type: 'string' },
          camera: { type: 'string', enum: camera },
          mood: { type: 'string' },
          narration_excerpt: { type: 'string' },
          on_screen_text: { type: 'string' },
          actors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
                scale: { type: 'number' },
                action: { type: 'string', enum: actorAction },
                expression: { type: 'string', enum: expression },
                look_at: { type: 'string' }
              },
              required: ['id','x','y','scale','action','expression','look_at']
            }
          },
          props: { type: 'array', items: { type: 'string' } },
          visual_effects: { type: 'array', items: { type: 'string' } }
        },
        required: ['id','start_sec','end_sec','purpose','setting','background','camera','mood','narration_excerpt','on_screen_text','actors','props','visual_effects']
      }
    },
    quality_checklist: { type: 'array', items: { type: 'string' } }
  },
  required: ['title','logline','audience','visual_identity','narration','cast','shots','quality_checklist']
};

export const ALLOWED_ACTIONS = new Set(actorAction);
export const ALLOWED_EXPRESSIONS = new Set(expression);
export const ALLOWED_CAMERAS = new Set(camera);
