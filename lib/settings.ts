/**
 * Settings persistence.
 *
 * Two sources feed the same record: `context.storage` keeps the running state
 * in sync across TUI instances, and a JSON file next to the OpenCode config
 * lets a user set defaults without touching the keyboard. The file is read once
 * at startup and only supplies values the user has not already changed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineName } from "./engines.ts";

export interface Settings {
  enabled: boolean;
  autoSpeak: boolean;
  summarize: boolean;
  voice: string;
  engine: EngineName;
  rate: string;
  pitch: string;
  volume: number;
  /** Model used to condense long answers; "" means the session's own model. */
  summaryModel: string;
  /** Reasoning-effort variant of that model; "" means the model's default. */
  summaryVariant: string;
  /**
   * Language the spoken summary is written in, e.g. "Turkish".
   * Empty means the summary follows the language of the answer.
   */
  summaryLanguage: string;
}

export const DEFAULTS: Settings = {
  enabled: false,
  autoSpeak: false,
  summarize: true,
  voice: "en-US-AvaNeural",
  engine: "edge",
  rate: "+0%",
  pitch: "+0Hz",
  volume: 100,
  summaryModel: "",
  summaryVariant: "",
  summaryLanguage: "",
};

function configDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "opencode");
  return path.join(os.homedir(), ".config", "opencode");
}

export function settingsFile(): string {
  return path.join(configDir(), "opencode-speak-tts.json");
}

/**
 * Reads overrides from `~/.config/opencode/opencode-speak-tts.json`.
 * Unknown keys and wrong types are ignored rather than fatal: a typo in a
 * settings file should not stop the plugin from loading.
 */
export function readOverrides(file = settingsFile()): Partial<Settings> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const src = parsed as Record<string, unknown>;
  const out: Partial<Settings> = {};

  if (typeof src.voice === "string" && src.voice) out.voice = src.voice;
  if (typeof src.summaryModel === "string") out.summaryModel = src.summaryModel;
  if (typeof src.summaryVariant === "string") out.summaryVariant = src.summaryVariant;
  if (typeof src.summaryLanguage === "string") out.summaryLanguage = src.summaryLanguage;
  if (src.engine === "edge" || src.engine === "sapi") out.engine = src.engine as EngineName;
  if (typeof src.rate === "string") out.rate = src.rate;
  if (typeof src.pitch === "string") out.pitch = src.pitch;
  if (typeof src.summarize === "boolean") out.summarize = src.summarize;
  if (typeof src.autoSpeak === "boolean") out.autoSpeak = src.autoSpeak;
  if (typeof src.volume === "number" && Number.isFinite(src.volume)) out.volume = src.volume;

  return out;
}

/** Defaults, with any on-disk overrides applied. */
export function initialSettings(file = settingsFile()): Settings {
  return { ...DEFAULTS, ...readOverrides(file) };
}