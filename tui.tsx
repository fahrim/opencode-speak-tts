/** @jsxImportSource @opentui/solid */
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
    const [state, setState] = context.storage.memory<{ speaking: boolean }>(`${ID}.state`, {
      initial: { speaking: false },
    });

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant, duration: 3000 });

    let current: Player | null = null;
    let busy = false;

    const stop = () => {
      current?.stop();
      current = null;
      setState((draft) => {
        draft.speaking = false;
      });
    };

    /** The session currently on screen, if the user is inside one. */
    const currentSessionID = (): string | undefined => {
      const route = context.ui.router.current() as { type?: string; params?: { sessionID?: string } };
      if (route?.type !== "session") return undefined;
      const id = route.params?.sessionID;
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
      });
    };

    /**
     * The full pipeline: pick the text, condense it when asked, normalise it for
     * the ear, then synthesise. Any failure degrades to the next best option so
     * the user always hears something if there is anything to hear.
     */
    const speak = async (raw: string): Promise<void> => {
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
          if (sid) {
            toast("Summarising…");
            const summary = await summarizeForSpeech(context.client, {
              sessionID: sid,
              prompt: text,
            });
            if (summary) text = summary;
          }
        }

        const spoken = normalizeForSpeech(text);
        if (!spoken) {
          toast("Nothing to read", "warning");
          return;
        }

        await speakChunks(chunkForSynthesis(spoken));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast(`TTS failed: ${message}`, "error");
      } finally {
        busy = false;
        setState((draft) => {
          draft.speaking = false;
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
      await speak(text);
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
            void speakLast();
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
              `${settings.voice} · ${settings.engine} · ${settings.rate} · summarise ${
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