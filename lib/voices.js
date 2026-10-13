// Official Google Gemini prebuilt voices for Multimodal Live & TTS (30 astronomical studio voices).
// Single source of truth across presenter, dubbing, and review studio.

export const PRESENTER_VOICES = Object.freeze([
  // Female voices (Aoede, Kore lead)
  { name: 'Aoede', gender: 'Female', style: 'Breezy & Natural Lead' },
  { name: 'Kore', gender: 'Female', style: 'Firm & Broadcast Anchor' },
  { name: 'Leda', gender: 'Female', style: 'Youthful & Bright' },
  { name: 'Zephyr', gender: 'Female', style: 'Bright & Energetic' },
  { name: 'Callirrhoe', gender: 'Female', style: 'Easy-going & Friendly' },
  { name: 'Autonoe', gender: 'Female', style: 'Bright & Cheerful' },
  { name: 'Despina', gender: 'Female', style: 'Smooth & Melodic' },
  { name: 'Erinome', gender: 'Female', style: 'Clear & Articulate' },
  { name: 'Laomedeia', gender: 'Female', style: 'Upbeat & Radiant' },
  { name: 'Achernar', gender: 'Female', style: 'Soft & Tender' },
  { name: 'Gacrux', gender: 'Female', style: 'Mature & Dignified Elder' },
  { name: 'Pulcherrima', gender: 'Female', style: 'Forward & Dynamic' },
  { name: 'Vindemiatrix', gender: 'Female', style: 'Gentle & Calm' },
  { name: 'Sulafat', gender: 'Female', style: 'Warm & Expressive' },
  { name: 'Rasalgethi', gender: 'Female', style: 'Informative & Balanced' },

  // Male voices (Charon, Puck lead)
  { name: 'Charon', gender: 'Male', style: 'Informative & Authoritative Anchor' },
  { name: 'Puck', gender: 'Male', style: 'Upbeat & Lively Lead' },
  { name: 'Fenrir', gender: 'Male', style: 'Excitable & Dynamic' },
  { name: 'Orus', gender: 'Male', style: 'Firm & Confident' },
  { name: 'Enceladus', gender: 'Male', style: 'Breathy & Gentle' },
  { name: 'Iapetus', gender: 'Male', style: 'Clear & Articulate Explainer' },
  { name: 'Umbriel', gender: 'Male', style: 'Easy-going & Relaxed' },
  { name: 'Algieba', gender: 'Male', style: 'Smooth & Refined' },
  { name: 'Algenib', gender: 'Male', style: 'Gravelly & Seasoned Elder' },
  { name: 'Alnilam', gender: 'Male', style: 'Firm & Commanding' },
  { name: 'Schedar', gender: 'Male', style: 'Even & Balanced' },
  { name: 'Achird', gender: 'Male', style: 'Friendly & Approachable' },
  { name: 'Zubenelgenubi', gender: 'Male', style: 'Casual & Modern' },
  { name: 'Sadachbia', gender: 'Male', style: 'Lively & Animated' },
  { name: 'Sadaltager', gender: 'Male', style: 'Knowledgeable & Wise' },
]);

export function voiceByName(name) {
  return PRESENTER_VOICES.find((voice) => voice.name === name) || null;
}

export const FEMALE_VOICES = Object.freeze(
  PRESENTER_VOICES.filter((v) => v.gender === 'Female').map((v) => v.name)
);

export const MALE_VOICES = Object.freeze(
  PRESENTER_VOICES.filter((v) => v.gender === 'Male').map((v) => v.name)
);

export const FEMALE_VOICE_TIERS = Object.freeze({
  Child: ['Zephyr', 'Autonoe', 'Leda'],
  Teen: ['Leda', 'Zephyr', 'Callirrhoe', 'Autonoe'],
  'Young Adult': ['Aoede', 'Callirrhoe', 'Laomedeia', 'Despina', 'Erinome'],
  Adult: ['Kore', 'Aoede', 'Pulcherrima', 'Sulafat', 'Erinome', 'Rasalgethi'],
  Senior: ['Gacrux', 'Vindemiatrix', 'Achernar', 'Kore'],
});

export const MALE_VOICE_TIERS = Object.freeze({
  Child: ['Puck', 'Fenrir', 'Umbriel'],
  Teen: ['Puck', 'Umbriel', 'Zubenelgenubi', 'Fenrir'],
  'Young Adult': ['Puck', 'Achird', 'Zubenelgenubi', 'Iapetus', 'Sadachbia'],
  Adult: ['Charon', 'Orus', 'Algieba', 'Alnilam', 'Schedar', 'Sadaltager'],
  Senior: ['Algenib', 'Sadaltager', 'Charon', 'Alnilam'],
});
