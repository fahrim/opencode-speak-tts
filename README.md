# opencode-speak-tts

Speak OpenCode's answers aloud on Windows. Microsoft Edge neural voices, **free and with no API key**, in English and Turkish, with optional summarisation for long answers.

- **No API key.** Synthesis uses Microsoft's free Edge voices. Summarisation runs through a model you have already connected to OpenCode, so there is no second key to configure.
- **Reads like a person.** Markdown, code fences, file paths, commit hashes and `camelCase` identifiers are rewritten into speakable prose before synthesis.
- **Summarises long answers.** Past 600 characters the answer is condensed into a few spoken sentences instead of several minutes of audio, without dropping the facts you need to act.
- **Never goes silent.** Edge's free endpoint breaks without warning. If it does, the plugin drops to Windows' built-in voice and tells you which one it used.
- **Controls where you look.** Playback, voice, output device and the summary all sit on the row under your message.

> Not affiliated with the OpenCode team. This is an independent community plugin.

## Voice input

This plugin only speaks responses. For dictation, see
[opencode-listen-stt](https://github.com/fahrim/opencode-listen-stt) — the same
V2 plugin family, GPU-accelerated and Turkish-capable. If you need a Vulkan
whisper.cpp build for AMD or Intel, see
[whisper-vulkan-win](https://github.com/fahrim/whisper-vulkan-win).

## Requirements

- **Windows** (playback uses the built-in `MediaPlayer` runtime)
- **OpenCode V2** (`opencode --version` → 2.x)
- **Python 3.9+** on `PATH`
- `pip install edge-tts`

## Install

```powershell
git clone https://github.com/fahrim/opencode-speak-tts "$env:USERPROFILE\.config\opencode\plugins\opencode-speak-tts"
pip install edge-tts
```

Restart OpenCode. The plugin is discovered from `~/.config/opencode/plugins/`.

Check that it loaded:

```powershell
opencode api get /api/plugin   # look for opencode-speak-tts, status "active"
```

## Usage

| Command | What it does |
| --- | --- |
| `/tts-speak` | Read the latest answer aloud. Press again while it is playing to pause or resume. |
| `/tts-pause` | Pause playback, or resume it if paused |
| `/tts-back` | Rewind 15 seconds |
| `/tts-forward` | Skip ahead 15 seconds |
| `/tts-stop` | Stop playback |
| `/tts-toggle` | Speak every answer automatically when the session goes idle |
| `/tts-voice` | Choose the voice |
| `/tts-summarize` | Turn summarisation on or off |
| `/tts-summary` | Open the spoken summary of the last answer |
| `/tts-summary-language` | Choose the language summaries are written in |
| `/tts-summary-model` | Choose which model condenses long answers |
| `/tts-status` | Show what is playing and the current settings |

Every command is also in the palette (`ctrl+p`) under **Speech**.

## The controls under your message

On the row directly above the composer, at the right, next to OpenCode's own
`[agent] [model] [time]` details:

| Control | What it does |
| --- | --- |
| 🔊 | Speak the last answer. While audio is playing this becomes ⏮ ⏸ ⏭ ■ ↻ — back, pause, forward, stop, replay. All clickable. |
| `→ Speakers (Realtek)` | Where Windows is sending the sound. **Read only** — click for the full name. |
| `tr-TR-EmelNeural` | The voice that will read. Click to pick another. |
| `∑ model-name` | The model used for summarisation. Click to change it. |
| `☰ summary` | Opens the summary of the last answer. Spins while it is being written. |

The output device is deliberately **not** switchable here. Changing the Windows
default endpoint moves every other application on the machine as well, so it
stays a question you answer in Windows — this row only tells you where the sound
is currently going.

## Voices

English and Turkish are curated in the picker:

| Voice | |
| --- | --- |
| `en-US-AvaNeural` | Ava — female (default) |
| `en-US-GuyNeural` | Guy — male |
| `en-US-JennyNeural` | Jenny — female |
| `en-US-AndrewNeural` | Andrew — male |
| `en-US-BrianNeural` | Brian — male |
| `en-GB-SoniaNeural` | Sonia — British female |
| `en-GB-RyanNeural` | Ryan — British male |
| `tr-TR-EmelNeural` | Emel — Turkish female |
| `tr-TR-DenizNeural` | Deniz — Turkish male |

Any other Edge voice name works too; set it in `opencode-speak-tts.json` (see below).

## Summarisation

An answer longer than 600 characters is condensed before it is read. The result
targets **three to five sentences, roughly 40–90 words**, and that is a target
rather than a limit — if keeping it short would cost a fact, the summary runs
longer.

Three things the condensing deliberately does:

- **Keeps what changes your next move.** Significant changes, verified results, test outcomes, unresolved bugs, blockers, risks, and anything you have to act on. Length never wins over content.
- **Never overclaims.** Work that was attempted is not reported as finished, and a result is not called confirmed when the original answer did not confirm it.
- **Drops the conversation, not the work.** Play-by-play, filler, apologies, questions and closing offers ("let me know if") go. So do code, paths and error codes — those are described in words instead.

If summarisation is off, or the answer is short, the text is read as written.

`/tts-summary` shows the result without playing it, which is the quickest way to
see what the condensing did to a given answer.

### Language

Summaries follow the language of the answer unless you choose one with
`/tts-summary-language`. Turkish in, Turkish out — no guessing.

### Which model

By default the session's own model does the condensing, in a short-lived child
session that is deleted afterwards. It never touches your conversation history.
Pick a different one with `/tts-summary-model` if you would rather not spend the
session model on this.

## Configuration

Settings persist automatically when you change them from the commands above. To
set defaults by hand, create `~/.config/opencode/opencode-speak-tts.json`:

```json
{
  "voice": "tr-TR-EmelNeural",
  "engine": "edge",
  "rate": "+10%",
  "pitch": "+0Hz",
  "volume": 100,
  "summarize": true,
  "summaryLanguage": "Turkish",
  "summaryModel": "",
  "autoSpeak": false
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `voice` | `en-US-AvaNeural` | Edge voice name |
| `engine` | `edge` | `edge` (neural, online) or `sapi` (offline) |
| `rate` | `+0%` | Speaking rate, e.g. `+10%` |
| `pitch` | `+0Hz` | Pitch offset |
| `volume` | `100` | Playback volume, 0–100 |
| `summarize` | `true` | Condense long answers before reading |
| `summaryLanguage` | `""` | Language of the summary; empty means the answer's own |
| `summaryModel` | `""` | Model that condenses; empty means the session's own |
| `summaryVariant` | `""` | Reasoning-effort variant of that model; empty means its default |
| `autoSpeak` | `false` | Speak automatically when a session goes idle |

Unknown keys and wrongly-typed values are ignored rather than fatal, so a typo
cannot stop the plugin loading.

Precedence runs **what you picked in the TUI → the config file → the built-in
default**. Picking a voice from the dialog overrides the file, and the file
overrides the default — so a `voice` or `summaryLanguage` you set by hand is not
undone by restarting OpenCode.

## Engines

| Engine | Quality | Needs network | Notes |
| --- | --- | --- | --- |
| `edge` | Natural, neural | Yes, at synthesis time | Default. Microsoft Edge voices, free. |
| `sapi` | Robotic | No | Windows built-in speech. Works fully offline. |

With `engine: "edge"` the plugin tries Edge first and **falls back to SAPI** if
Edge is missing, unreachable or failing. The first time that happens you get a
warning toast saying so — a voice that suddenly sounds like a 1990s navigator is
alarming if nobody explains why it changed — and the fallback is logged.

Choosing `sapi` explicitly means SAPI only — no network attempt at all. That is
opting out, not asking for a retry.

The Edge request goes through `lib/edge_bridge.py`, which tries the address Edge
itself uses now and then whatever your installed `edge-tts` defaults to. It
exists because Microsoft moved the service and the old address answers 403 while
voice lists keep working — see [Troubleshooting](#troubleshooting).

## How it works

1. A session goes idle (or you run `/tts-speak`).
2. If the answer is over 600 characters and summarisation is on, the chosen model condenses it into a few sentences in a throwaway child session.
3. The text is normalised for speech: code fences collapse to a marker, file paths become file names, `camelCase` splits into words, acronyms are spelled out, and hashes and URLs are dropped.
4. Each chunk is synthesised and played back through `MediaPlayer`, driven by a hidden PowerShell process so playback can be paused, resumed, seeked or stopped.

## Troubleshooting

**Synthesis fails with a 403, or nothing is said at all.** Microsoft's Read Aloud
service moved to `api.msedgeservices.com`. This plugin ships a bridge that tries
the new address first and falls back to your installed default, but `pip install
-U edge-tts` cannot undo it because the bridge is a plugin file, not an edit to
the package. Confirm the bridge is present and Python is on `PATH`:

```powershell
python -c "import edge_tts; print(edge_tts.__version__)"
Test-Path "$env:USERPROFILE\.config\opencode\plugins\opencode-speak-tts\lib\edge_bridge.py"
```

**The voice is robotic.** That is SAPI — Edge failed and fell back, and a
warning toast said so the first time. `/tts-status` shows the engine you
configured, not the one that answered; the fallback itself is the
`engine fell back to sapi` line in `pipeline.log`.

**No sound, but the summary is fine.** Playback follows whatever Windows calls
the default output — Bluetooth headphones left connected on another device are
the usual cause. The `→` label in the footer shows where the sound is going.

**Summaries are not appearing.** The answer was under 600 characters, or
`summarize` is off. `☰ summary` in the footer opens the last one regardless.

**The summary is in the wrong language.** `/tts-summary-language`. Empty means
"same as the answer", not "English".

**Looking for a log file that isn't there.** Intentional — see below.

## Diagnostics

`%LOCALAPPDATA%\opencode-speak-tts\pipeline.log` is created **only when
something fails**. A working install never touches the disk and the file does
not exist at all. When it does, it records why: engine fallback, speech failure,
summarisation failure, playback that never started.

```powershell
Get-Content "$env:LOCALAPPDATA\opencode-speak-tts\pipeline.log" -Tail 20
```

## Development

```sh
npm install
npm run typecheck
npm test
```

## License

MIT