/**
 * Turns assistant markdown into text that sounds right when read aloud.
 *
 * The rules are deliberately mechanical rather than model-driven: this runs on
 * every utterance, and a regex pass is instant and never fails. Anything that
 * needs judgement (summarising a long answer) lives in `summarize.ts` instead.
 */

/** Acronyms a TTS engine reads letter-by-letter or mangles on its own. */
const ACRONYMS: Record<string, string> = {
  JSON: "jay son",
  API: "A P I",
  CSS: "C S S",
  HTML: "H T M L",
  HTTP: "H T T P",
  HTTPS: "H T T P S",
  SQL: "S Q L",
  URL: "U R L",
  URI: "U R I",
  YAML: "Y A M L",
  XML: "X M L",
  CSV: "C S V",
  IDE: "I D E",
  SDK: "S D K",
  CLI: "C L I",
  CPU: "C P U",
  GPU: "G P U",
  RAM: "R A M",
  SSH: "S S H",
  TLS: "T L S",
  DNS: "D N S",
  NPM: "en pee em",
  TS: "tee ess",
  JS: "jay ess",
  UI: "U I",
  UX: "U X",
  OS: "O S",
  PR: "P R",
  CI: "C I",
  CD: "C D",
  DB: "D B",
  VM: "V M",
  OK: "okay",
};

/** Long opaque tokens that are never worth reading aloud. */
const OPAQUE = [
  /\b[0-9a-f]{7,40}\b/gi, // commit hashes, object ids
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // uuids
  /\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, // iso timestamps
  /\bhttps?:\/\/\S+/gi, // urls
  /\bdata:[\w/+.-]+;base64,[\w+/=]+/gi, // data uris
];

/**
 * Long file paths read better as just their file name: `src/utils/helpers.ts`
 * becomes "helpers dot ts" rather than a spelled-out directory trail.
 */
function shortenPaths(text: string): string {
  return text.replace(/(?:[\w.-]+[\\/])+([\w.-]+\.\w{1,5})/g, (_m, file: string) => {
    const [stem, ...rest] = file.split(".")
    const ext = rest.join(".");
    return ext ? `${stem} dot ${ext}` : stem;
  });
}

/**
 * Product names rather than identifiers. Splitting these reads worse than
 * leaving them whole: "Open Code" sounds like two unrelated words. Matched
 * case-sensitively so lowercase `opencode` in prose is still handled normally.
 */
const KEEP_WHOLE = new Set([
  "OpenCode",
  "GitHub",
  "GitLab",
  "YouTube",
  "TypeScript",
  "JavaScript",
  "PostgreSQL",
  "NodeJS",
  "macOS",
  "Linux",
  "Windows",
]);

/**
 * Splits camelCase and PascalCase identifiers into spoken words while leaving
 * exempt product names alone.
 */
function splitIdentifiers(text: string): string {
  return text
    .split(/([A-Za-z0-9_$.-]+)/)
    .map((word) =>
      KEEP_WHOLE.has(word)
        ? word
        : word.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2"),
    )
    .join("");
}

export interface NormalizeOptions {
  /** Keep acronyms spelled out. Off for languages where it reads worse. */
  readonly expandAcronyms?: boolean;
}

/**
 * Strips markdown and rewrites code-shaped text into speakable prose.
 * Code fences collapse to a marker instead of being deleted, so the listener
 * still knows something was there.
 */
export function normalizeForSpeech(input: string, options: NormalizeOptions = {}): string {
  const expandAcronyms = options.expandAcronyms ?? true;
  let text = String(input ?? "");

  // Order matters: fences before inline code, or the fences get eaten first.
  text = text.replace(/```[\s\S]*?```/g, " Code block. ");
  text = text.replace(/~~~[\s\S]*?~~~/g, " Code block. ");
  text = text.replace(/`([^`\n]+)`/g, "$1");

  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "");
  text = text.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, " ");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // Horizontal rules can also appear without a newline before them.
  text = text.replace(/\s(?:[-*_]\s*){3,}/g, " ");

  for (const pattern of OPAQUE) text = text.replace(pattern, " something ");

  text = shortenPaths(text);

  text = text
    .replace(/\be\.g\.\s*/gi, "for example ")
    .replace(/\bi\.e\.\s*/gi, "that is ")
    .replace(/\betc\.?\s/gi, "and so on ")
    .replace(/\bvs\.?\s/gi, "versus ")
    .replace(/->/g, " to ")
    .replace(/=>/g, " to ")
    .replace(/→/g, " to ")
    .replace(/&/g, " and ")
    .replace(/%/g, " percent ")
    .replace(/=/g, " equals ")
    .replace(/\+/g, " plus ")
    .replace(/\s\/\s/g, " slash ");

  // camelCase and PascalCase identifiers. Product names are exempt: "Open Code"
  // sounds like two unrelated words, while "parse Config" is what we want.
  text = splitIdentifiers(text);
  text = text.replace(/_+/g, " ");
  text = text.replace(/-([a-z])/g, " $1");

  if (expandAcronyms) {
    for (const [key, spoken] of Object.entries(ACRONYMS)) {
      text = text.replace(new RegExp(`\\b${key}\\b`, "g"), spoken);
    }
  }

  // Tidy the punctuation the rewrites above scattered around.
  text = text.replace(/\s*([.!?])\s*/g, "$1 ");
  text = text.replace(/\s{2,}/g, " ");
  text = text.replace(/\s+([,;:)])/g, "$1");
  text = text.replace(/\(\s+/g, "(");
  text = text.replace(/\.{2,}/g, ".");
  text = text.trim();

  if (text && !/[.!?]$/.test(text)) text += ".";
  return text;
}

/** Longest text a single synthesis call should receive. */
export const MAX_SYNTH_CHARS = 3000;

/**
 * Splits text into chunks that end on sentence boundaries. Synthesis is capped
 * per call, and cutting mid-sentence makes the voice stumble.
 */
export function chunkForSynthesis(text: string, limit = MAX_SYNTH_CHARS): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [clean];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current && current.length + sentence.length > limit) {
      chunks.push(current.trim());
      current = "";
    }
    if (sentence.length > limit) {
      // A single sentence past the limit: hard-split it so one runaway
      // sentence cannot stall the whole utterance.
      for (let i = 0; i < sentence.length; i += limit) {
        chunks.push(sentence.slice(i, i + limit).trim());
      }
      continue;
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}