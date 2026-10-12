import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, initialSettings, readOverrides } from "../lib/settings.ts";

/** Writes a settings file in a temp dir and reads overrides from it. */
function withFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-settings-"));
  const file = path.join(dir, "opencode-speak-tts.json");
  fs.writeFileSync(file, contents, "utf8");
  try {
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the summarisation model and variant default to following the session", () => {
  assert.equal(DEFAULTS.summaryModel, "");
  assert.equal(DEFAULTS.summaryVariant, "");
});

test("reads the summary model and variant from the settings file", () => {
  withFile(JSON.stringify({ summaryModel: "opencode/space-bunny-free", summaryVariant: "high" }), (file) => {
    const overrides = readOverrides(file);
    assert.equal(overrides.summaryModel, "opencode/space-bunny-free");
    assert.equal(overrides.summaryVariant, "high");
  });
});

test("a model without a variant is a valid setting", () => {
  // Clearing the variant has to be expressible; an empty string is that.
  withFile(JSON.stringify({ summaryModel: "openai/gpt-4o-mini", summaryVariant: "" }), (file) => {
    assert.equal(readOverrides(file).summaryVariant, "");
  });
});

test("ignores a wrongly typed summary model or variant", () => {
  withFile(JSON.stringify({ summaryModel: 7, summaryVariant: ["high"] }), (file) => {
    const overrides = readOverrides(file);
    assert.equal("summaryModel" in overrides, false);
    assert.equal("summaryVariant" in overrides, false);
  });
});

test("survives a missing or unparseable settings file", () => {
  assert.deepEqual(readOverrides(path.join(os.tmpdir(), "definitely-absent.json")), {});
  withFile("{ not json", (file) => {
    assert.deepEqual(readOverrides(file), {});
  });
  withFile("[1,2,3]", (file) => {
    assert.deepEqual(readOverrides(file), {}, "an array is not a settings object");
  });
});

test("initial settings apply file overrides over the defaults", () => {
  withFile(JSON.stringify({ voice: "tr-TR-EmelNeural", summaryModel: "a/b" }), (file) => {
    const settings = initialSettings(file);
    assert.equal(settings.voice, "tr-TR-EmelNeural");
    assert.equal(settings.summaryModel, "a/b");
    assert.equal(settings.summaryVariant, "");
    // Untouched keys keep their default.
    assert.equal(settings.engine, "edge");
  });
});

test("the file wins over the built-in default for a voice", () => {
  // The regression this guards: a missing key in the durable record fell back
  // to DEFAULTS instead of to the file, so a voice or language set in the
  // config file silently reverted to English.
  withFile(JSON.stringify({ voice: "tr-TR-DenizNeural" }), (file) => {
    assert.equal(initialSettings(file).voice, "tr-TR-DenizNeural");
    assert.notEqual(initialSettings(file).voice, DEFAULTS.voice);
  });
});
