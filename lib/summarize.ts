/**
 * Optional summarisation for long answers.
 *
 * The call goes through OpenCode's own `generate.text`, so it uses whatever
 * model and credentials the user already has connected. There is no second API
 * key to configure and no extra account.
 *
 * `generate.text` rather than `session.generate` on purpose. The latter writes
 * the request and the reply into the conversation, which meant every listen
 * left two messages behind and the next summarisation saw its own previous
 * summary as a pasted user turn. This one is stateless.
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

/** Parses `provider/model` into the shape the client expects. */
export function parseModel(
  value: string,
): { providerID: string; id: string } | undefined {
  const trimmed = value?.trim() ?? "";
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0 || cut === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, cut), id: trimmed.slice(cut + 1) };
}

export interface SummarizeOptions {
  readonly answer: string;
  readonly instructions?: string;
  /** `provider/model`; omitted means the user's default model. */
  readonly model?: string;
  readonly timeoutMs?: number;
}

/**
 * Minimal shape of the client surface used here. Kept structural so the module
 * can be tested without an OpenCode instance.
 */
export interface GenerateClient {
  generate: {
    text(
      input: { prompt: string; model?: { providerID: string; id: string } },
      options?: { signal?: AbortSignal },
    ): Promise<{ data?: { text?: string }; text?: string }>;
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
    instructions = DEFAULT_SYSTEM_PROMPT,
    model,
    timeoutMs = SUMMARIZE_TIMEOUT_MS,
  } = options;

  const prompt = `${instructions}\n\n---\n${answer}\n---`;
  const parsed = parseModel(model ?? "");

  let result: unknown;
  try {
    result = await client.generate.text(
      parsed ? { prompt, model: parsed } : { prompt },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: shorten(reason) };
  }

  const text = extractText(result);
  if (!text || text.length < 2) return { ok: false, reason: "the model returned nothing" };
  // A model that echoed the prompt back has not summarised anything.
  if (text.length >= answer.length) return { ok: false, reason: "the model echoed the answer back" };
  return { ok: true, text };
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