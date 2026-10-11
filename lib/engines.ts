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

export type EngineName = "edge" | "sapi";

export interface SynthesisRequest {
  readonly text: string;
  readonly voice: string;
  readonly rate: string;
  readonly pitch: string;
}

export interface SynthesisEngine {
  readonly name: EngineName;
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
 */
export const edgeEngine: SynthesisEngine = {
  name: "edge",
  async synthesize({ text, voice, rate, pitch }, outFile) {
    const args = ["-m", "edge_tts", "--voice", voice, "--rate", rate, "--pitch", pitch, "--text", text, "--write-media", outFile];
    await run("python", args, { timeoutMs: 90000 });
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

/** Prefers edge, falls back to SAPI so a speech attempt never ends in silence. */
export function createEngine(preferred: EngineName = "edge"): SynthesisEngine {
  return preferred === "sapi" ? sapiEngine : edgeEngine;
}

/** Parses a "+10%"/"-5Hz" style engine parameter, returning 0 when unparseable. */
export function parseNumeric(value: string): number {
  const n = Number.parseFloat(String(value ?? "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function tempDir(): string {
  return path.join(os.tmpdir(), "opencode-tts");
}

export function uniqueAudioPath(prefix = "tts"): string {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
}