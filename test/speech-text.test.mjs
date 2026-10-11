import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkForSynthesis, normalizeForSpeech } from "../lib/speech-text.ts";

test("strips code fences but marks them", () => {
  const out = normalizeForSpeech("Done.\n\n```js\nconst x = 1\n```\n\nThat's it.");
  assert.match(out, /Code block/);
  assert.doesNotMatch(out, /const x/);
});

test("splits camelCase identifiers but leaves PascalCase words alone", () => {
  assert.match(normalizeForSpeech("parseConfig is fine"), /parse Config is fine/);
  assert.match(normalizeForSpeech("OpenCode is fine"), /OpenCode is fine/);
});

test("shortens file paths to file name", () => {
  const out = normalizeForSpeech("see src/utils/helpers.ts now");
  assert.match(out, /helpers dot ts/);
  assert.doesNotMatch(out, /src\/utils/);
});

test("expands acronyms by default and can be turned off", () => {
  assert.match(normalizeForSpeech("valid JSON"), /jay son/);
  assert.doesNotMatch(normalizeForSpeech("valid JSON", { expandAcronyms: false }), /jay son/);
});

test("replaces opaque tokens instead of reading them out", () => {
  const hash = "a1b2c3d4e5f6";
  assert.doesNotMatch(normalizeForSpeech(`committed ${hash}`), new RegExp(hash));
  assert.doesNotMatch(normalizeForSpeech("see https://example.com/x now"), /example\.com/);
});

test("always ends with terminal punctuation", () => {
  assert.match(normalizeForSpeech("no punctuation here"), /\.$/);
});

test("returns empty string for empty input", () => {
  assert.equal(normalizeForSpeech(""), "");
});

test("chunkForSynthesis keeps short text in one piece", () => {
  assert.deepEqual(chunkForSynthesis("one. two."), ["one. two."]);
});

test("chunkForSynthesis splits on sentence boundaries within the limit", () => {
  const text = "A".repeat(90) + ". " + "B".repeat(90) + ". ";
  const chunks = chunkForSynthesis(text, 100);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 100, `chunk too long: ${c.length}`);
});

test("chunkForSynthesis hard-splits a single oversized sentence", () => {
  const chunks = chunkForSynthesis("X".repeat(250), 100);
  assert.equal(chunks.length, 3);
});

test("chunkForSynthesis returns nothing for blank input", () => {
  assert.deepEqual(chunkForSynthesis("   "), []);
});
