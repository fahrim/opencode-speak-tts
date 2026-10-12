/** @jsxImportSource @opentui/solid */
import fs from "node:fs";
import { createSignal } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import { chunkForSynthesis, normalizeForSpeech } from "./lib/speech-text.ts";
import { createEngine } from "./lib/engines.ts";
import { play, type Player } from "./lib/player.ts";
import { currentOutputDevice, shortenDeviceName, watchOutputDevice } from "./lib/audio-device.ts";
import { VOICE_OPTIONS } from "./lib/voices.ts";
import {
  shouldSummarize,
  summarizeForSpeech,
  modelRef,
  parseModel,
  languageRuleFor,
  type ModelRef,
} from "./lib/summarize.ts";
import { DEFAULTS, initialSettings, type Settings } from "./lib/settings.ts";

const ID = "opencode-speak-tts";

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
    const initial = initialSettings();
    const [stored, save] = context.storage.store<Partial<Settings>>(ID, { initial });

    /**
     * The stored settings, with the config file filling any gaps.
     *
     * The durable record does not merge defaults in, so a setting added after
     * the user first ran the plugin reads as undefined - silently disabling it,
     * and throwing for a string setting that gets `.trim()` called on it.
     *
     * The fallback chain is not just defaults: what the user picked in the TUI
     * wins, then the config file, then the built-in default. Going straight to
     * DEFAULTS drops the file on the floor, and the file is where a language, a
     * voice or a model path lives for anyone who set one there instead of
     * through a dialog.
     */
    const settings = new Proxy(stored, {
      get: (target, key) => {
        if (key in target) return target[key as keyof Settings];
        const fromFile = initial[key as keyof Settings];
        return fromFile === undefined ? DEFAULTS[key as keyof Settings] : fromFile;
      },
    }) as Settings;
    const [state, setState] = context.storage.memory<{ speaking: boolean; paused: boolean }>(`${ID}.state`, {
      initial: { speaking: false, paused: false },
    });

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant, duration: 3000 });

    /**
     * Records a problem to disk, and only for problems.
     *
     * This existed as a full pipeline trace while the audio path was being
     * built, and it earned its keep: the whole reason a revoked OAuth token
     * was found was a line in this file. But it wrote on every listen, which
     * means a synchronous write to the user's disk at the moment they speak,
     * and it recorded the length of the text being read, the model used and the
     * summary language - none of which belongs in a log nobody opens.
     *
     * Now only failures reach it, so a working install touches the disk zero
     * times and no file is created at all.
     */
    const trace = (msg: string): void => {
      try {
        const dir = `${process.env.LOCALAPPDATA}\\opencode-speak-tts`;
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
    /** Where Windows is sending sound, for the footer label. */
    const [output, setOutput] = createSignal<string>("");

    // A watcher rather than a read per clip: the user switches devices in
    // Windows whenever they plug in headphones, which can happen mid-answer,
    // and a label that only refreshes on the next click is stale exactly when
    // it is being looked at.
    const stopWatching = watchOutputDevice((device) => setOutput(device?.name ?? ""));
    void currentOutputDevice().then((device) => {
      if (device) setOutput(device.name);
    });

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
      const chain = createEngine(settings.engine);
      let degraded = false;
      for (const chunk of chunks) {
        const { engine, file: made } = await chain.synthesize({
          text: chunk,
          voice: settings.voice,
          rate: settings.rate,
          pitch: settings.pitch,
        });
        if (engine !== chain.preferred) {
          // Say it. A voice that suddenly sounds like a 1990s navigator is
          // alarming if nobody explains why it changed.
          if (!degraded) {
            degraded = true;
            trace(`engine fell back to ${engine}`);
            toast(`${chain.preferred} unavailable — using ${engine.toUpperCase()} instead`, "warning");
          }
        }
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
            const result = await summarizeForSpeech(context.client, {
              answer: text,
              parentID: currentSessionID(),
              model: summaryModel(),
              language: settings.summaryLanguage,
            });
            stopSpinner();
            if (result.ok) {
              text = result.text;
              if (cacheKey) summaries.set(cacheKey, result.text);
            } else {
              // Name the reason. "Reading the full answer" on its own tells the
              // user nothing about whether to change a setting or file a bug.
              trace(`summarisation failed: ${result.reason}`);
              toast(`Could not summarise (${result.reason}) — reading the full answer`, "warning");
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
        await speakChunks(chunks);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The one failure that has no other trace: everything downstream
        // throws upward to here.
        trace(`speech failed: ${message}`);
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

    /**
     * Model used for summarisation.
     *
     * Falls back to the session's own model rather than sending no model at
     * all. With no model the child inherits whatever the server picks, which is
     * not necessarily what the user is talking to and can carry credentials
     * that are no longer valid.
     *
     * The reasoning-effort variant rides along: a session set to `high` should
     * not quietly summarise at the default effort.
     */
    const summaryModel = (): ModelRef | undefined => {
      if (settings.summaryModel) {
        const parsed = parseModel(settings.summaryModel);
        if (parsed) {
          return settings.summaryVariant
            ? { ...parsed, variant: settings.summaryVariant }
            : parsed;
        }
      }
      return modelRef(context.ui.model.current() as Parameters<typeof modelRef>[0]);
    };

    /** Label for the footer and the picker, variant included when set. */
    const summaryModelName = (): string => {
      const m = summaryModel();
      if (!m) return "";
      return `${m.providerID}/${m.id}${m.variant ? ` (${m.variant})` : ""}`;
    };

    /** Cleared value in the picker, meaning "follow whatever the session uses". */
    const FOLLOW_SESSION = "";

    /**
     * Second step of the picker: the reasoning effort for the model just chosen.
     *
     * Only offered when the model actually has variants. Listing every variant
     * of every model up front would be thousands of rows to scroll past for a
     * setting most people set once, so the choice follows the model instead.
     */
    const pickSummaryVariant = async (model: string): Promise<void> => {
      const models = context.data.location.model.list() ?? [];
      const entry = models.find((m) => `${m.providerID}/${m.modelID}` === model);
      const variants = entry?.variants ?? [];
      if (variants.length === 0) {
        await save((d) => {
          d.summaryVariant = "";
        });
        return;
      }

      const picked = await context.ui.dialog.select<string>({
        title: `Reasoning effort — ${model.split("/").pop()}`,
        options: [
          { title: "Model default", value: "" },
          ...variants.map((v) => ({ title: v.id, value: v.id })),
        ],
        search: (query, options) =>
          options.filter((o) => o.title.toLowerCase().includes(query.toLowerCase())),
      });
      if (picked === undefined) return;
      await save((d) => {
        d.summaryVariant = picked;
      });
      toast(picked ? `Reasoning effort: ${picked}` : "Reasoning effort: model default");
    };

    /** Opens the voice picker. Bound to both the command and the footer label. */
    const pickVoice = async (): Promise<void> => {
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
    };

    /**
     * Short label for the current voice: locale and name, without the trailing
     * "Neural" that every id carries and that tells the reader nothing.
     */
    const voiceLabel = (): string => {
      const id = settings.voice || "no voice";
      return `♪ ${id.replace(/Neural$/, "")}`;
    };

    const pickSummaryModel = async (): Promise<void> => {
      const models = context.data.location.model.list() ?? [];
      if (models.length === 0) {
        toast("No models available", "warning");
        return;
      }
      const picked = await context.ui.dialog.select<string>({
        title: "Summarisation model",
        options: [
          { title: "Default — follow the session model", value: FOLLOW_SESSION },
          ...models.map((m) => ({
            title: `${m.providerID}/${m.modelID}`,
            value: `${m.providerID}/${m.modelID}`,
          })),
        ],
        search: (query, options) =>
          options.filter((o) => o.title.toLowerCase().includes(query.toLowerCase())),
      });
      if (picked === undefined) return;
      await save((d) => {
        d.summaryModel = picked;
      });
      // A different model means the cached summaries no longer apply.
      summaries.clear();

      if (!picked) {
        await save((d) => {
          d.summaryVariant = "";
        });
        toast("Summary model: follows the session");
        return;
      }
      // Following the session already brings its variant along, so only an
      // explicit choice needs its own step.
      await pickSummaryVariant(picked);
      toast(`Summary model: ${summaryModelName()}`);
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
          run: () => {
            void pickVoice();
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
          id: `${ID}.summary-language`,
          title: "Summary language",
          description: "Language the spoken summary is written in",
          group: "Speech",
          palette: true,
          slash: { name: "tts-summary-language" },
          run: async () => {
            const picked = await context.ui.dialog.select<string>({
              title: "Summary language",
              options: [
                { title: "Same as the answer", value: "" },
                { title: "Türkçe", value: "Turkish" },
                { title: "English", value: "English" },
                { title: "Deutsch", value: "German" },
                { title: "Français", value: "French" },
                { title: "Español", value: "Spanish" },
              ],
            });
            if (picked === undefined) return;
            await save((draft) => {
              draft.summaryLanguage = picked;
            });
            // The language is part of what makes a summary, so a cached one in
            // the old language no longer applies.
            summaries.clear();
            toast(picked ? `Summary language: ${picked}` : "Summary language: same as the answer");
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

          {/* Where Windows is sending the sound. Read only on purpose: changing
              the default endpoint moves every application on the machine, not
              just this one, so it stays a question the user answers in Windows. */}
          {output() ? (
            <text
              fg="#5c6660"
              // The only item allowed to shrink. Everything else is a control
              // and must stay clickable; this is a label and can give way when
              // the terminal is narrow, instead of pushing the row wider than
              // the screen.
              flexShrink={1}
              overflow="hidden"
              onMouseUp={() => {
                void currentOutputDevice().then((device) => {
                  if (device) setOutput(device.name);
                  toast(`Playing through: ${device?.name ?? "unknown"}`, "info");
                });
              }}
            >
              {`→ ${shortenDeviceName(output(), 20)}`}
            </text>
          ) : (
            <text fg="#5c6660" flexShrink={1} overflow="hidden">
              {"→ output unknown"}
            </text>
          )}

          {/* The voice that will read the answer. Shown for the same reason the
              output device is: an English voice pronouncing Turkish is wrong in
              a way nobody can diagnose unless they can see which voice is
              picked. Clicking opens the picker. */}
          <text fg="#7fdbca" onMouseUp={() => void pickVoice()}>
            {voiceLabel()}
          </text>

          {/* Model picker for summarisation, with its current selection. */}
          <text fg="#c678dd" onMouseUp={() => void pickSummaryModel()}>
            {`${settings.summarize ? "∑" : "·"} ${summaryModelName() || "pick a model"}`}
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
      // A detached watcher would outlive the plugin and keep a PowerShell
      // process alive for a label nobody is looking at any more.
      stopWatching();
    };
  },
});