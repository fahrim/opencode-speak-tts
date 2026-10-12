/**
 * Synthesis and playback engines.
 *
 * Edge TTS is preferred: Microsoft's neural voices are free, need no API key,
 * and are the only option here that sounds like a person. Windows SAPI is the
 * offline fallback — robotic but it always works, even with no network.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The edge-tts bridge that ships beside this file.
 *
 * It is resolved from this module rather than from the process working
 * directory, which is the user's project, not the plugin.
 */
const EDGE_BRIDGE = fileURLToPath(new URL("./edge_bridge.py", import.meta.url));

export type EngineName = "edge" | "sapi";

export interface SynthesisRequest {
  readonly text: string;
  readonly voice: string;
  readonly rate: string;
  readonly pitch: string;
}

export interface SynthesisEngine {
  readonly name: EngineName;
  /** Container the engine writes, so the output path is not a lie. */
  readonly extension: string;
  /** Resolves to the path of the rendered audio file, or throws. */
  synthesize(request: SynthesisRequest, outFile: string): Promise<string>;
}

/** Runs a command to completion, rejecting on a non-zero exit. */
function run(
  command: string,
  args: string[],
  options: { timeoutMs?: number; capture?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "ignore",
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error(`${command} timed out`));
    }, options.timeoutMs ?? 60000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${command}: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().split("\n").pop() || ""}`));
    });
  });
}

/** PowerShell's -EncodedCommand avoids every quoting problem with user text. */
function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Base64-encodes text for safe embedding in a PowerShell single-quoted string. */
function psLiteral(value: string): string {
  return Buffer.from(value, "utf16le").toString("base64");
}

async function powershell(script: string, timeoutMs = 60000): Promise<string> {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)],
    { timeoutMs, capture: true },
  );
}

/**
 * Microsoft Edge neural voices via the `edge-tts` Python CLI.
 * Requires `pip install edge-tts` and a network connection at synthesis time.
 *
 * The CLI is invoked through the bridge rather than `python -m edge_tts`,
 * because Microsoft moved the service and the installed library still points at
 * the old address, where regional backends now answer 403. See edge_bridge.py.
 */
export const edgeEngine: SynthesisEngine = {
  name: "edge",
  extension: ".mp3",
  async synthesize({ text, voice, rate, pitch }, outFile) {
    const common = [
      "--voice",
      voice,
      "--rate",
      rate,
      "--pitch",
      pitch,
      "--text",
      text,
      "--write-media",
      outFile,
    ];
    // Falling back to the plain CLI keeps a missing or unreadable bridge from
    // taking edge-tts down entirely.
    const useBridge = fs.existsSync(EDGE_BRIDGE);
    const args = useBridge ? [EDGE_BRIDGE, ...common] : ["-m", "edge_tts", ...common];
    // Captured so a failure names its cause instead of reporting an empty
    // "python exited 1" to the user.
    await run("python", args, { timeoutMs: 90000, capture: true });
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
      throw new Error("edge-tts produced no audio");
    }
    return outFile;
  },
};

/**
 * Windows SAPI through System.Speech. Fully offline and built in, at the cost
 * of sounding like a 1990s navigator. Used when edge-tts is missing or fails.
 */
export const sapiEngine: SynthesisEngine = {
  name: "sapi",
  extension: ".wav",
  async synthesize({ text, rate }, outFile) {
    const voiceB64 = psLiteral(text);
    const script = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      `$r = [Math]::Max(-10, [Math]::Min(10, ${Number(rate) || 0}))`,
      "$s.Rate = $r",
      `$t = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${voiceB64}'))`,
      `$s.SetOutputToWaveFile('${outFile.replace(/'/g, "''")}')`,
      "$s.Speak($t)",
      "$s.Dispose()",
    ].join("; ");
    await powershell(script);
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
      throw new Error("SAPI produced no audio");
    }
    return outFile;
  },
};

/** What actually produced the audio, which is not always what was asked for. */
export interface SynthesisOutcome {
  readonly engine: EngineName;
  readonly file: string;
}

export interface EngineChain {
  /** The engine the user asked for. */
  readonly preferred: EngineName;
  /**
   * Synthesises with `preferred`, falling back when it fails, and reports which
   * engine actually ran so the caller can tell the user.
   */
  synthesize(request: SynthesisRequest): Promise<SynthesisOutcome>;
}

/**
 * Runs `engines` in order and returns the first success.
 *
 * Every failure is collected so the error names what was tried, and a partial
 * file from a failed attempt is removed: leaving it behind would let the next
 * engine mistake it for a finished render.
 */
export async function synthesizeWith(
  engines: readonly SynthesisEngine[],
  request: SynthesisRequest,
): Promise<SynthesisOutcome> {
  const failures: string[] = [];
  for (const engine of engines) {
    const file = uniqueAudioPath(engine.name, engine.extension);
    try {
      return { engine: engine.name, file: await engine.synthesize(request, file) };
    } catch (err) {
      failures.push(`${engine.name}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  }
  throw new Error(failures.join(" → "));
}

/**
 * Builds the engine chain.
 *
 * The fallback is the point: edge-tts talks to a free Microsoft endpoint that
 * breaks without warning, and a plugin that only ever tries one engine turns
 * someone else's outage into a dead feature. SAPI is built into Windows and
 * cannot be taken away, so it is the floor the chain always lands on.
 *
 * Picking SAPI explicitly stays SAPI-only; that is the user opting out of the
 * network path, not asking to retry it.
 */
export function createEngine(preferred: EngineName = "edge"): EngineChain {
  const order: readonly SynthesisEngine[] =
    preferred === "sapi" ? [sapiEngine] : [edgeEngine, sapiEngine];

  return {
    preferred,
    synthesize: (request) => synthesizeWith(order, request),
  };
}

/** Parses a "+10%"/"-5Hz" style engine parameter, returning 0 when unparseable. */
export function parseNumeric(value: string): number {
  const n = Number.parseFloat(String(value ?? "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function tempDir(): string {
  return path.join(os.tmpdir(), "opencode-speak-tts");
}

export function uniqueAudioPath(prefix = "tts", extension = ".mp3"): string {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`);
}