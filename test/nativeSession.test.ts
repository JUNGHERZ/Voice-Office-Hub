import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { config } from "../src/config.js";
import { NativeSession } from "../src/native/nativeSession.js";
import type { ChatStreamRequest } from "../src/native/llmStream.js";
import type { LlmStreamResult, ChatMessage } from "../src/native/types.js";
import type { FunctionDefinition } from "../src/voice/types.js";
import { settle, testAgent, waitFor } from "./helpers/fakes.js";

// ── Fakes für die drei Beine ─────────────────────────────────────────────────

class FakeStt extends EventEmitter {
  started = false;
  starts = 0;
  closed = false;
  audio: Buffer[] = [];
  async start(): Promise<void> {
    this.started = true;
    this.starts += 1;
  }
  sendAudio(chunk: Buffer): void {
    this.audio.push(chunk);
  }
  close(): void {
    this.closed = true;
  }
  // Skript-API
  speech(): void {
    this.emit("speechStarted");
  }
  turn(transcript: string): void {
    this.emit("turnEnded", transcript);
  }
  eager(transcript: string): void {
    this.emit("eagerTurnEnded", transcript);
  }
  resumed(): void {
    this.emit("turnResumed");
  }
}

class FakeTts extends EventEmitter {
  started = false;
  closed = false;
  texts: string[] = [];
  flushes = 0;
  clears = 0;
  usageResult = { provider: "fake", model: "fake-model", characters: 0 as number, credits: undefined as number | undefined };
  async start(): Promise<void> {
    this.started = true;
  }
  sendText(text: string): void {
    this.texts.push(text);
  }
  flush(): void {
    this.flushes += 1;
  }
  clear(): void {
    this.clears += 1;
  }
  usage() {
    return this.usageResult;
  }
  close(): void {
    this.closed = true;
  }
  // Skript-API
  emitAudio(buf: Buffer = Buffer.alloc(320)): void {
    this.emit("audio", buf);
  }
  emitFlushed(): void {
    this.emit("flushed", 0);
  }
}

type LlmHandler = (
  req: ChatStreamRequest,
  onDelta: (t: string) => void,
) => Promise<LlmStreamResult>;

const FUNCTIONS: FunctionDefinition[] = [
  { name: "get_weather", description: "Wetter", parameters: { type: "object", properties: {} } },
];

interface FakeTimerEntry {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

function makeSession(
  script: LlmHandler[],
  greeting = "Hallo!",
  opts: {
    agent?: Parameters<typeof testAgent>[0];
    localizer?: { resolve(key: string, index?: number): string };
  } = {},
) {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const llmCalls: ChatStreamRequest[] = [];
  const timers: FakeTimerEntry[] = [];
  const session = new NativeSession(
    testAgent({
      voiceProvider: "native",
      greeting,
      listen: { model: "flux-general-multi", language_hints: ["de"], keyterms: [], smart_format: true },
      ...opts.agent,
    }),
    FUNCTIONS,
    "call-native",
    {
      createStt: () => stt,
      createTts: () => tts,
      streamLlm: async (req, onDelta) => {
        llmCalls.push(req);
        const handler = script.shift();
        if (!handler) throw new Error("LLM-Skript erschöpft");
        return handler(req, onDelta);
      },
      setTimer: (fn, ms) => {
        const entry: FakeTimerEntry = { ms, fn, cancelled: false };
        timers.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
    opts.localizer,
  );

  const events: Array<[string, unknown?]> = [];
  for (const ev of [
    "open",
    "welcome",
    "settingsApplied",
    "conversationText",
    "functionCallRequest",
    "userStartedSpeaking",
    "agentStartedSpeaking",
    "agentAudioDone",
    "error",
  ] as const) {
    session.on(ev as never, ((arg: unknown) => events.push([ev, arg])) as never);
  }
  const audio: Buffer[] = [];
  session.on("audio", (b) => audio.push(b));
  return { session, stt, tts, llmCalls, events, audio, timers };
}

/** Feuert einen (auch „abgebrochenen") Fake-Timer; default: den zuletzt geplanten. */
function fireTimer(timers: FakeTimerEntry[], index = timers.length - 1): void {
  timers[index]?.fn();
}

const toolCall = (id: string, name: string, args: string) => ({
  id,
  type: "function" as const,
  function: { name, arguments: args },
});

// 1 ─ Inerte Konstruktion; start() verbindet, meldet open/welcome/settingsApplied und spricht das Greeting.
test("NativeSession: inert + start mit Greeting", async () => {
  const s = makeSession([]);
  assert.equal(s.stt.started, false, "Konstruktion verbindet nicht");
  assert.equal(s.tts.started, false);

  await s.session.start();
  assert.equal(s.stt.started, true);
  assert.equal(s.tts.started, true);
  assert.deepEqual(
    s.events.filter(([e]) => ["open", "settingsApplied"].includes(e)).map(([e]) => e),
    ["open", "settingsApplied"],
  );
  assert.deepEqual(s.tts.texts, ["Hallo!"], "Greeting geht in die TTS");
  assert.equal(s.tts.flushes, 1);
  assert.deepEqual(
    s.events.find(([e]) => e === "conversationText")?.[1],
    { role: "assistant", content: "Hallo!" },
    "Transkript-Parität: Greeting als Assistant-Turn",
  );
  s.session.close();
});

// 2 ─ Voller Turn: EndOfTurn → LLM-Deltas → Satz-Overlap in die TTS → Latenz-Event → agentAudioDone.
test("NativeSession: voller Turn mit Overlap und Latenzmessung", async () => {
  const s = makeSession([
    async (_req, onDelta) => {
      onDelta("Einen Moment bitte. Ich prü");
      onDelta("fe das kurz");
      return { content: "Einen Moment bitte. Ich prüfe das kurz", toolCalls: [] };
    },
  ]);
  await s.session.start();

  s.stt.turn("Wie ist das Wetter?");
  await waitFor(() => s.llmCalls.length === 1);
  await settle();

  const msgs = s.llmCalls[0]!.messages;
  assert.equal(msgs[0]?.role, "system");
  assert.equal(msgs[msgs.length - 1]?.content, "Wie ist das Wetter?");
  // Erster Satz ging bereits während des Streams raus, der Rest beim Abschluss.
  assert.deepEqual(s.tts.texts.slice(1), ["Einen Moment bitte.", "Ich prüfe das kurz"]);
  assert.ok(s.tts.flushes >= 2);

  s.tts.emitAudio();
  const started = s.events.find(([e]) => e === "agentStartedSpeaking");
  assert.ok(started, "agentStartedSpeaking beim ersten TTS-Audio des Turns");
  const latency = started![1] as { total: number; ttt?: number };
  assert.ok(latency.total >= 0 && typeof latency.ttt === "number");
  assert.equal(s.audio.length, 1, "Audio wird durchgereicht");

  s.tts.emitFlushed();
  assert.ok(s.events.some(([e]) => e === "agentAudioDone"));
  assert.deepEqual(
    s.events.filter(([e]) => e === "conversationText").map(([, v]) => (v as { role: string }).role),
    ["assistant", "user", "assistant"],
    "Greeting + User-Turn + Antwort im Transkript",
  );
  s.session.close();
});

// 3 ─ Tool-Loop: tool_calls → functionCallRequest → Response → zweite LLM-Runde mit tool-Message.
test("NativeSession: Tool-Loop mit Fortsetzung", async () => {
  let secondRoundMessages: ChatMessage[] = [];
  const s = makeSession([
    async () => ({ content: "", toolCalls: [toolCall("t1", "get_weather", '{"location":"Berlin"}')] }),
    async (req, onDelta) => {
      secondRoundMessages = req.messages;
      onDelta("In Berlin sind es 20 Grad.");
      return { content: "In Berlin sind es 20 Grad.", toolCalls: [] };
    },
  ]);
  await s.session.start();

  s.stt.turn("Wetter in Berlin?");
  await waitFor(() => s.events.some(([e]) => e === "functionCallRequest"));
  const fcr = s.events.find(([e]) => e === "functionCallRequest")![1] as {
    functions: Array<{ id: string; name: string; argumentsJson: string; clientSide: boolean }>;
  };
  assert.deepEqual(fcr.functions, [
    { id: "t1", name: "get_weather", argumentsJson: '{"location":"Berlin"}', clientSide: true },
  ]);
  assert.equal(s.llmCalls.length, 1, "zweite Runde erst nach der Tool-Antwort");

  s.session.sendFunctionResponse("t1", "get_weather", { temp: 20 });
  await waitFor(() => s.llmCalls.length === 2);
  await settle();

  const toolMsg = secondRoundMessages.find((m) => m.role === "tool");
  assert.equal(toolMsg?.tool_call_id, "t1");
  assert.match(String(toolMsg?.content), /"temp":20/);
  assert.ok(s.tts.texts.includes("In Berlin sind es 20 Grad."));
  s.session.close();
});

// 4 ─ Zwei parallele Tool-Calls: Fortsetzung erst, wenn ALLE beantwortet sind.
test("NativeSession: parallele Tool-Calls sammeln sich", async () => {
  const s = makeSession([
    async () => ({
      content: "",
      toolCalls: [toolCall("t1", "get_weather", "{}"), toolCall("t2", "get_weather", "{}")],
    }),
    async () => ({ content: "Fertig.", toolCalls: [] }),
  ]);
  await s.session.start();
  s.stt.turn("Beides bitte prüfen!");
  await waitFor(() => s.events.some(([e]) => e === "functionCallRequest"));

  s.session.sendFunctionResponse("t1", "get_weather", { a: 1 });
  await settle();
  assert.equal(s.llmCalls.length, 1, "nach der ersten Antwort noch keine Fortsetzung");

  s.session.sendFunctionResponse("t2", "get_weather", { b: 2 });
  await waitFor(() => s.llmCalls.length === 2);
  s.session.close();
});

// 5 ─ Barge-in: LLM abgebrochen, TTS geleert, verspätetes Audio stumm, Folge-Turn funktioniert.
test("NativeSession: Barge-in-Abbruchkette mit Quarantäne", async () => {
  const s = makeSession([
    async (req, onDelta) => {
      onDelta("Das ist ein sehr langer erster Satz. Und der geht noch");
      return new Promise((_, reject) => {
        req.signal.addEventListener("abort", () =>
          reject(new DOMException("abgebrochen", "AbortError")),
        );
      });
    },
    async (_req, onDelta) => {
      onDelta("Neue Antwort nach dem Barge-in.");
      return { content: "Neue Antwort nach dem Barge-in.", toolCalls: [] };
    },
  ]);
  await s.session.start();

  s.stt.turn("Erste Frage");
  await waitFor(() => s.tts.texts.length === 2, 1000); // Greeting + erster Satz
  assert.equal(s.tts.texts[1], "Das ist ein sehr langer erster Satz.");

  s.stt.speech(); // Anrufer redet rein
  await settle();
  assert.ok(s.events.some(([e]) => e === "userStartedSpeaking"));
  assert.equal(s.tts.clears, 1, "TTS serverseitig geleert");

  const audioBefore = s.audio.length;
  s.tts.emitAudio(); // verspäteter Frame des abgebrochenen Turns
  assert.equal(s.audio.length, audioBefore, "stales Audio wird quarantänisiert");

  s.stt.turn("Zweite Frage");
  await waitFor(() => s.llmCalls.length === 2);
  await settle();
  assert.ok(s.tts.texts.includes("Neue Antwort nach dem Barge-in."));
  s.tts.emitAudio();
  assert.equal(s.audio.length, audioBefore + 1, "neuer Turn liefert wieder Audio");
  s.session.close();
});

// 6 ─ injectMessage: aktiver Turn wird verworfen; stale Tool-Response setzt NICHT fort.
test("NativeSession: injectMessage verwirft und spricht die Zeile", async () => {
  const s = makeSession([
    async (_req, onDelta) => {
      onDelta("Einen Moment, ich verbinde Sie. ");
      return {
        content: "Einen Moment, ich verbinde Sie. ",
        toolCalls: [toolCall("t1", "transfer_call", '{"target":"101"}')],
      };
    },
  ]);
  await s.session.start();
  s.stt.turn("Bitte verbinden Sie mich");
  await waitFor(() => s.events.some(([e]) => e === "functionCallRequest"));

  s.session.injectMessage("Ich konnte leider niemanden erreichen.");
  await settle();
  assert.ok(s.tts.texts.includes("Ich konnte leider niemanden erreichen."));
  assert.equal(s.tts.clears, 1, "laufende Ausgabe wurde verworfen");

  // Transfer-Ergebnis trifft verspätet ein → nur Historie, keine LLM-Fortsetzung.
  s.session.sendFunctionResponse("t1", "transfer_call", { connected: false });
  await settle(6);
  assert.equal(s.llmCalls.length, 1, "stale Generation setzt nicht fort");
  s.session.close();
});

// 7 ─ end_call-Muster: keine Response → kein Hänger, keine weitere Runde; close() räumt auf.
test("NativeSession: end_call ohne Response blockiert nichts", async () => {
  const s = makeSession([
    async (_req, onDelta) => {
      onDelta("Auf Wiederhören! ");
      return { content: "Auf Wiederhören! ", toolCalls: [toolCall("e1", "end_call", "{}")] };
    },
  ]);
  await s.session.start();
  s.stt.turn("Tschüss!");
  await waitFor(() => s.events.some(([e]) => e === "functionCallRequest"));
  await settle(4);

  assert.ok(s.tts.texts.includes("Auf Wiederhören!"), "Abschied ist in der TTS");
  assert.equal(s.llmCalls.length, 1, "keine Fortsetzung ohne Response");
  s.session.close(); // weckt die wartende Runde — Test endet ohne Leak/Hänger
  assert.equal(s.stt.closed, true);
  assert.equal(s.tts.closed, true);
});

// 9 ─ STT-Drop: genau EIN automatischer Reconnect; erst der zweite Drop wird zum Fehler.
test("NativeSession: STT-Reconnect genau einmal", async () => {
  const s = makeSession([]);
  await s.session.start();
  assert.equal(s.stt.starts, 1);

  s.stt.emit("close", 4006);
  await waitFor(() => s.stt.starts === 2, 1000);
  assert.ok(!s.events.some(([e]) => e === "error"), "erster Drop wird still überbrückt");

  s.stt.emit("close", 4006);
  await settle();
  assert.match(String(s.events.find(([e]) => e === "error")?.[1] ?? ""), /STT-Verbindung verloren/);
  assert.equal(s.stt.starts, 2, "kein zweiter Reconnect-Versuch");
  s.session.close();
});

// 8 ─ LLM-Fehler ist nicht fatal: error-Event, Session lebt, nächster Turn klappt.
test("NativeSession: LLM-Fehler → error-Event, Session bleibt nutzbar", async () => {
  const s = makeSession([
    async () => {
      throw new Error("HTTP 500: kaputt");
    },
    async (_req, onDelta) => {
      onDelta("Jetzt klappt es wieder.");
      return { content: "Jetzt klappt es wieder.", toolCalls: [] };
    },
  ]);
  await s.session.start();

  s.stt.turn("Erste Frage");
  await waitFor(() => s.events.some(([e]) => e === "error"));
  assert.match(String(s.events.find(([e]) => e === "error")![1]), /LLM:.*HTTP 500/);

  s.stt.turn("Zweite Frage");
  await waitFor(() => s.llmCalls.length === 2);
  await settle();
  assert.ok(s.tts.texts.includes("Jetzt klappt es wieder."));
  s.session.close();
});

// 10 ─ TTS-Verbrauch: getUsage() reicht die Zahlen des TTS-Beins durch (Kostenmetrik).
test("NativeSession: getUsage() liefert den TTS-Verbrauch", async () => {
  const s = makeSession([]);
  await s.session.start();

  assert.equal(s.session.getUsage(), undefined, "0 Zeichen → kein Verbrauch");

  s.tts.usageResult = { provider: "eleven_labs", model: "eleven_flash_v2_5", characters: 4714, credits: 2357 };
  assert.deepEqual(s.session.getUsage(), {
    ttsProvider: "eleven_labs",
    ttsModel: "eleven_flash_v2_5",
    ttsCharacters: 4714,
    ttsCredits: 2357,
  });
  s.session.close();
});

// ── EagerEndOfTurn-Spekulation (0.6.17) ──────────────────────────────────────
// Flag wird bei Konstruktion eingefroren — Tests schalten config vor makeSession um.

function withEagerEot<T>(fn: () => Promise<T>): Promise<T> {
  (config.native as { eagerEot: boolean }).eagerEot = true;
  return fn().finally(() => {
    (config.native as { eagerEot: boolean }).eagerEot = false;
  });
}

// 11 ─ Bestätigte Spekulation: LLM läuft auf das Eager-Transkript; nichts geht nach
//      außen, bis EndOfTurn (gleicher Wortlaut, andere Interpunktion) bestätigt.
test("NativeSession: EagerEOT bestätigt — ein LLM-Call, Gate öffnet erst am Turn-Ende", () =>
  withEagerEot(async () => {
    const s = makeSession([
      async (_req, onDelta) => {
        onDelta("Es sind 20 Grad. ");
        return { content: "Es sind 20 Grad. ", toolCalls: [] };
      },
    ]);
    await s.session.start();

    s.stt.eager("wie ist das wetter");
    await waitFor(() => s.llmCalls.length === 1);
    await settle();
    assert.deepEqual(s.tts.texts, ["Hallo!"], "vor Bestätigung geht nichts in die TTS");
    assert.ok(
      !s.events.some(([e, v]) => e === "conversationText" && (v as { role: string }).role === "user"),
      "kein User-Transkript vor Bestätigung",
    );
    const msgs = s.llmCalls[0]!.messages;
    assert.equal(msgs[msgs.length - 1]?.content, "wie ist das wetter", "Eager-Text nur im Request");

    s.stt.turn("Wie ist das Wetter?");
    await settle();
    assert.ok(s.tts.texts.includes("Es sind 20 Grad."), "gepufferter Satz wird gesprochen");
    assert.equal(s.llmCalls.length, 1, "kein zweiter LLM-Call nach Bestätigung");
    assert.deepEqual(
      s.events.filter(([e]) => e === "conversationText").map(([, v]) => (v as { role: string }).role),
      ["assistant", "user", "assistant"],
      "Greeting, User (bei Bestätigung), Antwort",
    );
    s.session.close();
  }));

// 12 ─ TurnResumed: Spekulation wird abgebrochen (LLM-Abort), für den Anrufer unhörbar;
//      der echte Turn läuft danach frisch.
test("NativeSession: EagerEOT + TurnResumed — Abbruch ohne Außenwirkung", () =>
  withEagerEot(async () => {
    let aborts = 0;
    const s = makeSession([
      async (req) =>
        new Promise((_, reject) => {
          req.signal.addEventListener("abort", () => {
            aborts += 1;
            reject(new DOMException("abgebrochen", "AbortError"));
          });
        }),
      async (_req, onDelta) => {
        onDelta("Antwort auf die echte Frage.");
        return { content: "Antwort auf die echte Frage.", toolCalls: [] };
      },
    ]);
    await s.session.start();

    s.stt.eager("halb fertige fra");
    await waitFor(() => s.llmCalls.length === 1);
    s.stt.resumed();
    await settle();
    assert.equal(aborts, 1, "spekulativer LLM-Call wird abgebrochen");
    assert.deepEqual(s.tts.texts, ["Hallo!"], "keine TTS-Ausgabe der Spekulation");

    s.stt.turn("Die ganze Frage bitte?");
    await waitFor(() => s.llmCalls.length === 2);
    await settle();
    assert.ok(s.tts.texts.includes("Antwort auf die echte Frage."));
    const msgs = s.llmCalls[1]!.messages;
    assert.equal(msgs[msgs.length - 1]?.content, "Die ganze Frage bitte?");
    assert.equal(
      msgs.filter((m) => m.role === "user").length,
      1,
      "kein spekulativer User-Rest in der Historie",
    );
    s.session.close();
  }));

// 13 ─ Abweichendes Final-Transkript: Spekulation verworfen, frischer Turn mit dem
//      bestätigten Text (der Nutzer hat weitergesprochen, ohne dass TurnResumed kam).
test("NativeSession: EagerEOT mit abweichendem Final — Neustart mit Final-Text", () =>
  withEagerEot(async () => {
    const s = makeSession([
      async (req) =>
        new Promise((_, reject) => {
          req.signal.addEventListener("abort", () =>
            reject(new DOMException("abgebrochen", "AbortError")),
          );
        }),
      async (_req, onDelta) => {
        onDelta("In Berlin sind es 20 Grad.");
        return { content: "In Berlin sind es 20 Grad.", toolCalls: [] };
      },
    ]);
    await s.session.start();

    s.stt.eager("wie ist das wetter");
    await waitFor(() => s.llmCalls.length === 1);
    s.stt.turn("Wie ist das Wetter in Berlin?");
    await waitFor(() => s.llmCalls.length === 2);
    await settle();

    const msgs = s.llmCalls[1]!.messages;
    assert.equal(msgs[msgs.length - 1]?.content, "Wie ist das Wetter in Berlin?");
    assert.ok(s.tts.texts.includes("In Berlin sind es 20 Grad."));
    assert.equal(
      s.events.filter(([e, v]) => e === "conversationText" && (v as { role: string }).role === "user").length,
      1,
      "nur der bestätigte User-Turn im Transkript",
    );
    s.session.close();
  }));

// 14 ─ Tool-Calls einer Spekulation warten hinter dem Gate: kein functionCallRequest
//      (= keine Seiteneffekte) vor dem bestätigten Turn-Ende.
test("NativeSession: EagerEOT — Tool-Calls erst nach Bestätigung", () =>
  withEagerEot(async () => {
    const s = makeSession([
      async () => ({ content: "", toolCalls: [toolCall("t1", "get_weather", "{}")] }),
      async (_req, onDelta) => {
        onDelta("Fertig geprüft.");
        return { content: "Fertig geprüft.", toolCalls: [] };
      },
    ]);
    await s.session.start();

    s.stt.eager("wetter bitte");
    await waitFor(() => s.llmCalls.length === 1);
    await settle(4);
    assert.ok(
      !s.events.some(([e]) => e === "functionCallRequest"),
      "Tool-Call bleibt hinter dem Gate",
    );

    s.stt.turn("Wetter bitte!");
    await waitFor(() => s.events.some(([e]) => e === "functionCallRequest"));
    s.session.sendFunctionResponse("t1", "get_weather", { ok: true });
    await waitFor(() => s.llmCalls.length === 2);
    await settle();
    assert.ok(s.tts.texts.includes("Fertig geprüft."));
    s.session.close();
  }));

// 15 ─ Flag aus (Default): EagerEndOfTurn wird ignoriert, kein spekulativer LLM-Start.
test("NativeSession: EagerEOT aus — kein spekulativer Start", async () => {
  const s = makeSession([]);
  await s.session.start();
  s.stt.eager("wie ist das wetter");
  await settle(4);
  assert.equal(s.llmCalls.length, 0, "ohne Flag keine Spekulation");
  s.session.close();
});

// 16 ─ Eager-Flag ⇒ Flux bekommt IMMER eine eager_eot_threshold (ohne sie deaktiviert
//      Flux den Eager-Modus komplett — das Flag liefe sonst stumm ins Leere).
test("NativeSession: EagerEOT sendet Default-Threshold an Flux", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const build = () =>
    new NativeSession(
      testAgent({ voiceProvider: "native" }),
      [],
      "call-thresh",
      {
        createStt: (opts) => {
          captured.push(opts as unknown as Record<string, unknown>);
          return new FakeStt();
        },
        createTts: () => new FakeTts(),
        streamLlm: async () => ({ content: "", toolCalls: [] }),
      },
    );

  build(); // Flag aus (Default): keine Schwelle
  assert.equal(captured[0]!.eagerEotThreshold, undefined);

  await withEagerEot(async () => {
    build(); // Flag an, kein expliziter Wert → Default 0.5
    assert.equal(captured[1]!.eagerEotThreshold, 0.5);
  });
});

// ── Timer-Filler (0.6.26) ────────────────────────────────────────────────────

const fillerAgent = (over: Parameters<typeof testAgent>[0] = {}) => ({
  fillers: { enabled: true, delayMs: 2000, phrases: ["Einen Moment bitte."] },
  ...over,
});

const customTool = (name: string, fillerPhrase?: string) => ({
  name,
  description: "",
  parameters: { type: "object", properties: {} },
  endpoint: { url: "https://x.test", method: "POST" as const, headers: {}, timeoutMs: 8000 },
  enabled: true,
  ...(fillerPhrase ? { fillerPhrase } : {}),
});

async function driveToolRound(s: ReturnType<typeof makeSession>, transcript = "Bitte nachsehen."): Promise<void> {
  await s.session.start();
  s.stt.turn(transcript);
  await waitFor(() => s.events.some(([e]) => e === "functionCallRequest"));
  await settle();
}

// F1 ─ Filler feuert bei customTool-Runde; landet im Transkript, aber NICHT in der LLM-Historie.
test("Filler: feuert bei customTool-Runde, nur ins Transkript (nicht in die Historie)", async () => {
  let round2: ChatMessage[] = [];
  const s = makeSession(
    [
      async () => ({ content: "", toolCalls: [toolCall("t1", "crm_lookup", "{}")] }),
      async (req) => {
        round2 = req.messages;
        return { content: "Fertig.", toolCalls: [] };
      },
    ],
    "Hallo!",
    { agent: fillerAgent() },
  );
  await driveToolRound(s, "Schau bitte im CRM nach.");

  assert.equal(s.timers.length, 1, "genau ein Filler-Timer für die Runde");
  fireTimer(s.timers);
  assert.ok(s.tts.texts.includes("Einen Moment bitte."), "Filler wird gesprochen");
  assert.ok(
    s.events.some(
      ([e, v]) => e === "conversationText" && (v as { content: string }).content === "Einen Moment bitte.",
    ),
    "Filler erscheint im Transkript",
  );

  s.session.sendFunctionResponse("t1", "crm_lookup", { ok: true });
  await waitFor(() => s.llmCalls.length === 2);
  assert.ok(
    !round2.some((m) => m.role === "assistant" && m.content === "Einen Moment bitte."),
    "Filler steht NICHT in der LLM-Historie (kein OpenAI-400)",
  );
  s.session.close();
});

// F1b ─ Der Filler selbst löst keine Latenzmessung aus, die Tool-Fortsetzung danach schon.
// Ohne das bleiben ausgerechnet die langsamen Runden (die mit Filler) ungemessen.
test("Filler: unterdrückt die Latenzmessung nur für sich, nicht für die Fortsetzung", async () => {
  const s = makeSession(
    [
      async () => ({ content: "", toolCalls: [toolCall("t1", "crm_lookup", "{}")] }),
      async (_req, onDelta) => {
        onDelta("Der Vorgang ist in Bearbeitung.");
        return { content: "Der Vorgang ist in Bearbeitung.", toolCalls: [] };
      },
    ],
    "Hallo!",
    { agent: fillerAgent() },
  );
  await driveToolRound(s, "Schau bitte im CRM nach.");

  fireTimer(s.timers);
  s.tts.emitAudio(); // Audio des Fillers
  assert.ok(
    !s.events.some(([e]) => e === "agentStartedSpeaking"),
    "der Filler selbst zählt nicht als Antwortbeginn (A/B bleibt sauber)",
  );

  s.session.sendFunctionResponse("t1", "crm_lookup", { ok: true });
  await waitFor(() => s.tts.texts.includes("Der Vorgang ist in Bearbeitung."));
  s.tts.emitAudio(); // erstes Audio der eigentlichen Antwort
  assert.ok(
    s.events.some(([e]) => e === "agentStartedSpeaking"),
    "die Fortsetzung nach der Tool-Antwort wird wieder gemessen",
  );
  s.session.close();
});

// F2 ─ Kein Filler bei end_call / transfer_call / reinem get_weather.
test("Filler: kein Timer bei end_call / transfer_call / reinem get_weather", async () => {
  for (const name of ["end_call", "transfer_call", "get_weather"]) {
    const s = makeSession(
      [async () => ({ content: "", toolCalls: [toolCall("t1", name, "{}")] })],
      "Hallo!",
      { agent: fillerAgent() },
    );
    await driveToolRound(s, "Mach das bitte.");
    assert.equal(s.timers.length, 0, `${name}: kein Filler-Timer`);
    s.session.close();
  }
});

// F3 ─ MCP-Runde (<server>_<tool>, kein Builtin) ist fillbar.
test("Filler: MCP-Runde ist fillbar", async () => {
  const s = makeSession(
    [async () => ({ content: "", toolCalls: [toolCall("t1", "crm_server_lookup", "{}")] })],
    "Hallo!",
    { agent: fillerAgent() },
  );
  await driveToolRound(s);
  assert.equal(s.timers.length, 1);
  fireTimer(s.timers);
  assert.ok(s.tts.texts.includes("Einen Moment bitte."));
  s.session.close();
});

// F4 ─ Per-Tool-Phrase hat Vorrang vor dem Pool.
test("Filler: Per-Tool-Phrase hat Vorrang vor dem Pool", async () => {
  const s = makeSession(
    [async () => ({ content: "", toolCalls: [toolCall("t1", "crm_lookup", "{}")] })],
    "Hallo!",
    { agent: fillerAgent({ customTools: [customTool("crm_lookup", "Ich sehe im CRM nach…")] }) },
  );
  await driveToolRound(s, "Schau im CRM.");
  fireTimer(s.timers);
  assert.ok(s.tts.texts.includes("Ich sehe im CRM nach…"), "Per-Tool-Phrase gesprochen");
  assert.ok(!s.tts.texts.includes("Einen Moment bitte."), "Pool-Phrase nicht genutzt");
  s.session.close();
});

// F5 ─ Ansage-Text der Runde verlängert den Delay (Anti-Doppelung).
test("Filler: Ansage-Text der Runde verlängert den Delay", async () => {
  const content = "Ich schaue kurz nach.";
  const s = makeSession(
    [async () => ({ content, toolCalls: [toolCall("t1", "crm_lookup", "{}")] })],
    "Hallo!",
    { agent: fillerAgent() },
  );
  await driveToolRound(s, "Bitte prüfen.");
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0]!.ms, 2000 + Math.ceil((content.length / 14) * 1000));
  s.session.close();
});

// F6 ─ Barge-in verhindert den Filler (Generation-Rail).
test("Filler: Barge-in verhindert den Filler", async () => {
  const s = makeSession(
    [async () => ({ content: "", toolCalls: [toolCall("t1", "crm_lookup", "{}")] })],
    "Hallo!",
    { agent: fillerAgent() },
  );
  await driveToolRound(s);
  assert.equal(s.timers.length, 1);
  s.stt.speech(); // Barge-in → generation++, clearFiller
  fireTimer(s.timers); // verspäteter Timer
  assert.ok(!s.tts.texts.includes("Einen Moment bitte."), "kein Filler nach Barge-in");
  s.session.close();
});

// F7 ─ Antwort der Folgerunde verdrängt den wartenden Filler.
test("Filler: Antwort der Folgerunde verdrängt den wartenden Filler", async () => {
  const s = makeSession(
    [
      async () => ({ content: "", toolCalls: [toolCall("t1", "crm_lookup", "{}")] }),
      async (_req, onDelta) => {
        onDelta("Hier ist das Ergebnis.");
        return { content: "Hier ist das Ergebnis.", toolCalls: [] };
      },
    ],
    "Hallo!",
    { agent: fillerAgent() },
  );
  await driveToolRound(s);
  s.session.sendFunctionResponse("t1", "crm_lookup", { ok: true });
  await waitFor(() => s.llmCalls.length === 2);
  await settle();
  fireTimer(s.timers); // Timer feuert (zu) spät
  assert.ok(!s.tts.texts.includes("Einen Moment bitte."), "kein Filler mehr nach der Antwort");
  assert.ok(s.tts.texts.includes("Hier ist das Ergebnis."));
  s.session.close();
});

// F8 ─ Genau eine Wiederholung; Pool rotiert.
test("Filler: genau eine Wiederholung, Pool rotiert", async () => {
  const s = makeSession(
    [async () => ({ content: "", toolCalls: [toolCall("t1", "crm_lookup", "{}")] })],
    "Hallo!",
    { agent: fillerAgent({ fillers: { enabled: true, delayMs: 2000, phrases: ["Eins.", "Zwei."] } }) },
  );
  await driveToolRound(s);
  fireTimer(s.timers); // erster Filler
  assert.deepEqual(s.tts.texts.filter((t) => ["Eins.", "Zwei."].includes(t)), ["Eins."]);
  assert.equal(s.timers.length, 2, "Wiederholungs-Timer geplant");
  assert.equal(s.timers[1]!.ms, 6000);
  fireTimer(s.timers, 1); // Wiederholung
  assert.deepEqual(
    s.tts.texts.filter((t) => ["Eins.", "Zwei."].includes(t)),
    ["Eins.", "Zwei."],
    "Pool rotiert bei der Wiederholung",
  );
  assert.equal(s.timers.length, 2, "keine zweite Wiederholung");
  s.session.close();
});

// F9 ─ Parallele Tool-Calls → genau ein Timer pro Runde.
test("Filler: parallele Tool-Calls → ein Timer", async () => {
  const s = makeSession(
    [async () => ({ content: "", toolCalls: [toolCall("t1", "crm_a", "{}"), toolCall("t2", "crm_b", "{}")] })],
    "Hallo!",
    { agent: fillerAgent() },
  );
  await driveToolRound(s, "Beides bitte.");
  assert.equal(s.timers.length, 1, "ein Timer pro Runde, nicht pro Tool");
  s.session.close();
});

// F10 ─ Deaktiviert (Default) → kein Timer trotz customTool-Runde.
test("Filler: deaktiviert → kein Timer", async () => {
  const s = makeSession([async () => ({ content: "", toolCalls: [toolCall("t1", "crm_lookup", "{}")] })]);
  await driveToolRound(s);
  assert.equal(s.timers.length, 0);
  s.session.close();
});

// F11 ─ Ansage kommt über den Localizer (lokalisiert).
test("Filler: Ansage kommt über den Localizer", async () => {
  const localizer = { resolve: (key: string) => (key === "filler" ? "One moment, please." : key) };
  const s = makeSession(
    [async () => ({ content: "", toolCalls: [toolCall("t1", "crm_lookup", "{}")] })],
    "Hallo!",
    { agent: fillerAgent(), localizer },
  );
  await driveToolRound(s, "Please check.");
  fireTimer(s.timers);
  assert.ok(s.tts.texts.includes("One moment, please."), "Localizer-Übersetzung gesprochen");
  s.session.close();
});

// ── Reine Ansage (0.9.0) ─────────────────────────────────────────────────────

// Bei verdict "announce" spricht der Agent einen Satz und legt auf. Der STT-Strom wird
// dann gar nicht erst geöffnet: das spart den einzigen unnötigen Posten und verhindert
// zugleich, dass eine Ansage in ein Gespräch kippt, wenn der Anrufer dazwischenredet.
test("listen:false: kein STT-Strom, Anrufer-Audio wird verworfen", async () => {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const session = new NativeSession(
    testAgent({ voiceProvider: "native", greeting: "Kein Guthaben." }),
    [],
    "call-announce",
    { createStt: () => stt, createTts: () => tts },
    undefined,
    undefined,
    false,
  );
  await session.start();

  assert.equal(stt.started, false, "kein STT-Strom für eine reine Ansage");
  assert.equal(tts.started, true, "gesprochen wird trotzdem");
  assert.deepEqual(tts.texts, ["Kein Guthaben."]);

  session.sendAudio(Buffer.alloc(320));
  assert.equal(stt.audio.length, 0, "Anrufer-Audio läuft ins Leere");
  session.close();
});

// ── LLM-Verbrauch (0.10.0) ───────────────────────────────────────────────────

// Die Zahlen liegen im Stream ohnehin an — bis 0.9.x landeten sie nur im Debug-Log.
// Summiert wird über Turns UND Tool-Runden: ein Tool-Aufruf kostet eine eigene Runde.
test("NativeSession: getUsage() summiert LLM-Token über Turns und Tool-Runden", async () => {
  const s = makeSession([
    async () => ({
      content: "",
      toolCalls: [toolCall("t1", "get_weather", '{"location":"Berlin"}')],
      usage: { promptTokens: 900, completionTokens: 20, cachedTokens: 800, cacheWriteTokens: 0 },
    }),
    async (_req, onDelta) => {
      onDelta("In Berlin sind es 20 Grad.");
      return {
        content: "In Berlin sind es 20 Grad.",
        toolCalls: [],
        usage: { promptTokens: 1000, completionTokens: 30, cachedTokens: 900, cacheWriteTokens: 0 },
      };
    },
  ]);
  await s.session.start();

  s.stt.turn("Wie ist das Wetter in Berlin?");
  await waitFor(() => s.events.some(([e]) => e === "functionCallRequest"));
  s.session.sendFunctionResponse("t1", "get_weather", { tempC: 20 });
  await waitFor(() => s.llmCalls.length === 2);
  await settle();

  const u = s.session.getUsage();
  assert.equal(u?.llmRequests, 2, "Turn + Tool-Runde");
  assert.equal(u?.llmPromptTokens, 1900);
  assert.equal(u?.llmCompletionTokens, 50);
  assert.equal(u?.llmCachedPromptTokens, 1700);
  s.session.close();
});

// Wer die Modellwahl bewusst der Engine überlässt (think.model leer), braucht trotzdem eine
// Preisgrundlage — deshalb das TATSÄCHLICH benutzte Modell, nicht das leere Feld am Agenten.
test("NativeSession: llmModel trägt das benutzte Modell, nicht das leere Agent-Feld", async () => {
  const s = makeSession(
    [async () => ({ content: "Ja.", toolCalls: [], usage: { promptTokens: 10, completionTokens: 2, cachedTokens: 0, cacheWriteTokens: 0 } })],
    "Hallo!",
    { agent: { think: { source: "requesty" as const, model: "", temperature: 0.5 } } },
  );
  await s.session.start();
  s.stt.turn("Hallo?");
  await waitFor(() => s.llmCalls.length === 1);
  await settle();

  assert.equal(s.session.getUsage()?.llmModel, config.llm.model, "Config-Default, nicht \"\"");
  s.session.close();
});

// Ohne LLM-Runde und ohne gesprochene Zeichen gibt es nichts zu berichten.
test("NativeSession: getUsage() bleibt undefined, solange nichts verbraucht wurde", async () => {
  const s = makeSession([]);
  await s.session.start();
  assert.equal(s.session.getUsage(), undefined);
  s.session.close();
});
