# opencode-tts

Speak OpenCode's answers aloud on Windows. Microsoft Edge neural voices, **free and with no API key**, in English and Turkish, with optional summarisation for long answers.

- **No API key.** Synthesis uses Microsoft's free Edge voices. Summarisation runs through the model you have already connected to OpenCode, so there is no second key to configure.
- **Reads like a person.** Markdown, code fences, file paths, commit hashes and `camelCase` identifiers are rewritten into speakable prose before synthesis.
- **Summarises long answers.** Anything over 600 characters is condensed into two or three spoken sentences, so a code-heavy answer does not turn into five minutes of audio.
- **Playback control.** Pause, resume, rewind and skip ahead while it speaks.

> Not affiliated with the OpenCode team. This is an independent community plugin.

## Requirements

- **Windows** (playback uses the built-in `MediaPlayer` runtime)
- **OpenCode V2** (`opencode --version` → 2.x)
- **Python 3.9+** on `PATH`
- `pip install edge-tts`

## Install

```powershell
git clone https://github.com/fahrim/opencode-tts "$env:USERPROFILE\.config\opencode\plugins\opencode-tts"
pip install edge-tts
```

Restart OpenCode. The plugin is discovered from `~/.config/opencode/plugins/`.

Check that it loaded:

```powershell
opencode api get /api/plugin   # look for opencode-tts, status "active"
```

## Usage

| Command | What it does |
| --- | --- |
| `/tts-speak` | Read the latest answer aloud. While it is playing, the same command pauses or resumes it. |
| `/tts-pause` | Pause playback, or resume if paused |
| `/tts-back` | Rewind 15 seconds |
| `/tts-forward` | Skip ahead 15 seconds |
| `/tts-toggle` | Speak every answer automatically when the session goes idle |
| `/tts-stop` | Stop playback |
| `/tts-voice` | Choose the voice |
| `/tts-summarize` | Turn summarisation on or off |
| `/tts-status` | Show what is playing and the current settings |

Every command is also in the palette (`ctrl+p`) under **Speech**.

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

Any other Edge voice name works too; set it in `opencode-tts.json` (see below).

## Configuration

Settings persist automatically. To override them by hand, create
`~/.config/opencode/opencode-tts.json`:

```json
{
  "voice": "tr-TR-EmelNeural",
  "engine": "edge",
  "rate": "+10%",
  "pitch": "+0Hz",
  "summarize": true,
  "autoSpeak": false
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `voice` | `en-US-AvaNeural` | Edge voice name |
| `engine` | `edge` | `edge` (neural, online) or `sapi` (offline) |
| `rate` | `+0%` | Speaking rate, e.g. `+10%` |
| `pitch` | `+0Hz` | Pitch offset |
| `summarize` | `true` | Condense long answers before reading |
| `autoSpeak` | `false` | Speak automatically when a session goes idle |

## Engines

| Engine | Quality | Needs network | Notes |
| --- | --- | --- | --- |
| `edge` | Natural, neural | Yes, at synthesis time | Default. Microsoft Edge voices, free. |
| `sapi` | Robotic | No | Windows built-in speech. Works fully offline. |

Switch with `engine` in the config file. If `edge-tts` is missing or fails, the plugin reports the error rather than silently falling back, so a broken setup stays visible.

## How it works

1. A session goes idle (or you run `/tts-speak`).
2. If the answer is over 600 characters and summarisation is on, OpenCode's own model condenses it into two or three sentences.
3. The text is normalised for speech: code fences collapse to a marker, file paths become file names, `camelCase` splits into words, acronyms are spelled out, and hashes and URLs are dropped.
4. Each chunk is synthesised with Edge TTS and played back through `MediaPlayer`, which a detached PowerShell process drives so playback can be paused, resumed, seeked or stopped.

## Development

```sh
npm install
npm run typecheck
npm test
```

## License

MIT