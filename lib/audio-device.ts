/**
 * Which audio device Windows is currently sending sound to.
 *
 * Read only, deliberately. Changing the default endpoint affects every
 * application on the machine - not just this plugin - so the decision to
 * switch belongs to the user in Windows settings, and this only reports where
 * the audio is actually going.
 *
 * That is the whole reason this exists: the player follows the Windows default
 * with no way to override it per clip, so "where is the sound going" is a
 * question the plugin can answer and the user otherwise cannot.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface OutputDevice {
  /** Windows endpoint id, e.g. `{0.0.0.00000000}.{80709c03-...}`. */
  readonly id: string;
  /** Readable name, e.g. `Hoparlör (8- FUJIN)`. */
  readonly name: string;
}

/** Called with the current device, and again whenever it changes. */
export type DeviceListener = (device: OutputDevice | null) => void;

const SCRIPT = fileURLToPath(new URL("./audio_device.ps1", import.meta.url));

/** How often the watcher re-checks, in milliseconds. */
const WATCH_INTERVAL_MS = 2000;

function baseArgs(extra: string[]): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    SCRIPT,
    ...extra,
  ];
}

/**
 * Parses one line of the script's output.
 *
 * The name arrives base64-encoded because these names are full of Turkish
 * characters and PowerShell 5.1's console encoding mangles them on the way out
 * no matter which encoding is asked for.
 */
export function parseDeviceLine(line: string): OutputDevice | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  let parsed: { ok?: boolean; id?: string; name?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed.ok || !parsed.id || !parsed.name) return null;
  let name: string;
  try {
    name = Buffer.from(parsed.name, "base64").toString("utf8");
  } catch {
    return null;
  }
  return name ? { id: parsed.id, name } : null;
}

/**
 * Reads the current output device once.
 *
 * Never throws: this is decoration on a row of buttons, and a machine where the
 * COM call is unavailable should still get working audio controls.
 */
export function currentOutputDevice(timeoutMs = 8000): Promise<OutputDevice | null> {
  if (process.platform !== "win32") return Promise.resolve(null);

  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      baseArgs([]),
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );

    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));

    const finish = (value: OutputDevice | null) => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    child.on("error", () => finish(null));
    child.on("close", () => {
      // PowerShell prints progress and warnings before the payload, so the
      // JSON is the last non-empty line rather than the whole output.
      const lines = out.split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const device = parseDeviceLine(lines[i]);
        if (device) {
          finish(device);
          return;
        }
      }
      finish(null);
    });
  });
}

/**
 * Watches for device changes until stopped.
 *
 * One long-lived PowerShell process that prints a line only when the endpoint
 * id changes, rather than polling from Node: spawning a process per tick would
 * cost a few hundred milliseconds of CPU every couple of seconds for a label
 * that changes a handful of times a day.
 */
export function watchOutputDevice(onChange: DeviceListener): () => void {
  if (process.platform !== "win32") return () => {};

  let child: ChildProcess | null = null;
  let stopped = false;
  let buffer = "";

  const start = (): void => {
    if (stopped) return;
    child = spawn(
      "powershell.exe",
      baseArgs(["-WatchMs", String(WATCH_INTERVAL_MS)]),
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      // The last element is whatever follows the final newline; keep it for
      // the next chunk rather than parsing half a line.
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const device = parseDeviceLine(line);
        if (device) onChange(device);
      }
    });

    child.on("error", () => scheduleRestart());
    child.on("close", () => scheduleRestart());
  };

  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRestart = (): void => {
    if (stopped || restartTimer) return;
    // A watcher that dies silently would leave a stale label, which is worse
    // than no label: it looks authoritative and is wrong.
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, 3000);
    restartTimer.unref?.();
  };

  start();

  return () => {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    try {
      child?.kill();
    } catch {}
    child = null;
  };
}

/**
 * Shortens a device name for a single terminal row.
 *
 * The parenthetical is the part that tells two outputs of the same sound card
 * apart, so it is kept: trimming it would render "Hoparlör (Realtek(R) Audio)"
 * and "Hoparlör (8- FUJIN)" as the same label, which is the one case where
 * knowing the name matters.
 */
export function shortenDeviceName(name: string, limit = 24): string {
  const trimmed = name.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}