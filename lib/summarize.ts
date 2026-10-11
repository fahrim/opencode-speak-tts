/**
 * Optional summarisation for long answers.
 *
 * The call goes through OpenCode's own `session.generate`, so it uses whatever
 * model and credentials the user already has connected. There is no second API
 * key to configure and no extra account.
 */

export const DEFAULT_SYSTEM_PROMPT = `You rewrite a coding assistant's answer as short spoken audio for a listener who cannot see the screen.

Rules:
- Write for the ear: plain sentences, no markdown, no bullets, no code, no headings.
- Two or three sentences at most. If the work is done, say it is done.
- Lead with the outcome, then the one detail that matters.
- Never say "summary", "the assistant said", or "check the screen".
- Never read out file paths, error codes or identifiers verbatim; describe them.
- Output only the sentences to speak.`;

/** Below this length an answer reads faster than it summarises. */
export const SUMMARIZE_THRESHOLD = 600;

/** Never wait longer than this for a summary before speaking the raw text. */
export const SUMMARIZE_TIMEOUT_MS = 20000;

export interface GenerateOptions {
  readonly sessionID: string;
  readonly prompt: string;
  readonly system?: string;
  readonly timeoutMs?: number;
}

/**
 * Minimal shape of the client surface used here. Kept structural so the module
 * can be tested without an OpenCode instance.
 */
export interface GenerateClient {
  session: {
    generate(
      input: { sessionID: string; prompt: string; system?: string },
      options?: { signal?: AbortSignal },
    ): Promise<{ data?: { text?: string }; text?: string }>;
  };
}

function extractText(result: unknown): string {
  const r = result as { data?: { text?: string }; text?: string };
  return String(r?.data?.text ?? r?.text ?? "").trim();
}

/**
 * Asks the session's model to condense `text` into something speakable.
 * Returns null on any failure so the caller can fall back to reading the
 * original — a summary is an improvement, never a requirement.
 */
export async function summarizeForSpeech(
  client: GenerateClient,
  options: GenerateOptions,
): Promise<string | null> {
  const { sessionID, prompt, system = DEFAULT_SYSTEM_PROMPT, timeoutMs = SUMMARIZE_TIMEOUT_MS } = options;

  try {
    const result = await client.session.generate(
      { sessionID, prompt, system },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    const text = extractText(result);
    if (!text || text.length < 2) return null;
    // A model that echoed the prompt back has not summarised anything.
    if (text.length >= prompt.length) return null;
    return text;
  } catch {
    return null;
  }
}

/** True when an answer is long enough to be worth condensing first. */
export function shouldSummarize(text: string, threshold = SUMMARIZE_THRESHOLD): boolean {
  return text.trim().length > threshold;
}