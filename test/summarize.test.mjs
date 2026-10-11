import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSummarize, summarizeForSpeech } from "../lib/summarize.ts";

test("short answers are not summarised", () => {
  assert.equal(shouldSummarize("All done."), false);
});

test("long answers are summarised", () => {
  assert.equal(shouldSummarize("x".repeat(700)), true);
});

test("uses OpenCode's generate endpoint and returns its text", async () => {
  const calls = [];
  const client = {
    session: {
      async generate(input) {
        calls.push(input);
        return { data: { text: "Fixed the config loader." } };
      },
    },
  };
  const out = await summarizeForSpeech(client, { sessionID: "ses_1", prompt: "x".repeat(700) });
  assert.equal(out, "Fixed the config loader.");
  assert.equal(calls[0].sessionID, "ses_1");
});

test("falls back to null when generation fails", async () => {
  const client = {
    session: {
      async generate() {
        throw new Error("model unavailable");
      },
    },
  };
  const out = await summarizeForSpeech(client, { sessionID: "ses_1", prompt: "hello" });
  assert.equal(out, null);
});

test("returns null when the model echoes the prompt back", async () => {
  const client = {
    session: {
      async generate(input) {
        return { data: { text: input.prompt } };
      },
    },
  };
  const out = await summarizeForSpeech(client, { sessionID: "ses_1", prompt: "original text" });
  assert.equal(out, null);
});

test("returns null on an empty completion", async () => {
  const client = { session: { async generate() { return { data: { text: "  " } }; } } };
  assert.equal(await summarizeForSpeech(client, { sessionID: "s", prompt: "hi" }), null);
});
