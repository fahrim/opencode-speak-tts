/** @jsxImportSource @opentui/solid */
import fs from "node:fs";
import { createSignal } from "solid-js";
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
    /** True while the summary model call is in flight; drives the ellipsis. */
    const [summarising, setSummarising] = createSignal(false);
    /** Text currently shown in the summary modal, if any. */
    const [modalText, setModalText] = createSignal<string | null>(null);
    const [spin, setSpin] = createSignal(0);

    // Drives the three-dot indicator while summarising.
    let spinner: ReturnType<typeof setInterval> | null = null;
    const startSpinner = (): void => {
      if (spinner) return;
      spinner = setInterval(() => setSpin((n) => (n + 1) % 3), 300);
    };
    const stopSpinner = (): void => {
      if (spinner) clearInterval(spinner);
      spinner = null;
      setSpin(0);
      setSummarising(false);
    };

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
        const player = play(made, settings.volume);
        current = player;
        // A player that fails to start exits 0 and says nothing, which looks
        // exactly like a clip that played to a muted device. Give it a moment
        // and then say so out loud rather than leaving the user guessing.
        let settled = false;
        const watchdog = setTimeout(() => {
          if (settled) return;
          if (!player.started()) {
            trace("playback never started");
            toast("Audio did not start - the file was made but no sound came out", "error");
          }
        }, 3000);
        try {
          await player.done;
        } finally {
          settled = true;
          clearTimeout(watchdog);
        }
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
          const cached = cacheKey ? summaries.get(cacheKey) : undefined;
          if (cached) {
            text = cached;
          } else {
            setSummarising(true);
            startSpinner();
            toast("Summarising…");
            trace(`summarize start len=${text.length} model=${settings.summaryModel || "default"}`);
            const summary = await summarizeForSpeech(context.client, {
              answer: text,
              model: settings.summaryModel,
            });
            stopSpinner();
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

    /** The answer the footer controls act on. */
    const currentAnswer = (): string => {
      const id = currentSessionID();
      if (!id) return "";
      return lastAssistantText(context.data.session.message.list(id) as Message[]);
    };

    /** Opens the summary in a scrollable modal. */
    const showSummary = (): void => {
      const text = currentAnswer();
      if (!text) {
        toast("No answer to summarise yet", "warning");
        return;
      }
      const summary = summaries.get(text);
      if (!summary) {
        toast("No summary yet — run /tts-speak first", "warning");
        return;
      }
      setModalText(summary);
      context.ui.dialog.show(
        () => (
          <box flexDirection="column" padding={1} gap={1}>
            <text fg="#7aa2f7">{"Summary"}</text>
            <text>{summary}</text>
          </box>
        ),
        () => setModalText(null),
      );
    };

    /** Model used for summarisation; defaults to the session's own model. */
    const summaryModelName = (): string => {
      if (settings.summaryModel) return settings.summaryModel;
      const current = context.ui.model.current();
      if (current) return `${current.providerID}/${current.modelID}`;
      return "session model";
    };

    const pickSummaryModel = async (): Promise<void> => {
      const models = context.data.location.model.list() ?? [];
      if (models.length === 0) {
        toast("No models available", "warning");
        return;
      }
      const picked = await context.ui.dialog.select<string>({
        title: "Summarisation model",
        options: models.map((m) => ({
          title: `${m.providerID}/${m.modelID}`,
          value: `${m.providerID}/${m.modelID}`,
        })),
        search: (query, options) =>
          options.filter((o) => o.title.toLowerCase().includes(query.toLowerCase())),
      });
      if (!picked) return;
      await save((d) => {
        d.summaryModel = picked;
      });
      // A different model means the cached summaries no longer apply.
      summaries.clear();
      toast(`Summary model: ${picked}`);
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
        {
          id: `${ID}.summary`,
          title: "Show summary",
          description: "Open the spoken summary of the last answer",
          group: "Speech",
          palette: true,
          slash: { name: "tts-summary" },
          run: () => {
            showSummary();
          },
        },
        {
          id: `${ID}.summary-model`,
          title: "Choose summarisation model",
          description: "Pick the model used to condense long answers",
          group: "Speech",
          palette: true,
          slash: { name: "tts-summary-model" },
          run: () => {
            void pickSummaryModel();
          },
        },
      ],
    }));

    // ---- footer controls -------------------------------------------------
    // Sits on the row directly under the answer, next to OpenCode's
    // [agent] [model] [time] [tok/s] details. `prompt.footer` is the wrong
    // slot for this: it lands on the status bar at the very bottom of the
    // screen, far from the message it describes.
    //
    // Written as explicit conditionals rather than <Show>: the slot renderer
    // runs outside a reactive owner, so <Show> never updates here.
    const releaseFooter = context.ui.slot({
      append: "session.composer.top",
      render: () => (
        <box height={1} flexShrink={0} flexDirection="row" gap={1} justifyContent="flex-end">
          {state.speaking ? (
            <>
              <text fg="#7aa2f7" onMouseUp={() => seek(-15)}>
                {"⏮"}
              </text>
              <text fg="#e5c07b" onMouseUp={() => togglePause()}>
                {state.paused ? "▶" : "⏸"}
              </text>
              <text fg="#7aa2f7" onMouseUp={() => seek(15)}>
                {"⏭"}
              </text>
              <text fg="#e06c75" onMouseUp={() => { stop(); toast("Stopped"); }}>
                {"■"}
              </text>
              <text fg="#98c379" onMouseUp={() => void speakLast()}>
                {"↻"}
              </text>
            </>
          ) : (
            // A speaker, not a play triangle: this reads the answer aloud, it
            // does not start a video. The transport row above already uses
            // triangles where they mean "resume".
            <text fg="#98c379" onMouseUp={() => void speakLast()}>
              {"🔊"}
            </text>
          )}

          {/* Model picker for summarisation, with its current selection. */}
          <text fg="#c678dd" onMouseUp={() => void pickSummaryModel()}>
            {`${settings.summarize ? "∑" : "·"} ${summaryModelName()}`}
          </text>

          {/* Summary button: opens the modal when a summary exists. Labelled
              rather than icon-only, so it reads as clickable without hover. */}
          <text
            fg={summarising() ? "#e5c07b" : summaries.size > 0 ? "#61afef" : "#5c6660"}
            onMouseUp={() => (summarising() ? toast("Still summarising…", "warning") : showSummary())}
          >
            {summarising() ? `☰ ${".".repeat(spin() + 1)}` : "☰ summary"}
          </text>
        </box>
      ),
    });

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
      releaseFooter();
      stopSpinner();
    };
  },
});