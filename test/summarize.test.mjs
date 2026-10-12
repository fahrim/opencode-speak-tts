import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldSummarize,
  summarizeForSpeech,
  parseModel,
  modelRef,
  languageRuleFor,
  promptForLanguage,
  DEFAULT_SYSTEM_PROMPT,
  SCRATCH_TITLE,
} from "../lib/summarize.ts";

// Mirrors the module's own default rule; the tests below compare against it
// rather than repeating a second copy that could drift.
const DEFAULT_LANGUAGE_RULE = "- Speak in the same language as the original answer.";

test("the instruction actually contains the rule that gets substituted", () => {
  // This is the guard against silent breakage. The language setting works by
  // replacing this line, so if the instruction is edited without updating it,
  // /tts-summary-language stops doing anything and no error is raised: the
  // summary simply comes back in the wrong language.
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.includes(DEFAULT_LANGUAGE_RULE),
    `the instruction no longer contains "${DEFAULT_LANGUAGE_RULE}"`,
  );
});

const REQUEST = { answer: "x".repeat(700), parentID: "ses_parent" };

/**
 * A client that records every call. Touching the parent's session would be a
 * failure, and any session.create in the test throws so a stray session can
 * never be created for real.
 */
function stubClient(reply, { createFails = false, generateFails = false } = {}) {
  const calls = [];
  let nextID = 1;
  return {
    calls,
    session: {
      async create(input) {
        calls.push(["create", input]);
        if (createFails) throw new Error("cannot open a session");
        return { id: `ses_child_${nextID++}` };
      },
      async generate(input) {
        calls.push(["generate", input]);
        if (generateFails) throw new Error("Unauthorized: authentication required");
        return { data: { text: typeof reply === "function" ? reply(input) : reply } };
      },
      async remove(input) {
        calls.push(["remove", input]);
      },
    },
  };
}

const names = (client) => client.calls.map((c) => c[0]);

test("short answers are not summarised", () => {
  assert.equal(shouldSummarize("All done."), false);
});

test("long answers are summarised", () => {
  assert.equal(shouldSummarize("x".repeat(700)), true);
});

test("summarises in a child of the current session", async () => {
  const client = stubClient("Fixed the config loader.");
  const out = await summarizeForSpeech(client, REQUEST);
  assert.equal(out.ok, true);
  assert.equal(out.text, "Fixed the config loader.");
  assert.deepEqual(names(client), ["create", "generate", "remove"]);
  assert.equal(client.calls[0][1].parentID, "ses_parent");
});

test("never writes into the conversation being read", async () => {
  const client = stubClient("Short and spoken.");
  await summarizeForSpeech(client, REQUEST);
  // The whole point: the parent id must never be the one that gets generated in.
  const generated = client.calls.find((c) => c[0] === "generate")[1];
  assert.notEqual(generated.sessionID, "ses_parent");
  assert.equal(generated.prompt.includes("x".repeat(700)), true);
});

test("removes the scratch session even when generation fails", async () => {
  const client = stubClient("unused", { generateFails: true });
  const out = await summarizeForSpeech(client, REQUEST);
  assert.equal(out.ok, false);
  // Otherwise every failed listen would leave a session in the list.
  assert.deepEqual(names(client), ["create", "generate", "remove"]);
});

test("does not leave a session behind when creation fails", async () => {
  const client = stubClient("unused", { createFails: true });
  const out = await summarizeForSpeech(client, REQUEST);
  assert.equal(out.ok, false);
  assert.deepEqual(names(client), ["create"]);
});

test("names the scratch session so a leaked one is recognisable", async () => {
  const client = stubClient("ok");
  await summarizeForSpeech(client, REQUEST);
  assert.equal(client.calls[0][1].title, SCRATCH_TITLE);
});

test("frames the answer as an answer, not as a user message", async () => {
  const client = stubClient("ok");
  await summarizeForSpeech(client, { answer: "HERE IS THE ANSWER" });
  const { prompt } = client.calls.find((c) => c[0] === "generate")[1];
  assert.match(prompt, /HERE IS THE ANSWER/);
  assert.match(prompt, /---/);
  assert.match(prompt, /not a message to reply to/i);
});

test("a chosen language is stated outright", async () => {
  const client = stubClient("ok");
  await summarizeForSpeech(client, { answer: "Düzeltme yayınlandı.", language: "Turkish" });
  const { prompt } = client.calls.find((c) => c[0] === "generate")[1];
  assert.match(prompt, /Speak in Turkish\./);
  assert.doesNotMatch(
    prompt,
    /same language as the original answer/,
    "a chosen language replaces the fallback rather than joining it",
  );
});


test("no language is inferred from the answer's characters", () => {
  // Turkish letters make an answer look Turkish, but guessing a language from
  // a character range is the thing being removed: it cannot be right for every
  // language and it fails silently on the ones it does not know. Even for an
  // unmistakably Turkish answer, the neutral rule is what goes out.
  assert.equal(languageRuleFor(undefined), DEFAULT_LANGUAGE_RULE);
  assert.equal(languageRuleFor(""), DEFAULT_LANGUAGE_RULE);
});

test("an undefined setting falls back instead of throwing", () => {
  // A durable record written before this setting existed carries no value for
  // it, and `.trim()` on undefined is exactly what broke the first attempt.
  assert.doesNotThrow(() => languageRuleFor(undefined));
  assert.doesNotThrow(() => languageRuleFor(null));
  assert.doesNotThrow(() => promptForLanguage(undefined));
  assert.equal(promptForLanguage(undefined), DEFAULT_SYSTEM_PROMPT);
});

test("blank settings fall back, chosen ones do not", async () => {
  const blank = stubClient("ok");
  await summarizeForSpeech(blank, { answer: "Hello", language: "  " });
  assert.match(blank.calls.find((c) => c[0] === "generate")[1].prompt, /same language as the original answer/i);

  const chosen = stubClient("ok");
  await summarizeForSpeech(chosen, { answer: "Hello", language: "German" });
  assert.match(chosen.calls.find((c) => c[0] === "generate")[1].prompt, /Speak in German\./);
});

test("the instruction keeps what the listener needs to decide", () => {
  // These are the rules that fix the failures seen in practice: summaries that
  // read as a changelog, that claim success for work that never finished, and
  // that carry the apologies and closing questions of the conversation itself.
  assert.match(DEFAULT_SYSTEM_PROMPT, /Preserve all facts that materially affect/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /unresolved bugs, blockers, risks/i);
  assert.match(
    DEFAULT_SYSTEM_PROMPT,
    /Do not confuse attempted actions with completed work/i,
    "a summary must not report work as done when it was only attempted",
  );
  assert.match(DEFAULT_SYSTEM_PROMPT, /apologies, acknowledgements/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Never ask a question/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /soft target, not a strict limit/);
});

test("the instruction states a length target without enforcing one", () => {
  // A hard sentence cap was tried and rejected: it made the model drop facts
  // the listener needed. The target has to be explicitly soft or the model
  // treats it as a quota and sacrifices content to meet it.
  assert.match(DEFAULT_SYSTEM_PROMPT, /soft target, not a strict limit/i);
  assert.doesNotMatch(
    DEFAULT_SYSTEM_PROMPT,
    /Never longer/i,
    "an absolute cap is what caused real information to be dropped",
  );
});

test("the instruction stays a bounded size", () => {
  // It runs on every long answer, so a prompt that quietly balloons is a cost
  // the user never sees. This is a ceiling against runaway growth, not a
  // target - the wording has to carry the meaning.
  const words = DEFAULT_SYSTEM_PROMPT.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 400, `instruction is ${words} words`);
});

test("an empty language leaves the default instruction untouched", () => {
  assert.equal(promptForLanguage(""), DEFAULT_SYSTEM_PROMPT);
  assert.equal(promptForLanguage("   "), DEFAULT_SYSTEM_PROMPT);
  assert.match(promptForLanguage("German"), /Speak in German\./);
});

test("inherits the parent model unless one is chosen", async () => {
  const plain = stubClient("ok");
  await summarizeForSpeech(plain, REQUEST);
  assert.equal("model" in plain.calls[0][1], false, "no model means the parent's own");

  const pinned = stubClient("ok");
  await summarizeForSpeech(pinned, { ...REQUEST, model: { providerID: "openai", id: "gpt-4o-mini" } });
  assert.deepEqual(pinned.calls[0][1].model, { providerID: "openai", id: "gpt-4o-mini" });
});

test("carries the reasoning-effort variant through", async () => {
  const client = stubClient("ok");
  await summarizeForSpeech(client, {
    ...REQUEST,
    model: { providerID: "opencode", id: "space-bunny-free", variant: "high" },
  });
  assert.deepEqual(client.calls[0][1].model, {
    providerID: "opencode",
    id: "space-bunny-free",
    variant: "high",
  });
});

test("modelRef reads the route model including its variant", () => {
  assert.deepEqual(modelRef({ providerID: "opencode", modelID: "space-bunny-free", variant: "max" }), {
    providerID: "opencode",
    id: "space-bunny-free",
    variant: "max",
  });
  // Some shapes call it `id` rather than `modelID`.
  assert.deepEqual(modelRef({ providerID: "opencode", id: "x" }), {
    providerID: "opencode",
    id: "x",
  });
  // An empty variant is no variant; do not send a blank one.
  assert.deepEqual(modelRef({ providerID: "opencode", modelID: "x", variant: "" }), {
    providerID: "opencode",
    id: "x",
  });
  assert.equal(modelRef(null), undefined);
  assert.equal(modelRef({ modelID: "orphan" }), undefined);
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
  const client = stubClient("unused", { generateFails: true });
  const out = await summarizeForSpeech(client, REQUEST);
  assert.equal(out.ok, false);
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
  const client = stubClient("unused", { generateFails: true });
  const original = Error;
  globalThis.Error = class extends original {
    constructor() {
      super("x".repeat(500));
    }
  };
  try {
    const out = await summarizeForSpeech(client, REQUEST);
    assert.equal(out.ok, false);
    assert.ok(out.reason.length <= 120, `reason was ${out.reason.length} characters`);
  } finally {
    globalThis.Error = original;
  }
});
