import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSummarize, summarizeForSpeech, parseModel } from "../lib/summarize.ts";

/** A client that records what it was asked and answers with `reply`. */
function stubClient(reply) {
  const calls = [];
  return {
    calls,
    generate: {
      async text(input) {
        calls.push(input);
        return { data: { text: typeof reply === "function" ? reply(input) : reply } };
      },
    },
    // A real client has these too. If the code reaches for them the test
    // fails loudly instead of quietly polluting a conversation.
    session: {
      async generate() {
        throw new Error("session.generate must not be used for summarisation");
      },
      async create() {
        throw new Error("no session should be created for summarisation");
      },
    },
  };
}

test("short answers are not summarised", () => {
  assert.equal(shouldSummarize("All done."), false);
});

test("long answers are summarised", () => {
  assert.equal(shouldSummarize("x".repeat(700)), true);
});

test("uses the stateless generate endpoint and returns its text", async () => {
  const client = stubClient("Fixed the config loader.");
  const out = await summarizeForSpeech(client, { answer: "x".repeat(700) });
  assert.equal(out.ok, true);
  assert.equal(out.text, "Fixed the config loader.");
  assert.equal(client.calls.length, 1);
});

test("never writes into the conversation", async () => {
  // The stub throws if session.generate or session.create is touched, so
  // simply completing is the assertion.
  const client = stubClient("Short and spoken.");
  const out = await summarizeForSpeech(client, { answer: "A long answer. ".repeat(80) });
  assert.equal(out.ok, true);
  assert.equal("sessionID" in client.calls[0], false, "no session may be named");
});

test("frames the answer as an answer, not as a user message", async () => {
  const client = stubClient("ok");
  await summarizeForSpeech(client, { answer: "HERE IS THE ANSWER" });
  const { prompt } = client.calls[0];
  assert.match(prompt, /HERE IS THE ANSWER/, "the answer must still reach the model");
  assert.match(prompt, /---/, "the answer must be delimited from the instruction");
  assert.match(prompt, /not a message from the user/i, "the framing must say what the text is");
});

test("sends the chosen model when one is set", async () => {
  const client = stubClient("ok");
  await summarizeForSpeech(client, { answer: "x".repeat(700), model: "openai/gpt-4o-mini" });
  assert.deepEqual(client.calls[0].model, { providerID: "openai", id: "gpt-4o-mini" });
});

test("omits the model when none is chosen", async () => {
  const client = stubClient("ok");
  await summarizeForSpeech(client, { answer: "x".repeat(700), model: "" });
  assert.equal("model" in client.calls[0], false);
});

test("parses provider/model ids", () => {
  assert.deepEqual(parseModel("opencode/space-bunny-free"), {
    providerID: "opencode",
    id: "space-bunny-free",
  });
  // Provider ids can contain slashes; only the last one separates.
  assert.deepEqual(parseModel("openrouter/anthropic/claude-haiku-4"), {
    providerID: "openrouter/anthropic",
    id: "claude-haiku-4",
  });
  assert.equal(parseModel(""), undefined);
  assert.equal(parseModel("no-slash"), undefined);
  assert.equal(parseModel("/leading"), undefined);
  assert.equal(parseModel("trailing/"), undefined);
});

test("reports why generation failed instead of failing silently", async () => {
  const client = {
    generate: {
      async text() {
        throw new Error("Unauthorized: authentication required");
      },
    },
  };
  const out = await summarizeForSpeech(client, { answer: "hello".repeat(200) });
  assert.equal(out.ok, false);
  // The whole point: the user can act on this instead of guessing.
  assert.match(out.reason, /Unauthorized/);
});

test("distinguishes an empty completion from a failure", async () => {
  const out = await summarizeForSpeech(stubClient("  "), { answer: "hi" });
  assert.equal(out.ok, false);
  assert.match(out.reason, /nothing/i);
});

test("rejects a model that echoes the answer back", async () => {
  const client = stubClient((input) => input.prompt);
  const out = await summarizeForSpeech(client, { answer: "original text" });
  assert.equal(out.ok, false);
  assert.match(out.reason, /echoed/i);
});

test("keeps a failure reason short enough for a toast", async () => {
  const client = {
    generate: {
      async text() {
        throw new Error("x".repeat(500));
      },
    },
  };
  const out = await summarizeForSpeech(client, { answer: "hello".repeat(200) });
  assert.equal(out.ok, false);
  assert.ok(out.reason.length <= 120, `reason was ${out.reason.length} characters`);
});
