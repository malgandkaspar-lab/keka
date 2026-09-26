import { ffmpeg } from "@/services/video/ffmpeg";

/**
 * Procedural, royalty-free audio synthesised locally with FFmpeg.
 *
 * Used as the fallback when the user's licensed music library has no track for a mood,
 * and to create sound effects. Everything is generated from oscillators and noise, so
 * there are no third-party rights involved. Parameters vary per seed so videos do not
 * all sound identical.
 */
const NOTE_FREQ: Record<string, number> = {
  C: 261.63, "C#": 277.18, D: 293.66, "D#": 311.13, E: 329.63, F: 349.23, "F#": 369.99,
  G: 392.0, "G#": 415.3, A: 440.0, "A#": 466.16, B: 493.88,
};

interface MoodProfile {
  progression: string[][];
  chordSec: number;
  octave: number;
  beatEverySec: number | null;
  lowpassHz: number;
  shimmer: boolean;
}

export const MOOD_PROFILES: Record<string, MoodProfile> = {
  mysterious: { progression: [["A", "C", "E"], ["F", "A", "C"], ["D", "F", "A"], ["E", "G#", "B"]], chordSec: 4, octave: -1, beatEverySec: null, lowpassHz: 1400, shimmer: true },
  cinematic: { progression: [["C", "E", "G"], ["A", "C", "E"], ["F", "A", "C"], ["G", "B", "D"]], chordSec: 4, octave: -1, beatEverySec: 1.0, lowpassHz: 2200, shimmer: true },
  energetic: { progression: [["A", "C", "E"], ["F", "A", "C"], ["C", "E", "G"], ["G", "B", "D"]], chordSec: 2, octave: -1, beatEverySec: 0.5, lowpassHz: 3500, shimmer: false },
  inspiring: { progression: [["C", "E", "G"], ["G", "B", "D"], ["A", "C", "E"], ["F", "A", "C"]], chordSec: 3, octave: 0, beatEverySec: 1.0, lowpassHz: 3000, shimmer: true },
  technological: { progression: [["D", "F", "A"], ["A#", "D", "F"], ["C", "E", "G"], ["A", "C#", "E"]], chordSec: 2, octave: -1, beatEverySec: 0.5, lowpassHz: 2600, shimmer: false },
  documentary: { progression: [["D", "F#", "A"], ["B", "D", "F#"], ["G", "B", "D"], ["A", "C#", "E"]], chordSec: 4, octave: -1, beatEverySec: null, lowpassHz: 1800, shimmer: false },
  calm: { progression: [["F", "A", "C"], ["C", "E", "G"], ["D", "F", "A"], ["A#", "D", "F"]], chordSec: 5, octave: 0, beatEverySec: null, lowpassHz: 1600, shimmer: true },
  playful: { progression: [["C", "E", "G"], ["F", "A", "C"], ["G", "B", "D"], ["C", "E", "G"]], chordSec: 2, octave: 0, beatEverySec: 0.5, lowpassHz: 4000, shimmer: false },
  dramatic: { progression: [["A", "C", "E"], ["E", "G#", "B"], ["F", "A", "C"], ["D", "F", "A"]], chordSec: 3, octave: -2, beatEverySec: 1.5, lowpassHz: 2000, shimmer: true },
};

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function chordExpression(notes: string[], octave: number, chordSec: number, detune: number): string {
  const partials = notes.map((note, i) => {
    const f = (NOTE_FREQ[note] ?? 440) * 2 ** octave;
    const amp = (0.22 - i * 0.03).toFixed(3);
    // Two slightly detuned oscillators per note for a warm, chorus-like pad.
    return `${amp}*(sin(2*PI*${f.toFixed(2)}*t)+0.6*sin(2*PI*${(f * (1 + detune)).toFixed(3)}*t))`;
  });
  const bass = `0.18*sin(2*PI*${((NOTE_FREQ[notes[0]!] ?? 220) * 2 ** (octave - 1)).toFixed(2)}*t)`;
  // Smooth attack/release envelope within each chord.
  const envelope = `min(1,t/0.6)*min(1,(${chordSec}-t)/0.8)`;
  return `(${[...partials, bass].join("+")})*${envelope}`;
}

/** Synthesises a music bed of `durationSec` for a mood into `outputPath` (AAC/M4A). */
export async function generateMusicBed(opts: { mood: string; durationSec: number; seed: number; outputPath: string; signal?: AbortSignal }): Promise<void> {
  const profile = MOOD_PROFILES[opts.mood] ?? MOOD_PROFILES.documentary!;
  const random = seededRandom(opts.seed);
  const detune = 0.003 + random() * 0.004;
  const rotation = Math.floor(random() * profile.progression.length);
  const progression = [...profile.progression.slice(rotation), ...profile.progression.slice(0, rotation)];
  const loopSec = progression.length * profile.chordSec;

  const inputs: string[] = [];
  const filterParts: string[] = [];
  progression.forEach((notes, i) => {
    inputs.push("-f", "lavfi", "-i", `aevalsrc=exprs='${chordExpression(notes, profile.octave, profile.chordSec, detune)}':s=44100:d=${profile.chordSec}`);
    filterParts.push(`[${i}:a]`);
  });
  const chain = [`${filterParts.join("")}concat=n=${progression.length}:v=0:a=1[pad]`];
  let mixInputs = "[pad]";
  let mixCount = 1;
  if (profile.beatEverySec) {
    const b = profile.beatEverySec;
    const kick = `0.55*sin(2*PI*(45+90*exp(-mod(t,${b})*28))*mod(t,${b}))*exp(-mod(t,${b})*9)`;
    inputs.push("-f", "lavfi", "-i", `aevalsrc=exprs='${kick}':s=44100:d=${loopSec}`);
    chain.push(`[${progression.length}:a]volume=0.6[kick]`);
    mixInputs += "[kick]";
    mixCount++;
  }
  if (profile.shimmer) {
    inputs.push("-f", "lavfi", "-i", `anoisesrc=d=${loopSec}:c=pink:a=0.05:seed=${opts.seed % 100000}`);
    chain.push(`[${inputs.filter((x) => x === "-i").length - 1}:a]highpass=f=5000,lowpass=f=9000,volume=0.25[air]`);
    mixInputs += "[air]";
    mixCount++;
  }
  chain.push(
    `${mixInputs}amix=inputs=${mixCount}:normalize=0,lowpass=f=${profile.lowpassHz},aecho=0.8:0.7:60|120:0.25|0.15,` +
      `aloop=loop=-1:size=${Math.round(loopSec * 44100)},atrim=0:${opts.durationSec.toFixed(2)},` +
      `afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, opts.durationSec - 2).toFixed(2)}:d=2,` +
      `pan=stereo|c0=c0|c1=c0,loudnorm=I=-18:TP=-2:LRA=9[out]`,
  );

  await ffmpeg(
    [...inputs, "-filter_complex", chain.join(";"), "-map", "[out]", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", opts.outputPath],
    { timeoutMs: 180_000, signal: opts.signal },
  );
}

export const SFX_TYPES = ["whoosh", "impact", "riser", "click"] as const;
export type SfxType = (typeof SFX_TYPES)[number];

/** Synthesises a short sound effect into `outputPath` (WAV). */
export async function generateSfx(opts: { type: SfxType; seed: number; outputPath: string; signal?: AbortSignal }): Promise<void> {
  const random = seededRandom(opts.seed);
  let source: string;
  let filter: string;
  switch (opts.type) {
    case "whoosh": {
      const d = (0.45 + random() * 0.25).toFixed(2);
      source = `anoisesrc=d=${d}:c=pink:a=0.9:seed=${opts.seed % 100000}`;
      filter = `bandpass=f=${Math.round(900 + random() * 900)}:width_type=o:w=2,afade=t=in:d=${(Number(d) * 0.6).toFixed(2)},afade=t=out:st=${(Number(d) * 0.6).toFixed(2)}:d=${(Number(d) * 0.4).toFixed(2)},volume=2.5`;
      break;
    }
    case "impact": {
      const f = Math.round(48 + random() * 20);
      source = `aevalsrc=exprs='0.9*sin(2*PI*(${f}+120*exp(-t*18))*t)*exp(-t*5)+0.25*(random(0)-0.5)*exp(-t*25)':s=44100:d=1.2`;
      filter = "lowpass=f=1800,volume=1.4";
      break;
    }
    case "riser": {
      const d = (1.0 + random() * 0.6).toFixed(2);
      source = `aevalsrc=exprs='0.35*sin(2*PI*(180*t+260*t*t/${d})*1)*(t/${d})':s=44100:d=${d}`;
      filter = `afade=t=out:st=${(Number(d) - 0.1).toFixed(2)}:d=0.1,aecho=0.6:0.5:40:0.3`;
      break;
    }
    case "click": {
      source = "aevalsrc=exprs='0.8*sin(2*PI*2200*t)*exp(-t*300)':s=44100:d=0.08";
      filter = "highpass=f=800";
      break;
    }
  }
  await ffmpeg(["-f", "lavfi", "-i", source, "-af", `${filter},pan=stereo|c0=c0|c1=c0`, "-ar", "48000", opts.outputPath], {
    timeoutMs: 60_000,
    signal: opts.signal,
  });
}
