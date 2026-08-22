import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { applyOverlay } from "../src/ari/agentResolver.js";
import { config } from "../src/config.js";
import {
  resolveOverlay,
  speakOverlayIsIncomplete,
  type ResolveContext,
} from "../src/ari/callResolver.js";
import { signBody } from "../src/util/signature.js";
import { testAgent } from "./helpers/fakes.js";

const AGENT_ID = "6a411b273d84ad5c5d4d28ef";

/** lean()-Dokument des gespeicherten Agenten (der „Stub", den eine Verwaltung anlegt). */
function stubDoc(): Record<string, any> {
  return {
    _id: AGENT_ID,
    name: "Stub",
    enabled: true,
    targetNumbers: ["+4923629838194123"],
    prompt: "Gespeicherter Prompt",
    greeting: "Guten Tag",
    speak: { provider: "deepgram", model: "aura-2-thalia-de" },
    tools: ["transfer_call", "end_call"],
  };
}

const ctx: ResolveContext = {
  channel: "phone",
  channelId: "chan-42",
  targetNumber: "+4923629838194123",
  callerNumber: "+491711234567",
};

// ── Test-Empfänger ────────────────────────────────────────────────────────────
interface Seen {
  raw: string;
  headers: IncomingMessage["headers"];
}
let seen: Seen | undefined;
let respond: (req: IncomingMessage, body: string) => { status: number; body?: string } | "hang" = () => ({
  status: 200,
  body: JSON.stringify({ verdict: "allow" }),
});

const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen = { raw, headers: req.headers };
    const out = respond(req, raw);
    if (out === "hang") return; // nie antworten → Timeout beim Aufrufer
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(out.body ?? "{}");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resolve`;
after(() => server.close());

function opts(extra: Record<string, unknown> = {}) {
  return { url, timeoutMs: 500, loadDoc: async () => stubDoc(), ...extra };
}

// 1 ─ Ohne RESOLVER_URL bleibt alles wie bisher: kein Verkehr, derselbe Agent.
test("Ohne URL ist der Hook inert", async () => {
  seen = undefined;
  const agent = testAgent({ id: AGENT_ID });
  const res = await resolveOverlay(agent, ctx, { url: "" });
  assert.equal(res.kind, "run");
  if (res.kind !== "run") return;
  assert.equal(res.agent, agent, "unveränderter Agent (identische Referenz)");
  assert.equal(res.report, true);
  assert.equal(res.announce, false);
  assert.equal(res.resolverStatus, undefined, "ohne Hook kein resolverStatus am Request");
  assert.equal(seen, undefined, "kein ausgehender Verkehr");
});

// 2 ─ Der Normalfall: Prompt überlagert, alles andere bleibt aus dem gespeicherten Agenten.
test("allow: Overlay überlagert prompt, Identität bleibt", async () => {
  respond = () => ({
    status: 200,
    body: JSON.stringify({ verdict: "allow", agentRef: "cust-7", overlay: { prompt: "Laufzeit-Prompt" } }),
  });
  const res = await resolveOverlay(testAgent({ id: AGENT_ID }), ctx, opts());
  assert.equal(res.kind, "run");
  if (res.kind !== "run") return;
  assert.equal(res.agent.prompt, "Laufzeit-Prompt");
  assert.equal(res.agent.id, AGENT_ID, "id bleibt die des gespeicherten Dokuments");
  assert.equal(res.agent.name, "Stub");
  assert.equal(res.agent.speak.model, "aura-2-thalia-de", "nicht gesetzte Felder bleiben");
  assert.equal(res.agent.greeting, "Guten Tag");
  assert.equal(res.agentRef, "cust-7");
  assert.equal(res.resolverStatus, "ok");
  assert.equal(res.report, true);
});

// 3 ─ Umschlag: channelId (neu) und callId (veraltet) tragen dieselbe Channel-ID.
test("Umschlag trägt channel, channelId und die Rufnummern", async () => {
  respond = () => ({ status: 200, body: JSON.stringify({ verdict: "allow" }) });
  await resolveOverlay(testAgent({ id: AGENT_ID }), { ...ctx, channel: "web" }, opts());
  const body = JSON.parse(seen?.raw ?? "{}");
  assert.equal(body.event, "agent.resolve");
  assert.equal(body.channel, "web");
  assert.equal(body.agentId, AGENT_ID);
  assert.equal(body.channelId, "chan-42");
  assert.equal(body.callId, "chan-42", "callId bleibt aus Kompatibilität gesetzt");
  assert.equal(body.to, ctx.targetNumber);
  assert.equal(body.from, ctx.callerNumber);
  assert.ok(body.receivedAt);
  assert.equal(body.widgetToken, undefined, "ohne Token bleibt das Feld weg");
});

// 3b ─ Web-Anruf: Das Widget-Token ist der einzige Griff, an dem sich ein Besucher vor dem
// Answer wiedererkennen lässt — agentId ist bei allen gleich, from/channelId entstehen erst
// jetzt. Es muss im Umschlag stehen UND von der Signatur gedeckt sein (0.10.3).
test("Umschlag: widgetToken bei Web-Anrufen, signiert", async () => {
  respond = () => ({ status: 200, body: JSON.stringify({ verdict: "allow" }) });
  await resolveOverlay(
    testAgent({ id: AGENT_ID }),
    { ...ctx, channel: "web", callerNumber: "web-1755769964.42", widgetToken: "a1b2c3d4e5f60718" },
    opts({ secret: "s3cr3t" }),
  );
  const body = JSON.parse(seen?.raw ?? "{}");
  assert.equal(body.widgetToken, "a1b2c3d4e5f60718");
  assert.equal(seen?.headers["x-voh-signature"], signBody(seen?.raw ?? "", "s3cr3t"));
});

// Ein Telefonat schickt exakt denselben Umschlag wie vor 0.10.3 — kein leeres Feld.
test("Umschlag: Telefonat trägt keinen widgetToken-Schlüssel", async () => {
  respond = () => ({ status: 200, body: JSON.stringify({ verdict: "allow" }) });
  await resolveOverlay(testAgent({ id: AGENT_ID }), ctx, opts());
  assert.ok(!("widgetToken" in JSON.parse(seen?.raw ?? "{}")));
});

// 4 ─ Identitätsfelder und Unbekanntes werden verworfen, der Anruf läuft weiter.
test("Overlay kann id/name nicht überschreiben, Unbekanntes wird ignoriert", async () => {
  respond = () => ({
    status: 200,
    body: JSON.stringify({
      verdict: "allow",
      overlay: { id: "deadbeef", _id: "deadbeef", name: "Fremd", targetNumbers: ["999"], bogus: 1, prompt: "P" },
    }),
  });
  const res = await resolveOverlay(testAgent({ id: AGENT_ID }), ctx, opts());
  assert.equal(res.kind, "run");
  if (res.kind !== "run") return;
  assert.equal(res.agent.id, AGENT_ID);
  assert.equal(res.agent.name, "Stub");
  assert.deepEqual(res.agent.targetNumbers, ["+4923629838194123"]);
  assert.equal(res.agent.prompt, "P", "erlaubtes Feld greift trotzdem");
});

// 5 ─ Leere Tool-Liste bleibt leer (fromDoc würde sonst die Defaults setzen).
test("announce: tools:[] bleibt leer und report:false wird durchgereicht", async () => {
  respond = () => ({
    status: 200,
    body: JSON.stringify({
      verdict: "announce",
      report: false,
      overlay: { greeting: "Kein Guthaben.", prompt: "…", tools: [] },
    }),
  });
  const res = await resolveOverlay(testAgent({ id: AGENT_ID }), ctx, opts());
  assert.equal(res.kind, "run");
  if (res.kind !== "run") return;
  assert.deepEqual(res.agent.tools, []);
  assert.equal(res.agent.greeting, "Kein Guthaben.");
  assert.equal(res.announce, true);
  assert.equal(res.report, false);
});

// 6 ─ Ablehnung ist eine eigene Form (nicht mit „nichts gefunden" verwechselbar).
test("reject liefert eine eigene Entscheidungsform", async () => {
  respond = () => ({ status: 200, body: JSON.stringify({ verdict: "reject" }) });
  const res = await resolveOverlay(testAgent({ id: AGENT_ID }), ctx, opts());
  assert.equal(res.kind, "reject");
});

// 7 ─ Fail-open: HTTP 500, Timeout und unbekanntes verdict lassen den Anruf laufen.
test("HTTP 500 → gespeicherter Agent gilt, resolverStatus unavailable", async () => {
  respond = () => ({ status: 500, body: "boom" });
  const agent = testAgent({ id: AGENT_ID });
  const res = await resolveOverlay(agent, ctx, opts());
  assert.equal(res.kind, "run");
  if (res.kind !== "run") return;
  assert.equal(res.agent, agent);
  assert.equal(res.resolverStatus, "unavailable");
  assert.equal(res.report, true, "der Anruf wird trotzdem protokolliert");
});

test("Timeout → gespeicherter Agent gilt", async () => {
  respond = () => "hang";
  const agent = testAgent({ id: AGENT_ID });
  const res = await resolveOverlay(agent, ctx, opts({ timeoutMs: 60 }));
  assert.equal(res.kind, "run");
  if (res.kind !== "run") return;
  assert.equal(res.agent, agent);
  assert.equal(res.resolverStatus, "unavailable");
});

test("Unbekanntes verdict → gespeicherter Agent gilt", async () => {
  respond = () => ({ status: 200, body: JSON.stringify({ verdict: "vielleicht" }) });
  const agent = testAgent({ id: AGENT_ID });
  const res = await resolveOverlay(agent, ctx, opts());
  assert.equal(res.kind, "run");
  if (res.kind !== "run") return;
  assert.equal(res.agent, agent);
  assert.equal(res.resolverStatus, "unavailable");
});

// 8 ─ Signatur: fester Vektor + der Header muss zum GESENDETEN Body passen.
test("Signatur: bekannter Vektor und Header über den rohen Body", async () => {
  assert.equal(
    signBody("hello", "secret"),
    "sha256=88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
  );
  respond = () => ({ status: 200, body: JSON.stringify({ verdict: "allow" }) });
  await resolveOverlay(testAgent({ id: AGENT_ID }), ctx, opts({ secret: "s3cr3t" }));
  assert.equal(seen?.headers["x-voh-signature"], signBody(seen?.raw ?? "", "s3cr3t"));
});

test("Ohne Secret wird unsigniert gesendet", async () => {
  respond = () => ({ status: 200, body: JSON.stringify({ verdict: "allow" }) });
  await resolveOverlay(testAgent({ id: AGENT_ID }), ctx, opts());
  assert.equal(seen?.headers["x-voh-signature"], undefined);
});

// 9 ─ applyOverlay isoliert: flach je Top-Level-Feld, Verworfenes wird gemeldet.
test("applyOverlay: flache Ersetzung, verworfene Schlüssel werden gemeldet", () => {
  const { doc, ignored } = applyOverlay(stubDoc(), {
    speak: { provider: "azure" },
    name: "Fremd",
    _id: "x",
  });
  assert.deepEqual(doc.speak, { provider: "azure" }, "Top-Level-Feld wird ersetzt, nicht gemischt");
  assert.equal(doc.name, "Stub");
  assert.equal(doc._id, AGENT_ID);
  assert.deepEqual(ignored.sort(), ["_id", "name"]);
});

// 10 ─ Teil-Overlay auf `speak`: flach ersetzt heißt, das Modell bleibt das alte. Der Fall
// ist ein Konfigurationsfehler des Aufrufers — er wird gemeldet, nicht repariert, und er
// bricht den Anruf nicht ab.
test("Teil-Overlay auf speak: Anbieter getauscht, Modell bleibt — wird erkannt", async () => {
  respond = () => ({
    status: 200,
    body: JSON.stringify({ verdict: "allow", overlay: { speak: { provider: "azure" } } }),
  });
  const res = await resolveOverlay(testAgent({ id: AGENT_ID }), ctx, opts());
  assert.equal(res.kind, "run");
  if (res.kind !== "run") return;
  assert.equal(res.agent.speak.provider, "azure");
  assert.equal(
    res.agent.speak.model,
    config.defaultAgent.speakModel,
    "flach ersetzt heißt: das Modell des Stubs ist weg und der anbieter-UNABHÄNGIGE " +
      "Config-Default greift — bei Azure wäre der Modellname aber die Stimme",
  );

  assert.equal(speakOverlayIsIncomplete({ provider: "azure" }, "deepgram", "azure"), true);
  assert.equal(
    speakOverlayIsIncomplete({ provider: "azure", model: "de-DE-KatjaNeural" }, "deepgram", "azure"),
    false,
    "mit Modell ist das Overlay vollständig",
  );
  assert.equal(
    speakOverlayIsIncomplete({ speed: 1.1 }, "deepgram", "deepgram"),
    false,
    "kein Anbieterwechsel — nichts zu melden",
  );
  assert.equal(speakOverlayIsIncomplete(undefined, "deepgram", "deepgram"), false);
});

// 11 ─ Die Whitelist wächst mit dem Schema: Was ein Agent kann, soll ein Overlay
// überlagern können — sonst müsste die Gegenseite zwei Wege pflegen.
test("Overlay: greetingPrompt und maxDurationSec sind überlagerbar", async () => {
  respond = () => ({
    status: 200,
    body: JSON.stringify({
      verdict: "allow",
      overlay: { greetingPrompt: "Begrüße knapp, es ist Abend.", maxDurationSec: 20 },
    }),
  });
  const res = await resolveOverlay(testAgent({ id: AGENT_ID }), ctx, opts());
  assert.equal(res.kind, "run");
  if (res.kind !== "run") return;
  assert.equal(res.agent.greetingPrompt, "Begrüße knapp, es ist Abend.");
  assert.equal(res.agent.maxDurationSec, 20);
});
