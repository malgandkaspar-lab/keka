/**
 * Seed data for configurable catalogs. These are inserted into the database by
 * `prisma/seed.ts` and can then be edited, disabled or extended at runtime; the
 * application never reads these constants directly for business decisions.
 */
export interface CategorySeed {
  key: string;
  name: string;
  description: string;
  promptHints: string;
}

export const BUILT_IN_CATEGORIES: CategorySeed[] = [
  { key: "science", name: "Science", description: "Physics, chemistry, biology and the human body.", promptHints: "Counter-intuitive, verifiable scientific phenomena explained simply." },
  { key: "technology", name: "Technology", description: "How everyday and cutting-edge technology works.", promptHints: "How things work, surprising engineering details, history of devices." },
  { key: "artificial_intelligence", name: "Artificial Intelligence", description: "AI concepts, milestones and real-world impact.", promptHints: "Accurate, non-hyped explanations of AI capabilities, history and limits." },
  { key: "space", name: "Space", description: "Astronomy, space exploration and cosmology.", promptHints: "Planets, stars, missions and astronaut life, with NASA/ESA-verifiable facts." },
  { key: "history", name: "History", description: "Remarkable events, people and turning points.", promptHints: "Well-documented historical events with specific dates and places." },
  { key: "nature", name: "Nature", description: "Earth's landscapes, weather and ecosystems.", promptHints: "Natural phenomena, extreme environments, ecosystems." },
  { key: "animals", name: "Animals", description: "Surprising animal abilities and behaviour.", promptHints: "Documented animal behaviours and adaptations; avoid myths." },
  { key: "psychology", name: "Psychology", description: "How the mind works, biases and behaviour.", promptHints: "Replicated findings only; flag contested studies as uncertain." },
  { key: "geography", name: "Geography", description: "Countries, borders, places and maps.", promptHints: "Unusual places, borders and geographic records." },
  { key: "business", name: "Business", description: "Companies, economics and entrepreneurship.", promptHints: "Documented company histories and economic concepts; no financial advice." },
  { key: "interesting_facts", name: "Interesting Facts", description: "General-knowledge facts that surprise people.", promptHints: "Verifiable, surprising everyday facts." },
  { key: "inventions", name: "Inventions", description: "The stories behind inventions.", promptHints: "Origins of inventions with documented inventors and dates." },
  { key: "future_technology", name: "Future Technology", description: "Emerging tech and what may come next.", promptHints: "Clearly separate current reality from projections; label speculation." },
  { key: "mysteries", name: "Mysteries", description: "Unsolved questions and strange phenomena.", promptHints: "Present evidence honestly; never claim unproven explanations as fact." },
];

export interface VoiceSeed {
  provider: string;
  voiceId: string;
  name: string;
  description: string;
  gender: string;
  styles: string[];
}

/**
 * Premade ElevenLabs English voices. Use Settings → "Sync voices" to refresh the
 * catalog from the ElevenLabs API for your account.
 */
export const DEFAULT_VOICES: VoiceSeed[] = [
  { provider: "elevenlabs", voiceId: "JBFqnCBsd6RMkjVDRZzb", name: "George", description: "Warm British male storyteller", gender: "male", styles: ["documentary", "calm", "cinematic"] },
  { provider: "elevenlabs", voiceId: "nPczCjzI2devNBz1zQrb", name: "Brian", description: "Deep American male narrator", gender: "male", styles: ["documentary", "cinematic"] },
  { provider: "elevenlabs", voiceId: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam", description: "Energetic young American male", gender: "male", styles: ["energetic", "conversational"] },
  { provider: "elevenlabs", voiceId: "cjVigY5qzO86Huf0OWal", name: "Eric", description: "Smooth, friendly American male", gender: "male", styles: ["conversational", "calm"] },
  { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", description: "Soft, confident American female", gender: "female", styles: ["calm", "documentary"] },
  { provider: "elevenlabs", voiceId: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", description: "Friendly, upbeat American female", gender: "female", styles: ["energetic", "conversational"] },
  { provider: "elevenlabs", voiceId: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", description: "Clear, engaging British female", gender: "female", styles: ["documentary", "conversational"] },
  { provider: "elevenlabs", voiceId: "cgSgspJ2msm6clMCkdW9", name: "Jessica", description: "Expressive, playful American female", gender: "female", styles: ["energetic"] },
];
