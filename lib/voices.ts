/**
 * Curated voices. The full Edge catalogue is large and mostly irrelevant, so
 * the picker offers a short list and accepts any voice name typed by hand.
 */

export interface Voice {
  readonly id: string;
  readonly label: string;
  readonly lang: "en" | "tr";
}

export const VOICES: readonly Voice[] = [
  { id: "en-US-AvaNeural", label: "Ava (en-US, female)", lang: "en" },
  { id: "en-US-GuyNeural", label: "Guy (en-US, male)", lang: "en" },
  { id: "en-US-JennyNeural", label: "Jenny (en-US, female)", lang: "en" },
  { id: "en-US-AndrewNeural", label: "Andrew (en-US, male)", lang: "en" },
  { id: "en-US-BrianNeural", label: "Brian (en-US, male)", lang: "en" },
  { id: "en-GB-SoniaNeural", label: "Sonia (en-GB, female)", lang: "en" },
  { id: "en-GB-RyanNeural", label: "Ryan (en-GB, male)", lang: "en" },
  { id: "tr-TR-EmelNeural", label: "Emel (tr-TR, female)", lang: "tr" },
  { id: "tr-TR-DenizNeural", label: "Deniz (tr-TR, male)", lang: "tr" },
];

export const DEFAULT_VOICE = "en-US-AvaNeural";

export const VOICE_OPTIONS: Readonly<Record<"en" | "tr", readonly Voice[]>> = {
  en: VOICES.filter((v) => v.lang === "en"),
  tr: VOICES.filter((v) => v.lang === "tr"),
};

export function isKnownVoice(id: string): boolean {
  return VOICES.some((v) => v.id === id);
}