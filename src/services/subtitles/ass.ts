import type { SubtitleStyle } from "@/config/templates";
import { estimateTextWidth, type Cue } from "./cues";

/**
 * Advanced SubStation Alpha (ASS) renderer for burned-in Shorts subtitles.
 *
 * - Large, high-contrast text with outline and shadow for mobile readability.
 * - Positioned in the safe area (above the Shorts UI overlay at the bottom).
 * - Animations: "pop" (scale-in), "fade", or none.
 * - Emphasis: the currently spoken word is highlighted (karaoke style).
 */
const VIDEO_WIDTH = 1080;
const VIDEO_HEIGHT = 1920;

/** "#RRGGBB" -> ASS "&H00BBGGRR" */
export function assColor(hex: string, alpha = 0): string {
  const value = hex.replace("#", "");
  const r = value.slice(0, 2);
  const g = value.slice(2, 4);
  const b = value.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}`.toUpperCase();
}

export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Escapes override-block characters so script text can never inject ASS tags. */
export function escapeAssText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");
}

function alignmentFor(position: SubtitleStyle["position"]): number {
  // ASS numpad alignment: 2 = bottom centre, 5 = middle centre, 8 = top centre
  return position === "upper" ? 8 : position === "center" ? 5 : 2;
}

function header(style: SubtitleStyle): string {
  const bold = style.bold ? -1 : 0;
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${VIDEO_WIDTH}`,
    `PlayResY: ${VIDEO_HEIGHT}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${style.font},${style.fontSize},${assColor(style.primaryColor)},${assColor(style.highlightColor)},${assColor(style.outlineColor)},${assColor("#000000", 0x60)},${bold},0,0,0,100,100,1,0,1,${style.outlineWidth},${style.shadow},${alignmentFor(style.position)},70,70,${style.position === "center" ? 0 : style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");
}

function positionTag(style: SubtitleStyle): string {
  if (style.position !== "center") return "";
  // Centre alignment ignores MarginV, so place explicitly (slightly below middle).
  const y = Math.round(VIDEO_HEIGHT / 2 + (style.marginV - 420));
  return `\\pos(${VIDEO_WIDTH / 2},${y})`;
}

function animationTag(style: SubtitleStyle, isFirstWordEvent: boolean): string {
  if (style.animation === "pop" && isFirstWordEvent) return "\\fscx78\\fscy78\\t(0,90,\\fscx108\\fscy108)\\t(90,150,\\fscx100\\fscy100)";
  if (style.animation === "fade" && isFirstWordEvent) return "\\fad(140,0)";
  return "";
}

function formatWord(text: string, style: SubtitleStyle): string {
  return escapeAssText(style.uppercase ? text.toUpperCase() : text);
}

/** Horizontal/vertical scale (percent) that makes a line fit the safe width. */
function lineScale(line: string[], style: SubtitleStyle): number {
  const width = estimateTextWidth(line.join(" "), style);
  const max = VIDEO_WIDTH - 140;
  return width <= max ? 100 : Math.max(55, Math.floor((max / width) * 100));
}

function cueText(cue: Cue, style: SubtitleStyle, activeIndex: number | null): string {
  let wordIndex = 0;
  return cue.lines
    .map((line) => {
      const scale = lineScale(line, style);
      const base = scale === 100 ? "" : `{\\fscx${scale}\\fscy${scale}}`;
      const words = line.map((word) => {
        const formatted = formatWord(word, style);
        const isActive = activeIndex === wordIndex++;
        if (!isActive || style.emphasis === "none") return formatted;
        const popScale = style.animation === "pop" ? Math.round(scale * 1.12) : scale;
        return `{\\c${assColor(style.highlightColor)}\\fscx${popScale}\\fscy${popScale}}${formatted}{\\c${assColor(style.primaryColor)}\\fscx${scale}\\fscy${scale}}`;
      });
      return base + words.join(" ");
    })
    .join("\\N");
}

export function renderAss(cues: Cue[], style: SubtitleStyle): string {
  const events: string[] = [];
  const pos = positionTag(style);
  for (const cue of cues) {
    if (style.emphasis === "highlight-word" && cue.words.length > 1) {
      cue.words.forEach((word, i) => {
        const start = i === 0 ? cue.start : word.start;
        const next = cue.words[i + 1];
        const end = next ? next.start : cue.end;
        if (end - start < 0.01) return;
        const tags = `{${pos}${animationTag(style, i === 0)}}`;
        events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${tags}${cueText(cue, style, i)}`);
      });
    } else {
      const tags = `{${pos}${animationTag(style, true)}}`;
      events.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${tags}${cueText(cue, style, null)}`);
    }
  }
  return `${header(style)}\n${events.join("\n")}\n`;
}
