import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import http from "node:http";
import { test, before, after } from "node:test";

import { runOverChain, isAbort } from "../src/llm/chain.js";
import { parseModelChain, primaryModel } from "../src/llm/models.js";
import { LlmFirstTokenTimeout, streamChatCompletion } from "../src/native/llmStream.js";

// Ephemeral-Port (listen(0)) wie in toolset/webhookNotifier & Co. — feste Ports haben
// sich hier schon zweimal mit anderen Testdateien überschnitten, und die Kollision
// äußert sich nicht als Bind-Fehler, sondern als abgebrochene FREMDE Datei.
let BASE = "";
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (d: Record<string, unknown>, finish: string | null = null) =>
  sse({ choices: [{ delta: d, finish_reason: finish, index: 0 }] });

/** Modelle, die der Testserver gesehen hat — belegt, WELCHE Stufe wirklich lief. */
let seen: string[] = [];
let server: http.Server;
/**
 * Aufräumliste. Die „stummen" Szenarien lassen absichtlich Antworten offen und die
 * Clients brechen mitten in der Anfrage ab — die halbgeöffneten Sockets halten sonst
 * den Event-Loop, der Prozess beendet sich nie, und im Gesamtlauf reisst das FREMDE
 * Testdateien mit ("cancelledByParent"). Deshalb: Sockets mitschreiben und hart zu.
 */
const sockets = new Set<{ destroy(): void }>();
const timers: Array<ReturnType<typeof setTimeout>> = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const model = String((JSON.parse(body) as { model?: string }).model ?? "");
      seen.push(model);

      // Modelle mit "kaputt" antworten mit 502; "stumm" nimmt an und schweigt
      // (der gefährliche Fall: kein Fehler, nur Stille); alles andere liefert Text.
      if (model.includes("kaputt")) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end('{"error":{"message":"Anbieter weg"}}');
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (model.includes("stumm")) return; // Verbindung offen, nie ein Token
      if (model.includes("spaetzuender")) {
        // Erst nach 300 ms ein Token — schlägt gegen ein knappes Budget fehl.
        timers.push(
          setTimeout(() => {
            res.write(delta({ content: "spaet" }, "stop"));
            res.write("data: [DONE]\n\n");
            res.end();
          }, 300),
        );
        return;
      }
      res.write(delta({ role: "assistant" }));
      res.write(delta({ content: `hallo von ${model}` }, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  for (const t of timers) clearTimeout(t);
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => server.close(() => r()));
});

// ── Kettenparser ────────────────────────────────────────────────────────────

test("parseModelChain: einzelnes Modell bleibt eine Kette der Länge 1", () => {
  assert.deepEqual(parseModelChain("a/b"), ["a/b"]);
});

test("parseModelChain: trennt an Kommas und trimmt Leerraum", () => {
  assert.deepEqual(parseModelChain(" a/b , c/d ,e/f "), ["a/b", "c/d", "e/f"]);
});

test("parseModelChain: leere Einträge und Dubletten fallen raus", () => {
  // Eine Dublette wäre keine Ausweichstufe, sondern ein zweiter Versuch beim selben Anbieter.
  assert.deepEqual(parseModelChain("a/b, ,a/b,,c/d"), ["a/b", "c/d"]);
});

test("parseModelChain: leere/fehlende Angabe ergibt eine leere Kette", () => {
  assert.deepEqual(parseModelChain(""), []);
  assert.deepEqual(parseModelChain(undefined), []);
});

test("primaryModel: liefert die erste Stufe — der Deepgram-Pfad kann nur die", () => {
  assert.equal(primaryModel("a/b,c/d"), "a/b");
  assert.equal(primaryModel(""), "");
});

// ── One-Shot-Kette ──────────────────────────────────────────────────────────

test("runOverChain: die erste Stufe gewinnt, spätere werden nicht angefasst", async () => {
  const versuche: string[] = [];
  const r = await runOverChain(["a", "b"], async (m) => {
    versuche.push(m);
    return `ok ${m}`;
  });
  assert.deepEqual(versuche, ["a"]);
  assert.equal(r.value, "ok a");
  assert.equal(r.model, "a");
  assert.equal(r.stage, 0);
});

test("runOverChain: fällt der Reihe nach durch und meldet die tragende Stufe", async () => {
  const versuche: string[] = [];
  const r = await runOverChain(["a", "b", "c"], async (m) => {
    versuche.push(m);
    if (m !== "c") throw new Error(`${m} kaputt`);
    return "endlich";
  });
  assert.deepEqual(versuche, ["a", "b", "c"], "Reihenfolge ist die Prioritätsreihenfolge");
  assert.equal(r.model, "c");
  assert.equal(r.stage, 2);
});

test("runOverChain: scheitern alle, wirft der Fehler der LETZTEN Stufe", async () => {
  await assert.rejects(
    runOverChain(["a", "b"], async (m) => {
      throw new Error(`${m} kaputt`);
    }),
    /b kaputt/,
  );
});

test("runOverChain: ein Abbruch beendet die Kette sofort", async () => {
  // Barge-in/Teardown: beim nächsten Anbieter eine Antwort zu bestellen, die niemand
  // mehr hören will, wäre reine Geldverbrennung.
  const versuche: string[] = [];
  await assert.rejects(
    runOverChain(["a", "b"], async (m) => {
      versuche.push(m);
      throw new DOMException("weg", "AbortError");
    }),
    (e: Error) => isAbort(e),
  );
  assert.deepEqual(versuche, ["a"], "keine zweite Stufe nach einem Abbruch");
});

test("runOverChain: leere Kette ist ein Konfigurationsfehler, kein stiller No-Op", async () => {
  await assert.rejects(runOverChain([], async () => "x"), /keine Modellangabe/);
});

// ── Zeitbudget bis zum ersten Token ─────────────────────────────────────────

test("Wächter: ein stummer Anbieter wird zum Ausfall statt zu endloser Stille", async () => {
  seen = [];
  const ctl = new AbortController();
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: BASE,
        apiKey: "k",
        model: "szenario/stumm",
        messages: [{ role: "user", content: "hi" }],
        firstTokenTimeoutMs: 150,
        signal: ctl.signal,
      },
      () => {},
    ),
    (e: Error) => e instanceof LlmFirstTokenTimeout && !isAbort(e),
  );
});

test("Wächter: 0 schaltet ihn ab (Rückwärtskompatibilität)", async () => {
  // Ohne Budget darf sich das Verhalten von vor 0.18.0 nicht ändern.
  const ctl = new AbortController();
  const p = streamChatCompletion(
    {
      baseUrl: BASE,
      apiKey: "k",
      model: "szenario/spaetzuender",
      messages: [{ role: "user", content: "hi" }],
      firstTokenTimeoutMs: 0,
      signal: ctl.signal,
    },
    () => {},
  );
  const r = await p;
  assert.equal(r.content, "spaet");
});

test("Wächter: greift NICHT mehr, sobald das erste Token da ist", async () => {
  // Ein langsam weiterlaufender Stream darf nicht abgeschnitten werden.
  const ctl = new AbortController();
  const r = await streamChatCompletion(
    {
      baseUrl: BASE,
      apiKey: "k",
      model: "szenario/spaetzuender",
      messages: [{ role: "user", content: "hi" }],
      firstTokenTimeoutMs: 1200,
      signal: ctl.signal,
    },
    () => {},
  );
  assert.equal(r.content, "spaet");
});

test("Wächter: ein Barge-in bleibt AbortError und wird nicht zum Ausfall", async () => {
  // Der Unterschied trägt die Folge: AbortError = verwerfen, Timeout = Stufe wechseln.
  const ctl = new AbortController();
  const p = streamChatCompletion(
    {
      baseUrl: BASE,
      apiKey: "k",
      model: "szenario/stumm",
      messages: [{ role: "user", content: "hi" }],
      firstTokenTimeoutMs: 5000,
      signal: ctl.signal,
    },
    () => {},
  );
  setTimeout(() => ctl.abort(), 60);
  await assert.rejects(p, (e: Error) => isAbort(e) && !(e instanceof LlmFirstTokenTimeout));
});

// ── Zusammenspiel: Kette über echte HTTP-Fehler ─────────────────────────────

test("Kette + Stream: nach einem 502 antwortet die nächste Stufe", async () => {
  seen = [];
  const ctl = new AbortController();
  const r = await runOverChain(["szenario/kaputt", "szenario/gut"], (m) =>
    streamChatCompletion(
      {
        baseUrl: BASE,
        apiKey: "k",
        model: m,
        messages: [{ role: "user", content: "hi" }],
        signal: ctl.signal,
      },
      () => {},
    ),
  );
  assert.deepEqual(seen, ["szenario/kaputt", "szenario/gut"], "beide Stufen wurden versucht");
  assert.equal(r.model, "szenario/gut");
  assert.equal(r.value.content, "hallo von szenario/gut");
});

test("Kette + Wächter: ein stummer Primäranbieter wird von der Ausweichstufe aufgefangen", async () => {
  seen = [];
  const ctl = new AbortController();
  const r = await runOverChain(["szenario/stumm", "szenario/gut"], (m) =>
    streamChatCompletion(
      {
        baseUrl: BASE,
        apiKey: "k",
        model: m,
        messages: [{ role: "user", content: "hi" }],
        firstTokenTimeoutMs: 150,
        signal: ctl.signal,
      },
      () => {},
    ),
  );
  assert.deepEqual(seen, ["szenario/stumm", "szenario/gut"]);
  assert.equal(r.stage, 1);
  assert.equal(r.value.content, "hallo von szenario/gut");
});
