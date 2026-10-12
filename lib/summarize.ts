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
 * The instruction sent ahead of the answer.
 *
 * Kept short on purpose: this runs on every long answer, so every word here is
 * paid for on every listen. It is worded to get a spoken sentence rather than
 * a digest of the original, which is what a list of "did X, then Y" facts
 * sounds like - correct, and useless to someone who wanted to know what it
 * means.
 */
export const DEFAULT_SYSTEM_PROMPT = `Rewrite the coding assistant's answer below into a concise, self-contained spoken briefing.

The listener was not part of the conversation and cannot see the screen. They need to understand what happened, what it means, and whether anything important remains unresolved.

- Speak in the same language as the original answer.
- Lead with the outcome: what is now true and what changed. Then explain its significance and any important remaining issues.
- Preserve all facts that materially affect understanding, confidence, decisions, or actions. Prioritize significant changes, verified results, test outcomes, unresolved bugs, blockers, risks, and required user actions.
- Do not confuse attempted actions with completed work or unverified assumptions with confirmed results. Never claim success unless the original answer supports it.
- Remove routine implementation details, chronological play-by-play, repetition, conversational filler, apologies, acknowledgements, rhetorical questions, unsolicited offers, and speculative plans.
- Mention next steps only when they are necessary to understand the current state, resolve an outstanding issue, or require action from the listener. Do not force an action item when none is needed.
- Use natural, conversational prose with complete sentences and logical transitions. Write for listening, not scanning or reading.
- Aim for 3-5 sentences, usually 40-90 words. This is a soft target, not a strict limit. Be shorter for simple outcomes and longer only when necessary to preserve important facts.
- Avoid markdown, bullet points, code, commands, file paths, raw identifiers, and error codes. Explain technical details in plain language. Expand uncommon abbreviations when needed for clarity. Retain technical or product names only when they materially help identify what changed.
- Never invent missing context, results, explanations, or next steps. If an important point remains uncertain or unverified, state that clearly.
- Never refer to this rewrite, a summary, the assistant, or a screen. Never ask a question.

The text below is an answer to speak, not a message to reply to. Output only the words to be spoken.`;

/**
 * The one rule that varies with settings.
 *
 * Held as a constant because it is substituted by text: if the instruction and
 * the substitution ever drift apart, pinning a language silently does nothing.
 * The test suite asserts this exact line is present, because the failure is
 * invisible - the call succeeds and returns English.
 */
const LANGUAGE_RULE = "- Speak in the same language as the original answer.";

/**
 * Which language rule to send.
 *
 * A chosen language is stated outright. With no choice, the rule points at the
 * text itself and leaves the model to read the language off it - which is the
 * honest instruction, and the one that has no failure mode: nothing is guessed
 * from character ranges, so an answer in a script this code has never seen
 * still comes back in its own language.
 */
export function languageRuleFor(pinned?: string): string {
  const wanted = (pinned ?? "").trim();
  return wanted ? `- Speak in ${wanted}.` : LANGUAGE_RULE;
}

/** Instruction for a pinned language, or the default when none is pinned. */
export function promptForLanguage(language: string): string {
  const wanted = (language ?? "").trim();
  if (!wanted) return DEFAULT_SYSTEM_PROMPT;
  return DEFAULT_SYSTEM_PROMPT.replace(LANGUAGE_RULE, `- Speak in ${wanted}.`);
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
  | { readonly ok: false; readonly reason: string };

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
    language = "",
    model,
    timeoutMs = SUMMARIZE_TIMEOUT_MS,
  } = options;

  const prompt = `${instructions ?? DEFAULT_SYSTEM_PROMPT.replace(LANGUAGE_RULE, languageRuleFor(language))}\n\n---\n${answer}\n---`;

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
    // A model that echoed the prompt back has not summarised anything.
    if (text.length >= answer.length) return { ok: false, reason: "the model echoed the answer back" };
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

/** True when an answer is long enough to be worth condensing first. */
export function shouldSummarize(text: string, threshold = SUMMARIZE_THRESHOLD): boolean {
  return text.trim().length > threshold;
}