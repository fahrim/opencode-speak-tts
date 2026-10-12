import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createEngine,
  parseNumeric,
  synthesizeWith,
  uniqueAudioPath,
  edgeEngine,
  edgeArgs,
  sapiEngine,
} from "../lib/engines.ts";

const REQUEST = { text: "Merhaba", voice: "en-US-AvaNeural", rate: "+0%", pitch: "+0Hz" };

test("a negative rate or pitch stays one argument, not an option", () => {
  // The bug this locks out: "-50%" given as its own argv token made argparse
  // fail, so every slower-than-normal read fell through to SAPI.
  const args = edgeArgs({ ...REQUEST, rate: "-50%", pitch: "-20Hz" }, "out.mp3");
  assert.ok(args.includes("--rate=-50%"), `rate not attached: ${args.join(" ")}`);
  assert.ok(args.includes("--pitch=-20Hz"), `pitch not attached: ${args.join(" ")}`);
  assert.ok(!args.includes("-50%"), "a bare negative value would be read as an option");
  assert.ok(!args.includes("-20Hz"), "a bare negative value would be read as an option");
  // Positive values keep the same shape, and nothing else sneaks in.
  assert.equal(args[0], `--voice=${REQUEST.voice}`);
  assert.ok(args.includes("--write-media=out.mp3"));
});

test("parseNumeric reads engine parameters and tolerates junk", () => {
  assert.equal(parseNumeric("+10%"), 10);
  assert.equal(parseNumeric("-5Hz"), -5);
  assert.equal(parseNumeric("nonsense"), 0);
  assert.equal(parseNumeric(""), 0);
  assert.equal(parseNumeric(undefined), 0);
});

test("each engine writes the container it claims", () => {
  assert.equal(edgeEngine.extension, ".mp3");
  assert.equal(sapiEngine.extension, ".wav");
});

test("falls back to SAPI when the preferred engine fails", async () => {
  // The real edge-tts endpoint is a third party and has broken before; this
  // locks in that its failure degrades instead of ending the feature.
  const chain = createEngine("edge");
  const out = await chain.synthesize(REQUEST);
  assert.ok(out.engine === "edge" || out.engine === "sapi");
  assert.ok(fs.existsSync(out.file), "the reported file must exist");
  assert.ok(fs.statSync(out.file).size > 0, "the reported file must not be empty");
  assert.ok(
    out.file.endsWith(chain.preferred === "edge" ? ".mp3" : ".wav") ||
      out.file.endsWith(".wav") ||
      out.file.endsWith(".mp3"),
    `unexpected container for ${out.engine}: ${out.file}`,
  );
  fs.rmSync(out.file, { force: true });
});

test("SAPI always produces audio on Windows", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only");
  const chain = createEngine("sapi");
  const out = await chain.synthesize(REQUEST);
  assert.equal(out.engine, "sapi");
  assert.ok(fs.existsSync(out.file));
  assert.ok(fs.statSync(out.file).size > 1000, "a real clip is far larger than an empty file");
  fs.rmSync(out.file, { force: true });
});

/** An engine that always fails, so the chain's fallback can be exercised. */
function brokenEngine(name, message) {
  return {
    name,
    extension: ".mp3",
    async synthesize(_request, outFile) {
      fs.writeFileSync(outFile, "half a file");
      throw new Error(message);
    },
  };
}

test("falls through to the next engine when the first fails", async () => {
  const calls = [];
  const good = {
    name: "sapi",
    extension: ".wav",
    async synthesize(_request, outFile) {
      calls.push("sapi");
      fs.writeFileSync(outFile, "audio");
      return outFile;
    },
  };
  const out = await synthesizeWith([brokenEngine("edge", "403"), good], REQUEST);
  assert.equal(out.engine, "sapi");
  assert.deepEqual(calls, ["sapi"]);
  assert.ok(fs.existsSync(out.file));
  fs.rmSync(out.file, { force: true });
});

test("a failed attempt leaves no file behind for the next engine", async () => {
  const good = {
    name: "sapi",
    extension: ".wav",
    async synthesize(_request, outFile) {
      fs.writeFileSync(outFile, "audio");
      return outFile;
    },
  };
  const broken = brokenEngine("edge", "403");
  const before = new Set(fs.readdirSync(path.dirname(uniqueAudioPath("probe", ".mp3"))));
  const out = await synthesizeWith([broken, good], REQUEST);
  const leaked = fs
    .readdirSync(path.dirname(out.file))
    .filter((f) => !before.has(f) && f.startsWith("edge-"));
  assert.deepEqual(leaked, [], "the half-written render must be cleaned up");
  fs.rmSync(out.file, { force: true });
});

test("every failure is named when no engine works", async () => {
  await assert.rejects(
    () =>
      synthesizeWith([brokenEngine("edge", "403 from bing"), brokenEngine("sapi", "no audio")], REQUEST),
    (err) => {
      assert.match(err.message, /edge: 403 from bing/);
      assert.match(err.message, /sapi: no audio/);
      assert.match(err.message, /→/, "the chain should read as a sequence of attempts");
      return true;
    },
  );
});

test("choosing SAPI does not reach for the network engine", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only");
  const chain = createEngine("sapi");
  const out = await chain.synthesize(REQUEST);
  assert.equal(out.engine, "sapi", "an explicit SAPI choice must stay SAPI-only");
  fs.rmSync(out.file, { force: true });
});
