/** @jsxImportSource @opentui/solid */
import fs from "node:fs";
import { Plugin } from "@opencode/plugin/tui";
import { chunkForSynthesis, normalizeForSpeech } from "./lib/speech-text.ts";
import { createEngine, uniqueAudioPath } from "./lib/engines.ts";
import { play, type Player } from "./lib/player.ts";
import { VOICE_OPTIONS } from "./lib/voices.ts";
import { shouldSummarize, summarizeForSpeech } from "./lib/summarize.ts";
import { initialSettings, type Settings } from "./lib/settings.ts";

const ID = "opencode-tts";

type Message = { type: string; content?: Array<{ type: string; text?: string }> };

/** Text of the last assistant message that actually said something to the user. */
function lastAssistantText(messages: readonly Message[] | undefined): string {
  if (!messages?.length) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== "assistant") continue;
    const text = (m.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export default Plugin.define({
  id: ID,
  async setup(context) {
    const [settings, save] = context.storage.store<Settings>(ID, { initial: initialSettings() });
    const [state, setState] = context.storage.memory<{ speaking: boolean; paused: boolean }>(`${ID}.state`, {
      initial: { speaking: false, paused: false },
    });

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant, duration: 3000 });

    // Temporary: trace each pipeline stage to disk so a stall can be located.
    const trace = (msg: string): void => {
      try {
        const dir = `${process.env.LOCALAPPDATA}\\opencode-tts`;
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(`${dir}\\pipeline.log`, `${new Date().toISOString()} ${msg}\n`);
      } catch {}
    };

    let current: Player | null = null;
    let busy = false;
    /** Summaries keyed by source text, so replaying does not re-summarise. */
    const summaries = new Map<string, string>();

    const stop = () => {
      current?.stop();
      current = null;
      setState((draft) => {
        draft.speaking = false;
        draft.paused = false;
      });
    };

    /** Pause/resume is a toggle because that is what a single key should do. */
    const togglePause = () => {
      if (!current || !state.speaking) {
        toast("Nothing is playing", "warning");
        return;
      }
      if (state.paused) {
        current.resume();
        setState((draft) => {
          draft.paused = false;
        });
        toast("Resumed");
      } else {
        current.pause();
        setState((draft) => {
          draft.paused = true;
        });
        toast("Paused");
      }
    };

    const seek = (offset: number) => {
      if (!current || !state.speaking) {
        toast("Nothing is playing", "warning");
        return;
      }
      current.seek(offset);
      toast(offset >= 0 ? `Forward ${offset}s` : `Back ${Math.abs(offset)}s`);
    };

    /** The session currently on screen, if the user is inside one. */
    const currentSessionID = (): string | undefined => {
      // V2 returns the id flat on the route: { type: "session", sessionID }.
      const route = context.ui.router.current() as
        | { type?: string; sessionID?: string; params?: { sessionID?: string } }
        | undefined;
      if (route?.type !== "session") return undefined;
      const id = route.sessionID ?? route.params?.sessionID;
      return typeof id === "string" ? id : undefined;
    };

    /** Synthesises each chunk in turn, playing them back to back. */
    const speakChunks = async (chunks: string[]): Promise<void> => {
      const engine = createEngine(settings.engine);
      for (const chunk of chunks) {
        const file = uniqueAudioPath();
        const made = await engine.synthesize(
          {
            text: chunk,
            voice: settings.voice,
            rate: settings.rate,
            pitch: settings.pitch,
          },
          file,
        );
        const player = play(made);
        current = player;
        await player.done;
        current = null;
      }
      setState((draft) => {
        draft.speaking = false;
        draft.paused = false;
      });
    };

    /**
     * The full pipeline: pick the text, condense it when asked, normalise it for
     * the ear, then synthesise. Any failure degrades to the next best option so
     * the user always hears something if there is anything to hear.
     *
     * Summaries are cached against the source text. Replaying the same answer
     * should not pay for another model call, and a stale summary for a new
     * answer would be worse than none.
     */
    const speak = async (raw: string, cacheKey?: string): Promise<void> => {
      if (busy || !raw.trim()) return;
      busy = true;
      stop();
      setState((draft) => {
        draft.speaking = true;
      });
      try {
        let text = raw.trim();

        if (settings.summarize && shouldSummarize(text)) {
          const sid = currentSessionID();
          const cached = cacheKey ? summaries.get(cacheKey) : undefined;
          if (cached) {
            text = cached;
          } else if (sid) {
            toast("Summarising…");
            trace(`summarize start sid=${sid} len=${text.length}`);
            const summary = await summarizeForSpeech(context.client, {
              sessionID: sid,
              prompt: text,
            });
            trace(`summarize done summary=${summary ? summary.length + " chars" : "NULL"}`);
            if (summary) {
              text = summary;
              if (cacheKey) summaries.set(cacheKey, summary);
            } else {
              // Say so rather than leaving the user staring at a stuck toast.
              toast("Could not summarise — reading the full answer", "warning");
            }
          }
        }

        const spoken = normalizeForSpeech(text);
        if (!spoken) {
          toast("Nothing to read", "warning");
          return;
        }

        setState((draft) => {
          draft.speaking = true;
        });
        // Tell the user which stage is running. Without this, a stall anywhere
        // in the chain looks identical from the outside: the toast just sits
        // there and the user cannot tell whether it is summarising,
        // synthesising or already playing.
        const chunks = chunkForSynthesis(spoken);
        toast(`Synthesising ${chunks.length} chunk(s)…`);
        trace(`synth start chunks=${chunks.length} chars=${spoken.length}`);
        await speakChunks(chunks);
        trace("synth done");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast(`TTS failed: ${message}`, "error");
      } finally {
        busy = false;
        setState((draft) => {
          draft.speaking = false;
          draft.paused = false;
        });
      }
    };

    const speakLast = async () => {
      const id = currentSessionID();
      if (!id) {
        toast("Open a session first", "warning");
        return;
      }
      const messages = context.data.session.message.list(id);
      const text = lastAssistantText(messages as Message[]);
      if (!text) {
        toast("No answer to read yet", "warning");
        return;
      }
      // Keying the cache on the answer text means a new answer gets a new
      // summary, while replaying the same one reuses what was already paid for.
      await speak(text, text);
    };

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: `${ID}.speak`,
          title: "Speak last answer",
          description: "Read the latest assistant answer aloud",
          group: "Speech",
          palette: true,
          slash: { name: "tts-speak" },
          suggested: true,
          run: () => {
            // A second press while it is still talking means "pause", not
            // "start over", which is what a single toggle key should do.
            if (state.speaking) {
              togglePause();
              return;
            }
            void speakLast();
          },
        },
        {
          id: `${ID}.pause`,
          title: "Pause or resume speaking",
          description: "Pause playback, or resume it if it is paused",
          group: "Speech",
          palette: true,
          slash: { name: "tts-pause" },
          enabled: () => state.speaking,
          suggested: () => state.speaking,
          run: () => {
            togglePause();
          },
        },
        {
          id: `${ID}.seek-back`,
          title: "Rewind 15 seconds",
          description: "Jump back in the current playback",
          group: "Speech",
          palette: true,
          slash: { name: "tts-back" },
          enabled: () => state.speaking,
          run: () => {
            seek(-15);
          },
        },
        {
          id: `${ID}.seek-forward`,
          title: "Skip ahead 15 seconds",
          description: "Jump forward in the current playback",
          group: "Speech",
          palette: true,
          slash: { name: "tts-forward" },
          enabled: () => state.speaking,
          run: () => {
            seek(15);
          },
        },
        {
          id: `${ID}.toggle`,
          title: "Toggle auto-speak",
          description: "Speak every answer automatically when the session goes idle",
          group: "Speech",
          palette: true,
          slash: { name: "tts-toggle" },
          run: async () => {
            const next = !settings.autoSpeak;
            await save((draft) => {
              draft.autoSpeak = next;
            });
            if (!next) stop();
            toast(next ? `Auto-speak on (${settings.voice})` : "Auto-speak off");
          },
        },
        {
          id: `${ID}.stop`,
          title: "Stop speaking",
          description: "Stop the current playback",
          group: "Speech",
          palette: true,
          slash: { name: "tts-stop" },
          enabled: () => state.speaking,
          run: () => {
            stop();
            toast("Stopped");
          },
        },
        {
          id: `${ID}.voice`,
          title: "Choose voice",
          description: "Pick the TTS voice",
          group: "Speech",
          palette: true,
          slash: { name: "tts-voice" },
          run: async () => {
            const picked = await context.ui.dialog.select({
              title: "Select voice",
              options: [
                ...VOICE_OPTIONS.en.map((v) => ({ title: v.label, value: v.id })),
                ...VOICE_OPTIONS.tr.map((v) => ({ title: v.label, value: v.id })),
              ],
              search: (query, options) =>
                options.filter((o) => o.title.toLowerCase().includes(query.toLowerCase())),
            });
            if (!picked) return;
            await save((draft) => {
              draft.voice = picked;
            });
            toast(`Voice: ${picked}`);
          },
        },
        {
          id: `${ID}.summarize`,
          title: "Toggle summarisation",
          description: "Condense long answers before reading them",
          group: "Speech",
          palette: true,
          slash: { name: "tts-summarize" },
          run: async () => {
            const next = !settings.summarize;
            await save((draft) => {
              draft.summarize = next;
            });
            toast(next ? "Summarise: on" : "Summarise: off");
          },
        },
        {
          id: `${ID}.status`,
          title: "Speech status",
          description: "Show the current voice and settings",
          group: "Speech",
          palette: true,
          slash: { name: "tts-status" },
          run: () => {
            toast(
              `${state.speaking ? (state.paused ? "Paused" : "Speaking") : "Idle"} · ${settings.voice} · ${settings.engine} · ${settings.rate} · summarise ${
                settings.summarize ? "on" : "off"
              } · auto ${settings.autoSpeak ? "on" : "off"}`,
            );
          },
        },
      ],
    }));

    // Auto-speak: wait for a session that actually went idle after working, so
    // switching tabs does not replay the previous answer.
    let wasBusy = false;
    const offBusy = context.data.on("session.status", (event) => {
      const status = (event.data as { status?: { type?: string } })?.status;
      if (status?.type === "busy") wasBusy = true;
    });

    const offIdle = context.data.on("session.idle", (event) => {
      if (!settings.autoSpeak) return;
      if (!wasBusy) return;
      wasBusy = false;
      const id = (event.data as { sessionID?: string })?.sessionID;
      if (!id) return;
      const text = lastAssistantText(context.data.session.message.list(id) as Message[]);
      if (text) void speak(text);
    });

    return () => {
      offBusy();
      offIdle();
      stop();
    };
  },
});