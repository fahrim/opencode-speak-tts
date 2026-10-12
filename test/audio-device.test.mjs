import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentOutputDevice,
  parseDeviceLine,
  shortenDeviceName,
  watchOutputDevice,
} from "../lib/audio-device.ts";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("decodes a base64 name back to its characters", () => {
  const line = JSON.stringify({ ok: true, id: "{0.0.0.0}.{abc}", name: b64("Hoparlör (8- FUJIN)") });
  const device = parseDeviceLine(line);
  assert.ok(device);
  // The point of base64: these names are Turkish and the console mangles them.
  assert.equal(device.name, "Hoparlör (8- FUJIN)");
  assert.equal(device.id, "{0.0.0.0}.{abc}");
});

test("ignores noise around the payload", () => {
  assert.equal(parseDeviceLine(""), null);
  assert.equal(parseDeviceLine("WARNING: something"), null);
  assert.equal(parseDeviceLine("{not json"), null);
  assert.equal(parseDeviceLine(JSON.stringify({ ok: false, id: "", name: "" })), null);
  // A name that decodes to nothing is not a device.
  assert.equal(parseDeviceLine(JSON.stringify({ ok: true, id: "x", name: "" })), null);
});

test("reads the current output device on Windows", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only");
  const device = await currentOutputDevice();
  assert.ok(device, "the default endpoint should be readable");
  assert.match(device.id, /^\{[^}]+\}\.\{[0-9A-Fa-f-]{36}\}$/, `odd endpoint id: ${device.id}`);
  assert.ok(device.name.trim().length > 0, "the device needs a name");
  assert.ok(!device.name.includes("�"), "the name must not contain replacement characters");
});

test("never throws when the lookup cannot run", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only");
  // A timeout far below PowerShell's startup cost must resolve to null rather
  // than hanging or throwing: this is decoration on a button row.
  assert.equal(await currentOutputDevice(1), null);
});

test("the watcher reports the current device then stops cleanly", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only");
  const seen = [];
  const stop = watchOutputDevice((d) => seen.push(d));
  try {
    // The first line is the current state, so this does not wait for a change
    // the user may not make.
    await new Promise((r) => setTimeout(r, 15000));
  } finally {
    stop();
  }
  assert.ok(seen.length >= 1, "the watcher should report without waiting for a change");
  assert.ok(seen[0].name.trim().length > 0);
  assert.ok(!seen[0].name.includes("�"), "watched names must survive the encoding too");
});

test("stopping twice is safe", () => {
  const stop = watchOutputDevice(() => {});
  stop();
  assert.doesNotThrow(() => stop());
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
  assert.ok(shortenDeviceName("abcdefghij", 5).length <= 5);
});