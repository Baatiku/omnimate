// Official Google Gemini prebuilt voices for Multimodal Live & TTS (expanded studio roster: 67 voices).
// Single source of truth across presenter, dubbing, and review studio.

export const PRESENTER_VOICES = Object.freeze([
  // Female voices (Aoede, Fola, Lumi, Sola lead)
  { name: 'Aoede', gender: 'Female', style: 'Breezy & Natural Lead' },
  { name: 'Fola', gender: 'Female', style: 'Warm & Natural Storyteller Lead' },
  { name: 'Lumi', gender: 'Female', style: 'Bright & Gentle Conversationalist' },
  { name: 'Sola', gender: 'Female', style: 'Warm & Melodic Storyteller' },
  { name: 'Kira', gender: 'Female', style: 'Crisp & Expressive Narrator' },
  { name: 'Rina', gender: 'Female', style: 'Youthful & Cheerful' },
  { name: 'Nika', gender: 'Female', style: 'Modern & Energetic' },
  { name: 'Zali', gender: 'Female', style: 'Friendly & Vibrant' },
  { name: 'Cleo', gender: 'Female', style: 'Sophisticated & Smooth Anchor' },
  { name: 'Lora', gender: 'Female', style: 'Calm & Resonant Explainer' },
  { name: 'Enya', gender: 'Female', style: 'Soft & Melodic' },
  { name: 'Nyla', gender: 'Female', style: 'Playful & Bright' },
  { name: 'Tova', gender: 'Female', style: 'Steady & Warm Broadcast' },
  { name: 'Zuri', gender: 'Female', style: 'Radiant & Dynamic' },
  { name: 'Hali', gender: 'Female', style: 'Breezy & Approachable' },
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

  // Male voices (Bodi, Koda, Charon, Puck lead)
  { name: 'Bodi', gender: 'Male', style: 'Warm & Dynamic Conversational Lead' },
  { name: 'Koda', gender: 'Male', style: 'Casual & Energetic Presenter Lead' },
  { name: 'Charon', gender: 'Male', style: 'Informative & Authoritative Anchor' },
  { name: 'Puck', gender: 'Male', style: 'Upbeat & Lively Lead' },
  { name: 'Varo', gender: 'Male', style: 'Confident & Resonant Anchor' },
  { name: 'Zeno', gender: 'Male', style: 'Thoughtful & Articulate' },
  { name: 'Ludo', gender: 'Male', style: 'Playful & Youthful' },
  { name: 'Mako', gender: 'Male', style: 'Crisp & Direct Explainer' },
  { name: 'Brio', gender: 'Male', style: 'Upbeat & Dynamic' },
  { name: 'Jori', gender: 'Male', style: 'Relaxed & Friendly' },
  { name: 'Rami', gender: 'Male', style: 'Smooth & Rich Storyteller' },
  { name: 'Enzo', gender: 'Male', style: 'Lively & Expressive' },
  { name: 'Riko', gender: 'Male', style: 'Modern & Clear' },
  { name: 'Sami', gender: 'Male', style: 'Gentle & Natural' },
  { name: 'Gero', gender: 'Male', style: 'Seasoned & Resonant' },
  { name: 'Neno', gender: 'Male', style: 'Calm & Easy-going' },
  { name: 'Olin', gender: 'Male', style: 'Firm & Dignified' },
  { name: 'Daro', gender: 'Male', style: 'Deep & Authoritative' },
  { name: 'Milo', gender: 'Male', style: 'Warm & Relatable' },
  { name: 'Arlo', gender: 'Male', style: 'Cheerful & Engaging' },
  { name: 'Finn', gender: 'Male', style: 'Bright & Youthful' },
  { name: 'Jett', gender: 'Male', style: 'Fast-paced & Punchy' },
  { name: 'Knox', gender: 'Male', style: 'Solid & Grounded' },
  { name: 'Cruz', gender: 'Male', style: 'Charismatic & Smooth' },
  { name: 'Elio', gender: 'Male', style: 'Radiant & Optimistic' },
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
  Child: ['Rina', 'Nyla', 'Zephyr', 'Autonoe', 'Leda'],
  Teen: ['Lumi', 'Nika', 'Zali', 'Leda', 'Zephyr', 'Callirrhoe', 'Autonoe', 'Rina'],
  'Young Adult': ['Fola', 'Sola', 'Kira', 'Aoede', 'Enya', 'Zuri', 'Hali', 'Callirrhoe', 'Laomedeia', 'Despina', 'Erinome'],
  Adult: ['Fola', 'Cleo', 'Lora', 'Tova', 'Kore', 'Aoede', 'Pulcherrima', 'Sulafat', 'Erinome', 'Rasalgethi'],
  Senior: ['Gacrux', 'Vindemiatrix', 'Achernar', 'Lora', 'Kore'],
});

export const MALE_VOICE_TIERS = Object.freeze({
  Child: ['Ludo', 'Finn', 'Puck', 'Fenrir', 'Umbriel'],
  Teen: ['Arlo', 'Milo', 'Jett', 'Puck', 'Umbriel', 'Zubenelgenubi', 'Fenrir'],
  'Young Adult': ['Bodi', 'Koda', 'Brio', 'Jori', 'Enzo', 'Riko', 'Sami', 'Elio', 'Cruz', 'Puck', 'Achird', 'Zubenelgenubi', 'Iapetus', 'Sadachbia'],
  Adult: ['Bodi', 'Koda', 'Varo', 'Zeno', 'Mako', 'Rami', 'Knox', 'Charon', 'Orus', 'Algieba', 'Alnilam', 'Schedar', 'Sadaltager'],
  Senior: ['Daro', 'Gero', 'Olin', 'Algenib', 'Sadaltager', 'Charon', 'Alnilam'],
});
