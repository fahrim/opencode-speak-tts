/**
 * Optional summarisation for long answers.
 *
 * The call goes through OpenCode's own session API, so it uses whatever model
 * and credentials the user already has connected. There is no second API key to
 * configure and no extra account.
 *
 * It runs in a throwaway child session rather than the current one, because
 * `session.generate` writes both the request and the reply into the
 * conversation it is given. Doing that to the live session meant every listen
 * left two messages behind, and the next summarisation saw its own previous
 * summary as a pasted user turn.
 *
 * The stateless `generate.text` endpoint would avoid the pollution entirely,
 * but it rejects the free tier with "OpenCode's free tier can only be used
 * from within OpenCode". A child session is a real session, so it passes.
 */

/**
 * The one line every style carries, and the one that varies with settings.
 *
 * Held as a constant because it is substituted by text: if the instruction and
 * the substitution ever drift apart, pinning a language silently does nothing.
 * The test suite asserts this exact line is present, because the failure is
 * invisible - the call succeeds and returns English.
 */
const LANGUAGE_RULE = "- Speak in the same language as the original answer.";

/** Opening line, identical for every style: the job, not the judgement. */
const PROMPT_HEADER =
  "Rewrite the coding assistant's answer below into a concise, self-contained spoken briefing.";

/** Closing line, identical for every style: the answer is to be spoken. */
const PROMPT_FOOTER =
  "The text below is an answer to speak, not a message to reply to. Output only the words to be spoken.";

/**
 * The rules every style keeps, worded once.
 *
 * The styles were written at different times and disagreed about what to
 * discard, but they still agreed about these. Holding them in one place means a
 * rule fixed for one style is fixed for all of them; a shared rule copied into
 * two prompt strings is a rule that gets edited once and then drifts, and the
 * failure is invisible - the summary still comes back, just wrong.
 *
 * Only what genuinely differs between styles is left out. The length target
 * appears here as "soft", because that is common; the numbers each style aims
 * for live with the style.
 */
const SHARED_RULES = [
  LANGUAGE_RULE,
  "- Put the point first: the listener should hear what matters most before any background, history, or detail.",
  "- Preserve all facts that materially affect understanding, confidence, decisions, or actions. Prioritize significant changes, verified results, test outcomes, unresolved bugs, blockers, risks, and required user actions.",
  "- Avoid markdown, bullet points, code, commands, file paths, raw identifiers, and error codes. Explain technical details in plain language, expanding an uncommon abbreviation when it would otherwise be unclear.",
  "- Length is a soft target, not a strict limit: go shorter for a simple outcome, and longer whenever keeping it short would cost a fact.",
  "- The result must still be shorter than the text it condenses. If what you wrote is nearly as long as the original, you have not summarised it: say the essentials in fewer words rather than restating the whole thing.",
  "- Never refer to this rewrite, a summary, the assistant, or a screen. Never ask a question.",
].join("\n");

/** Identifies a named instruction. */
export type SummaryStyleId = "default" | "explain" | "actions" | "headlines";

/**
 * One named instruction: what it keeps that the shared set does not cover.
 *
 * The name is character, not length. "Short" or "brief" would say how much to
 * cut, which the model already controls, and say nothing about the choice that
 * actually differs between styles - what is worth keeping, and how far to
 * explain it rather than compress it.
 */
export interface SummaryStyle {
  readonly id: SummaryStyleId;
  /** Shown in the picker and the summary modal. */
  readonly name: string;
  /** One line on what it changes, for the picker. */
  readonly description: string;
  /** Who is listening and what they want, in this style's own words. */
  readonly framing: string;
  /** Style-only rules, appended after the shared ones. */
  readonly rules: string;
}

export const SUMMARY_STYLES: readonly SummaryStyle[] = [
  {
    id: "default",
    name: "Default",
    description: "A full briefing: the outcome, its significance, and what remains unresolved.",
    framing:
      "The listener was not part of the conversation and cannot see the screen. They need to understand what happened, what it means, and whether anything important remains unresolved.",
    rules: [
      "- Lead with the outcome: what is now true and what changed, then explain its significance and any important remaining issues.",
      "- Do not confuse attempted actions with completed work or unverified assumptions with confirmed results. Never claim success unless the original answer supports it.",
      "- Remove routine implementation details, chronological play-by-play, repetition, conversational filler, apologies, acknowledgements, rhetorical questions, unsolicited offers, and speculative plans.",
      "- Mention next steps only when they are necessary to understand the current state, resolve an outstanding issue, or require action from the listener. Do not force an action item when none is needed.",
      "- Use natural, conversational prose with complete sentences and logical transitions. Write for listening, not scanning or reading.",
      "- Aim for 3-5 sentences, usually 40-90 words. Be shorter for simple outcomes and longer only when necessary to preserve important facts.",
      "- Never invent missing context, results, explanations, or next steps. If an important point remains uncertain or unverified, state that clearly.",
    ].join("\n"),
  },
  {
    id: "explain",
    name: "Explain",
    description: "One step simpler than the answer: keeps the assistant's ideas, explains what matters.",
    framing:
      "The listener cannot see the screen, was not part of the exchange, and has no prior context. They want the bottom line first, and the wording plain enough to follow by ear.",
    rules: [
      "- Lead with the bottom line, then unpack it in plain words.",
      "- Explain rather than condense. Say why something matters, not how it was built. Where the answer is dense, restate it plainly.",
      '- Keep any idea the assistant proposes, even in passing: an alternative approach, something worth doing next, a better way to do it. Drop only the empty kind - "let me know if", "would you like me to", "feel free to ask".',
      "- Leave out what is not about the work: apologies, acknowledgements, questions, and a narration of the steps taken.",
      "- Keep a technical name when the listener would need it to act, but say what it is in ordinary words the first time.",
    ].join("\n"),
  },
  {
    id: "actions",
    name: "Actions",
    description: "Leads with what you have to do, and says plainly when nothing is needed.",
    framing:
      "The listener is about to act and wants to know what is required of them. They are not catching up on the work; they need the next move, or a clear statement that there is none.",
    rules: [
      "- Start with what the listener has to do, in the order it has to happen. If nothing is required of them, say that in the first sentence and stop.",
      "- Keep only what the action needs: where, what to check, and any blocker that stops it. Drop how it was built, its significance, and any idea that does not change the action.",
      "- Only what the answer presents as required, or an unmistakable next step, is an action. Never turn a passing suggestion into a task.",
      "- Say whose move it is when it is not the listener's: a command to run, a page to open, or a decision only they can make.",
      "- Aim for 2-4 sentences; most answers need only one or two.",
    ].join("\n"),
  },
  {
    id: "headlines",
    name: "Headlines",
    description: "Just the results, three to five words each, like scanning them by ear.",
    framing:
      "The listener wants to scan the result by ear, not sit through an explanation. They already know the context and will read the detail if they need it, so they want only the headlines - enough to tell at a glance what changed.",
    rules: [
      "- Give each thing that happened as one short sentence of three to five words, and put them one after another. For example: 'Tests pass. Two files changed. One bug left.'",
      "- Headline the few outcomes that matter and let the rest go: no explanation, no significance, no background, no next steps. This tone trades completeness for speed on purpose.",
      "- No lead-in and no connecting prose. Start at the first result and stop after the last.",
      "- A genuine blocker, failure, or unfinished piece is its own headline. A scan that hides the problem is worse than no scan at all.",
    ].join("\n"),
  },
];

export const DEFAULT_SUMMARY_STYLE: SummaryStyleId = "default";

/** Finds a style by id, falling back to the default for an unknown or blank one. */
export function resolveSummaryStyle(id?: string): SummaryStyle {
  const wanted = typeof id === "string" ? id.trim() : "";
  return (
    SUMMARY_STYLES.find((style) => style.id === wanted) ??
    (SUMMARY_STYLES.find((style) => style.id === DEFAULT_SUMMARY_STYLE) as SummaryStyle)
  );
}

/** Assembles one style's instruction, with the language rule left for substitution. */
function assemble(style: SummaryStyle): string {
  return [PROMPT_HEADER, style.framing, SHARED_RULES, style.rules, PROMPT_FOOTER].join("\n\n");
}

/**
 * The instruction to send for a style, with the spoken language pinned when one
 * is set.
 *
 * An empty language leaves the rule pointing at the text itself and lets the
 * model read the language off it - the honest instruction, and the one with no
 * failure mode: nothing is guessed from character ranges, so an answer in a
 * script this code has never seen still comes back in its own language.
 */
export function systemPromptFor(style?: string, language = ""): string {
  const wanted = (language ?? "").trim();
  const rule = wanted ? `- Speak in ${wanted}.` : LANGUAGE_RULE;
  return assemble(resolveSummaryStyle(style)).replace(LANGUAGE_RULE, rule);
}

/** The default style's instruction, with no language pinned. */
export const DEFAULT_SYSTEM_PROMPT = systemPromptFor(DEFAULT_SUMMARY_STYLE);

/** The rule to send for a pinned language, or the neutral one when none is set. */
export function languageRuleFor(pinned?: string): string {
  const wanted = (pinned ?? "").trim();
  return wanted ? `- Speak in ${wanted}.` : LANGUAGE_RULE;
}

/** Instruction for a pinned language in the default style, or the default. */
export function promptForLanguage(language: string): string {
  return systemPromptFor(DEFAULT_SUMMARY_STYLE, language);
}

/** Below this length an answer reads faster than it summarises. */
export const SUMMARIZE_THRESHOLD = 600;

/** Never wait longer than this for a summary before speaking the raw text. */
export const SUMMARIZE_TIMEOUT_MS = 20000;

/** Title given to the child session, so a leaked one is recognisable. */
export const SCRATCH_TITLE = "opencode-speak-tts summary";

/** A model reference, including the reasoning-effort variant when there is one. */
export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

/** Parses a stored `provider/model` setting. Variants are chosen separately. */
export function parseModel(
  value: string,
): { providerID: string; id: string } | undefined {
  const trimmed = value?.trim() ?? "";
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0 || cut === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, cut), id: trimmed.slice(cut + 1) };
}

/**
 * Builds a reference from the route's current model.
 *
 * The variant matters as much as the id: models expose reasoning efforts
 * (low/medium/high/xhigh/max) and dropping one silently turns a deliberate
 * choice into the default effort.
 */
export function modelRef(
  current: { providerID?: string; modelID?: string; id?: string; variant?: string } | null | undefined,
): ModelRef | undefined {
  if (!current) return undefined;
  const id = current.modelID ?? current.id;
  if (!current.providerID || !id) return undefined;
  return {
    providerID: current.providerID,
    id,
    ...(current.variant ? { variant: current.variant } : {}),
  };
}

export interface SummarizeOptions {
  readonly answer: string;
  /** The session the answer came from; the child hangs off it. */
  readonly parentID?: string;
  /** Overrides the default instructions entirely. */
  readonly instructions?: string;
  /** Named instruction to use; unknown or omitted means the default style. */
  readonly style?: string;
  /** `""` means "speak the answer's own language". */
  readonly language?: string;
  /** Omitted means the child inherits whatever the parent session uses. */
  readonly model?: ModelRef;
  readonly timeoutMs?: number;
}

/**
 * Minimal shape of the client surface used here. Kept structural so the module
 * can be tested without an OpenCode instance.
 */
export interface GenerateClient {
  session: {
    create(input: {
      parentID?: string;
      title?: string;
      model?: { providerID: string; id: string };
    }): Promise<{ id?: string; sessionID?: string }>;
    generate(input: { sessionID: string; prompt: string }): Promise<{ data?: { text?: string }; text?: string }>;
    remove(input: { sessionID: string }): Promise<void>;
  };
}

function extractText(result: unknown): string {
  const r = result as { data?: { text?: string }; text?: string };
  return String(r?.data?.text ?? r?.text ?? "").trim();
}

/**
 * Outcome of a summarisation attempt.
 *
 * The failure reason is carried rather than discarded: a summary that silently
 * never appears looks identical to a feature that is switched off, and the
 * user cannot tell whether to change a setting or report a bug.
 */
export type SummaryResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: string;
      /**
       * Extra detail for the log, never the toast. Carries the numbers and a
       * snippet needed to tell a model that cannot condense from one that
       * echoed, without putting a wall of text in front of the user.
       */
      readonly detail?: string;
    };

/**
 * Asks a model to condense `answer` into something speakable.
 * Never throws: a summary is an improvement, never a requirement, so every
 * failure comes back as a reason the caller can report.
 */
export async function summarizeForSpeech(
  client: GenerateClient,
  options: SummarizeOptions,
): Promise<SummaryResult> {
  const {
    answer,
    parentID,
    instructions,
    style,
    language = "",
    model,
    timeoutMs = SUMMARIZE_TIMEOUT_MS,
  } = options;

  const prompt = `${instructions ?? systemPromptFor(style, language)}\n\n---\n${answer}\n---`;

  let childID: string | undefined;
  try {
    const child = await client.session.create({
      ...(parentID ? { parentID } : {}),
      title: SCRATCH_TITLE,
      ...(model ? { model } : {}),
    });
    childID = child?.id ?? child?.sessionID;
    if (!childID) return { ok: false, reason: "could not open a session to summarise in" };

    const result = await client.session.generate({ sessionID: childID, prompt });
    const text = extractText(result);
    if (!text || text.length < 2) return { ok: false, reason: "the model returned nothing" };
    // A model that echoed its input back has not summarised anything.
    if (looksEchoed(answer, text)) {
      return {
        ok: false,
        reason: "the model echoed the answer back",
        detail:
          `returned ${text.length} chars for a ${answer.length}-char answer; ` +
          `starts: ${collapse(text).slice(0, 180)}`,
      };
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: shorten(err instanceof Error ? err.message : String(err)) };
  } finally {
    // The child is scratch space. Leaving it behind would fill the session
    // list with one entry per listen.
    if (childID) {
      try {
        await client.session.remove({ sessionID: childID });
      } catch {
        // A leaked child is untidy, not broken. Never fail the summary over it.
      }
    }
  }
}

/** Keeps a failure reason to something that fits in a toast. */
function shorten(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

/** Whitespace-collapsed text, for comparing an answer with the model's reply. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * True when the model repeated its input instead of condensing it.
 *
 * A length comparison alone is the wrong test: a short answer can be honestly
 * expanded into a normal-length summary, and rejecting that threw away good
 * summaries whenever the answer was brief. The reliable signal is the answer
 * coming back verbatim; the length comparison stays only for a long answer,
 * where a real summary must be shorter than the text it condenses.
 */
function looksEchoed(answer: string, text: string): boolean {
  const a = collapse(answer);
  if (!a) return false;
  if (collapse(text).includes(a)) return true;
  return a.length > SUMMARIZE_THRESHOLD && text.length >= answer.length;
}

/** True when an answer is long enough to be worth condensing first. */
export function shouldSummarize(text: string, threshold = SUMMARIZE_THRESHOLD): boolean {
  return text.trim().length > threshold;
}