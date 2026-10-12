import { test } from "node:test";
import assert from "node:assert/strict";
import { currentOutputDevice, shortenDeviceName } from "../lib/audio-device.ts";

test("reads the current output device on Windows", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only");
  const device = await currentOutputDevice();
  assert.ok(device, "the default endpoint should be readable");
  assert.match(device.id, /^\{[^}]+\}\.\{[0-9A-Fa-f-]{36}\}$/, `odd endpoint id: ${device.id}`);
  // Never an empty label: an unnamed device tells the user nothing.
  assert.ok(device.name.trim().length > 0, "the device needs a name");
});

test("never throws when the lookup cannot run", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only");
  // A timeout far below PowerShell's startup cost must resolve to null rather
  // than hanging or throwing: this is decoration on a button row.
  const device = await currentOutputDevice(1);
  assert.equal(device, null);
});

test("keeps short names whole", () => {
  assert.equal(shortenDeviceName("Hoparlör", 24), "Hoparlör");
  assert.equal(shortenDeviceName("Hoparlör (Realtek)", 24), "Hoparlör (Realtek)");
});

test("shortens long names with an ellipsis", () => {
  const out = shortenDeviceName("Hoparlör (Realtek(R) Audio)", 24);
  assert.ok(out.length <= 24, `got ${out.length} characters: ${out}`);
  assert.match(out, /…$/);
});

test("keeps the part that tells two outputs apart", () => {
  // Trimming the parenthetical would render both of these the same, which is
  // exactly the case where the name matters.
  const speakers = shortenDeviceName("Hoparlör (Realtek(R) Audio)", 24);
  const headset = shortenDeviceName("Hoparlör (8- FUJIN)", 24);
  assert.notEqual(speakers, headset);
});

test("trims before measuring, so padding cannot smuggle length in", () => {
  assert.equal(shortenDeviceName("   Hoparlör   ", 24), "Hoparlör");
  // The cut happens on the trimmed name, and the ellipsis counts toward the
  // limit rather than pushing past it.
  assert.ok(shortenDeviceName("abcdefghij", 5).length <= 5);
});
