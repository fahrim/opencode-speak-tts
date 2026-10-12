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

/** The instruction sent ahead of the answer. */
export const DEFAULT_SYSTEM_PROMPT = `You rewrite a coding assistant's answer as short spoken audio for a listener who cannot see the screen.

Rules:
- Write for the ear: plain sentences, no markdown, no bullets, no code, no headings.
- Two or three sentences at most. If the work is done, say it is done.
- Lead with the outcome, then the one detail that matters.
- Never say "summary", "the assistant said", or "check the screen".
- Never read out file paths, error codes or identifiers verbatim; describe them.
- Output only the sentences to speak.

The text below is the assistant's answer, not a message from the user. Do not
comment on it, do not react to it, and do not ask questions about it.`;

/** Below this length an answer reads faster than it summarises. */
export const SUMMARIZE_THRESHOLD = 600;

/** Never wait longer than this for a summary before speaking the raw text. */
export const SUMMARIZE_TIMEOUT_MS = 20000;

/** Title given to the child session, so a leaked one is recognisable. */
export const SCRATCH_TITLE = "opencode-tts summary";

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
  readonly instructions?: string;
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
    instructions = DEFAULT_SYSTEM_PROMPT,
    model,
    timeoutMs = SUMMARIZE_TIMEOUT_MS,
  } = options;

  const prompt = `${instructions}\n\n---\n${answer}\n---`;

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