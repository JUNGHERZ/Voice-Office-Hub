import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import http from "node:http";
import { test, before, after } from "node:test";

import { promptCacheMinTokens, supportsPromptCache } from "../src/llm/models.js";
import {
  estimatePrefixTokens,
  promptCacheBelowMinimum,
  streamChatCompletion,
  withPromptCache,
} from "../src/native/llmStream.js";
import type { ChatMessage } from "../src/native/types.js";

const PORT = 18101;
const BASE = `http://127.0.0.1:${PORT}`;

const CLAUDE = "bedrock/claude-haiku-4-5@eu-central-1";
const GPT = "openai/gpt-4.1-mini";
const msgs = (sys = "Du bist ein Support-Agent."): ChatMessage[] => [
  { role: "system", content: sys },
  { role: "user", content: "Hallo" },
];

// ── Guard: nur Claude bekommt den Breakpoint ────────────────────────────────

test("supportsPromptCache trennt Claude von allem anderen", () => {
  for (const m of [CLAUDE, "anthropic/claude-haiku-4-5", "vertex/claude-sonnet-4-5"]) {
    assert.equal(supportsPromptCache(m), true, m);
  }
  for (const m of [GPT, "openai/gpt-4o", "google/gemini-2.0-flash", "mistral/mistral-large"]) {
    assert.equal(supportsPromptCache(m), false, m);
  }
});

test("withPromptCache setzt cache_control auf die System-Message", () => {
  const out = withPromptCache(msgs(), CLAUDE, true);
  assert.deepEqual(out[0], {
    role: "system",
    content: [
      { type: "text", text: "Du bist ein Support-Agent.", cache_control: { type: "ephemeral" } },
    ],
  });
  // Alles nach dem Breakpoint bleibt unangetastet (String-Form).
  assert.deepEqual(out[1], { role: "user", content: "Hallo" });
});

test("withPromptCache laesst Nicht-Claude-Modelle unveraendert", () => {
  const input = msgs();
  assert.equal(withPromptCache(input, GPT, true), input);
  assert.equal(typeof withPromptCache(input, GPT, true)[0].content, "string");
});

test("withPromptCache respektiert den Schalter und leere System-Prompts", () => {
  const input = msgs();
  assert.equal(withPromptCache(input, CLAUDE, false), input);
  const noSys: ChatMessage[] = [{ role: "user", content: "Hallo" }];
  assert.equal(withPromptCache(noSys, CLAUDE, true), noSys);
  const emptySys: ChatMessage[] = [{ role: "system", content: "" }, { role: "user", content: "x" }];
  assert.equal(withPromptCache(emptySys, CLAUDE, true), emptySys);
});

// ── Mindestlaenge: Diagnose, kein Gate ──────────────────────────────────────

test("promptCacheMinTokens kennt die Familien und faellt konservativ zurueck", () => {
  assert.equal(promptCacheMinTokens("bedrock/claude-haiku-4-5@eu-central-1"), 4096);
  assert.equal(promptCacheMinTokens("anthropic/claude-opus-4-5"), 4096);
  assert.equal(promptCacheMinTokens("anthropic/claude-opus-4-7"), 2048);
  assert.equal(promptCacheMinTokens("anthropic/claude-sonnet-5"), 1024);
  assert.equal(promptCacheMinTokens("anthropic/claude-opus-5"), 512);
  // Unbekanntes Claude-Modell: hoechster bekannter Wert.
  assert.equal(promptCacheMinTokens("anthropic/claude-neu-9"), 4096);
});

test("promptCacheBelowMinimum meldet nur den wirkungslosen Fall", () => {
  const kurz = msgs();
  const lang = msgs("A".repeat(4096 * 3));
  assert.equal(promptCacheBelowMinimum(kurz, CLAUDE, true), true);
  assert.equal(promptCacheBelowMinimum(lang, CLAUDE, true), false);
  // Ohne Caching bzw. ohne Claude gibt es nichts zu melden.
  assert.equal(promptCacheBelowMinimum(kurz, CLAUDE, false), false);
  assert.equal(promptCacheBelowMinimum(kurz, GPT, true), false);
});

test("estimatePrefixTokens zaehlt Tools mit", () => {
  const ohne = estimatePrefixTokens(msgs());
  const mit = estimatePrefixTokens(msgs(), [
    { type: "function", function: { name: "x", description: "y", parameters: {} } },
  ]);
  assert.ok(mit > ohne, "Tool-Definitionen gehoeren ins cachebare Praefix");
});

// ── Wire-Format + Usage gegen einen echten Server ───────────────────────────

let lastBody: Record<string, unknown> = {};
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, index: 0 }] })}\n\n`);
      // Requesty haengt die Nutzung an das letzte Event — mit choices, aber leerem delta.
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          usage: {
            prompt_tokens: 6166,
            completion_tokens: 19,
            prompt_tokens_details: { cached_tokens: 6141, caching_tokens: 0 },
          },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const call = (model: string, promptCache: boolean) =>
  streamChatCompletion(
    {
      baseUrl: BASE,
      apiKey: "k",
      model,
      messages: msgs(),
      promptCache,
      signal: new AbortController().signal,
    },
    () => {},
  );

test("Claude-Request traegt den Breakpoint auf der Leitung", async () => {
  await call(CLAUDE, true);
  const sys = (lastBody.messages as Array<{ content: unknown }>)[0].content;
  assert.deepEqual(sys, [
    { type: "text", text: "Du bist ein Support-Agent.", cache_control: { type: "ephemeral" } },
  ]);
});

test("Nicht-Claude-Request geht unveraendert als String raus", async () => {
  await call(GPT, true);
  assert.equal((lastBody.messages as Array<{ content: unknown }>)[0].content, "Du bist ein Support-Agent.");
});

test("promptCache ist ohne explizites Flag aus", async () => {
  await streamChatCompletion(
    { baseUrl: BASE, apiKey: "k", model: CLAUDE, messages: msgs(), signal: new AbortController().signal },
    () => {},
  );
  assert.equal(typeof (lastBody.messages as Array<{ content: unknown }>)[0].content, "string");
});

test("Nutzung inklusive Cache-Treffer wird aus dem Stream gelesen", async () => {
  const res = await call(CLAUDE, true);
  assert.deepEqual(res.usage, {
    promptTokens: 6166,
    completionTokens: 19,
    cachedTokens: 6141,
    cacheWriteTokens: 0,
  });
});
