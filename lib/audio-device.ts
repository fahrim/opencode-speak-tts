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

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface OutputDevice {
  /** Windows endpoint id, e.g. `{0.0.0.00000000}.{80709c03-...}`. */
  readonly id: string;
  /** Readable name, e.g. `Hoparlör (8- FUJIN)`. */
  readonly name: string;
}

const SCRIPT = fileURLToPath(new URL("./audio_device.ps1", import.meta.url));

/**
 * Reads the current default output, or null when it cannot be determined.
 *
 * Never throws: this is decoration on a row of buttons, and a machine where the
 * COM call is unavailable should still get working audio controls.
 */
export function currentOutputDevice(timeoutMs = 8000): Promise<OutputDevice | null> {
  if (process.platform !== "win32") return Promise.resolve(null);

  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
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
      try {
        // PowerShell prints progress and warnings before the payload, so the
        // JSON is the last non-empty line rather than the whole output.
        const line = out.split(/\r?\n/).filter(Boolean).pop() ?? "";
        const parsed = JSON.parse(line) as { ok?: boolean; id?: string; name?: string };
        if (parsed.ok && parsed.id && parsed.name) {
          finish({ id: parsed.id, name: parsed.name });
          return;
        }
      } catch {
        // Fall through to null below.
      }
      finish(null);
    });
  });
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
