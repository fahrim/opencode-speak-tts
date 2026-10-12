/**
 * Speaking speed for a summary, as a multiplier over the normal rate.
 *
 * Kept as a multiplier ("1.5") rather than the rate string an engine wants
 * ("+50%") because the control is a set of named steps, not free percentages,
 * and a multiplier is what the listener is actually choosing: half speed,
 * normal, double. The conversion to the engine's format lives here so the two
 * can never drift, and so the offered steps have exactly one source.
 */

/** The speeds the picker offers, in the order it shows them. */
export const SPEED_OPTIONS = ["0.5", "0.75", "1", "1.25", "1.5", "2"] as const;

export type Speed = (typeof SPEED_OPTIONS)[number];

/** Normal speed. A summary read at this pace is unchanged from the voice. */
export const DEFAULT_SPEED: Speed = "1";

/** True for a value the picker could have produced. */
export function isSpeed(value: unknown): value is Speed {
  return typeof value === "string" && (SPEED_OPTIONS as readonly string[]).includes(value);
}

/** A stored speed, falling back to normal for anything else. */
export function resolveSpeed(value?: string): Speed {
  return isSpeed(value) ? value : DEFAULT_SPEED;
}

/** How the speed reads in the UI, e.g. "1.5x". */
export function speedLabel(value?: string): string {
  return `${resolveSpeed(value)}x`;
}

/**
 * The `--rate` string for a speed, e.g. "1.5" -> "+50%", "0.5" -> "-50%".
 *
 * Edge takes a signed percentage where zero is the voice's own pace, so 1x is
 * "+0%", not an omission: the summary's speed is absolute, set on its own
 * rather than carried from the voice's rate.
 */
export function rateForSpeed(value?: string): string {
  const percent = Math.round((Number(resolveSpeed(value)) - 1) * 100);
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}

/**
 * Where to resume after re-rendering a clip at a new speed.
 *
 * The words already read take `atSeconds` at the old pace; at the new pace the
 * same words take proportionally fewer (or more) seconds. Nothing else is
 * needed - the ratio of the speeds is the whole calculation - so this does not
 * depend on knowing the audio's length.
 */
export function resumeOffset(atSeconds: number, fromSpeed?: string, toSpeed?: string): number {
  const from = Number(resolveSpeed(fromSpeed));
  const to = Number(resolveSpeed(toSpeed));
  if (!(atSeconds > 0) || !(from > 0) || !(to > 0)) return 0;
  return (atSeconds * from) / to;
}
