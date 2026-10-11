/**
 * Audio playback with pause/resume/seek/stop.
 *
 * On Windows this drives WPF's MediaPlayer through a detached PowerShell
 * process that polls a small JSON control file. Running detached means a
 * crashing player can never take the TUI with it, and the control file means
 * the caller can steer a clip that is already playing.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Player {
  /** Resolves when playback finishes or is stopped. */
  readonly done: Promise<void>;
  pause(): void;
  resume(): void;
  /** `offset` is a signed number of seconds from the current position. */
  seek(offsetSeconds: number): void;
  stop(): void;
}

type ControlCommand = "pause" | "resume" | "seek" | "stop" | "none";

const PLAYER_SCRIPT = String.raw`
param($Audio, $Control)
Add-Type -AssemblyName PresentationCore
$player = New-Object System.Windows.Media.MediaPlayer
try { $player.Open([Uri]::new("file:///" + $Audio.Replace('\', '/'))) } catch { exit 1 }
$player.Play()
$seq = 0
$started = [DateTime]::UtcNow
$seenDuration = $false
while ($true) {
  Start-Sleep -Milliseconds 150
  if (Test-Path $Control) {
    try {
      $msg = Get-Content $Control -Raw | ConvertFrom-Json
      if ($msg.seq -gt $seq) {
        $seq = $msg.seq
        switch ($msg.command) {
          "pause"  { $player.Pause() }
          "resume" { $player.Play() }
          "stop"   { $player.Stop(); $player.Close(); exit 0 }
          "seek"   {
            if ($player.NaturalDuration.HasTimeSpan) {
              $length = $player.NaturalDuration.TimeSpan
              $target = $player.Position.Add([TimeSpan]::FromSeconds([double]$msg.value))
              if ($target -lt [TimeSpan]::Zero) { $target = [TimeSpan]::Zero }
              if ($target -gt $length) { $target = $length }
              $player.Position = $target
            }
          }
        }
      }
    } catch {}
  }
  if ($player.NaturalDuration.HasTimeSpan -and $player.NaturalDuration.TimeSpan.TotalMilliseconds -gt 0) {
    $seenDuration = $true
    if ($player.Position.TotalMilliseconds -ge ($player.NaturalDuration.TimeSpan.TotalMilliseconds - 200)) { break }
  }
  # A clip that never reports a duration is almost certainly broken; give up
  # rather than spinning a hidden PowerShell forever.
  if ((([DateTime]::UtcNow) - $started).TotalSeconds -gt 600 -and -not $seenDuration) { break }
}
$player.Close()
exit 0
`;

export function isWindows(): boolean {
  return process.platform === "win32";
}

/** Plays `file`, returning a controller. Never throws: failures reject `done`. */
export function play(file: string): Player {
  if (!isWindows()) {
    return {
      done: Promise.resolve(),
      pause() {},
      resume() {},
      seek() {},
      stop() {},
    };
  }

  const stamp = Date.now();
  const controlFile = path.join(os.tmpdir(), `opencode-tts-ctl-${stamp}.json`);
  const scriptFile = path.join(os.tmpdir(), `opencode-tts-play-${stamp}.ps1`);
  fs.writeFileSync(controlFile, JSON.stringify({ command: "none", value: 0, seq: 0 }));
  fs.writeFileSync(scriptFile, PLAYER_SCRIPT);

  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      scriptFile,
      "-Audio",
      file,
      "-Control",
      controlFile,
    ],
    { detached: true, windowsHide: true, stdio: "ignore" },
  );
  child.unref();

  let seq = 0;
  let finished = false;

  const send = (command: ControlCommand, value = 0) => {
    if (finished) return;
    seq += 1;
    try {
      fs.writeFileSync(controlFile, JSON.stringify({ command, value, seq }));
    } catch {}
  };

  const cleanup = () => {
    finished = true;
    for (const f of [controlFile, scriptFile]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  };

  const done = new Promise<void>((resolve) => {
    const finish = () => {
      if (finished) return;
      cleanup();
      resolve();
    };
    child.on("error", finish);
    child.on("exit", finish);
    // No exit event can be trusted if the shell was never reachable; do not
    // leave `done` pending forever.
    setTimeout(finish, 10 * 60 * 1000).unref?.();
  });

  return {
    done,
    pause: () => send("pause"),
    resume: () => send("resume"),
    seek: (offset) => send("seek", offset),
    stop: () => {
      send("stop");
      // The player exits on its own; this only bounds the wait if it does not.
      setTimeout(cleanup, 1500).unref?.();
    },
  };
}