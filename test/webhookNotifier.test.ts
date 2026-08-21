import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { createEventRepo } from "../src/db/callRepo.js";
import * as repo from "../src/db/repository.js";
import { createNotifier, type Notifier } from "../src/webhooks/notifier.js";

// ── Test-Empfänger ────────────────────────────────────────────────────────────
interface Seen {
  raw: string;
  headers: IncomingMessage["headers"];
}
let seen: Seen[] = [];
let respond: (n: number) => { status: number } | "hang" = () => ({ status: 200 });

const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ raw, headers: req.headers });
    const out = respond(seen.length);
    if (out === "hang") return;
    res.writeHead(out.status);
    res.end("{}");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
after(() => server.close());

function notifier(extra: Record<string, unknown> = {}): Notifier {
  seen = [];
  return createNotifier({ url, timeoutMs: 300, maxRetries: 3, backoffMs: () => 0, ...extra });
}

// 1 ─ Ohne WEBHOOK_URL entsteht kein ausgehender Verkehr.
test("Ohne URL kein ausgehender Verkehr", async () => {
  const n = notifier({ url: "" });
  n.emit("call.started", { call: { id: "req-1" } });
  await n.flush(100);
  assert.equal(seen.length, 0);
  assert.equal(n.pending(), 0);
});

// 2 ─ Header-Vertrag: Ereignisname, Zustell-ID und Signatur über den rohen Body.
test("Umschlag: X-VOH-Event, X-VOH-Delivery und Signatur", async () => {
  const n = notifier({ secret: "s3cr3t" });
  n.emit("call.started", { seq: 0, call: { id: "req-1" } });
  await n.flush(2000);
  assert.equal(seen.length, 1);
  const [ev] = seen;
  assert.equal(ev?.headers["x-voh-event"], "call.started");
  assert.ok(ev?.headers["x-voh-delivery"], "Zustell-ID vorhanden");
  const body = JSON.parse(ev?.raw ?? "{}");
  assert.equal(body.event, "call.started");
  assert.equal(body.call.id, "req-1");
  assert.ok(body.sentAt);
  const { signBody } = await import("../src/util/signature.js");
  assert.equal(ev?.headers["x-voh-signature"], signBody(ev?.raw ?? "", "s3cr3t"));
});

// 3 ─ 5xx wird wiederholt — mit identischer Zustell-ID, damit der Empfänger dedupliziert.
test("500 → Wiederholung mit gleicher X-VOH-Delivery, danach Erfolg", async () => {
  const n = notifier();
  respond = (i) => ({ status: i === 1 ? 500 : 200 });
  n.emit("call.ended", { seq: 1, call: { id: "req-2" } });
  await n.flush(2000);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.headers["x-voh-delivery"], seen[1]?.headers["x-voh-delivery"]);
  assert.equal(seen[0]?.raw, seen[1]?.raw, "identischer Body → identische Signatur");
});

// 4 ─ 4xx ist ein Vertragsfehler: nicht wiederholen.
test("400 → keine Wiederholung", async () => {
  const n = notifier();
  respond = () => ({ status: 400 });
  n.emit("call.ended", { seq: 1, call: { id: "req-3" } });
  await n.flush(1000);
  assert.equal(seen.length, 1);
});

// 5 ─ 429 gilt als „später nochmal", nicht als Vertragsfehler.
test("429 → Wiederholung", async () => {
  const n = notifier();
  respond = (i) => ({ status: i === 1 ? 429 : 200 });
  n.emit("call.ended", { seq: 1, call: { id: "req-4" } });
  await n.flush(2000);
  assert.equal(seen.length, 2);
});

// 6 ─ Die Warteschlange staut nicht, sie verwirft (und protokolliert das).
test("Warteschlangen-Limit verwirft statt zu stauen", async () => {
  const n = notifier({ queueLimit: 1, maxRetries: 0, timeoutMs: 60 });
  respond = () => "hang";
  for (let i = 0; i < 6; i++) n.emit("tool.called", { seq: i, call: { id: "req-5" } });
  // 4 Arbeiter laufen, genau EINES wartet — das sechste hat das fünfte verdrängt.
  assert.equal(n.pending(), 5);
  await n.flush(2000);
  respond = () => ({ status: 200 });
});

// ── Repo-Dekorator ────────────────────────────────────────────────────────────

interface Recorded {
  event: string;
  payload: Record<string, any>;
}

function fakeSink(): { sink: Notifier; events: Recorded[] } {
  const events: Recorded[] = [];
  return {
    events,
    sink: {
      emit: (event, payload) => events.push({ event, payload }),
      flush: async () => {},
      pending: () => 0,
    },
  };
}

/** Repo-Attrappe mit derselben Modul-Form; nur die dekorierten Pfade werden aufgerufen. */
function fakeBase(): typeof repo {
  return {
    ...repo,
    createRequest: async () => "req-9",
    appendTranscript: async () => {},
    appendFunctionCall: async () => {},
    setRecording: async () => {},
    finalizeRequest: async () => {},
  } as typeof repo;
}

const endedDoc = {
  channelId: "chan-9",
  mode: "agent",
  callerNumber: "+49171",
  targetNumber: "+49236",
  agentRef: "cust-7",
  externalRef: "crm-42",
  resolverStatus: "ok",
  endedReason: "transfer",
  greetingText: "Guten Morgen bei Musterfirma.",
  startedAt: new Date("2026-08-21T09:00:00.000Z"),
  endedAt: new Date("2026-08-21T09:03:33.000Z"),
  durationSec: 213,
  language: "en",
  transcript: [{ t: 0, end: 2.4, speaker: "agent", text: "Hallo" }],
  functionCalls: [{ name: "transfer_call", status: "ok" }],
  transfer: { attempted: true, target: "+4930", connected: true },
  recording: { gridFsId: "abc", durationSec: 213 },
  metrics: { bargeIns: 1, toolCalls: 1, toolErrors: 0 },
};

// 7 ─ Ein Anruf: genau ein call.started und ein call.ended, aufsteigende seq, call.id überall.
test("Ein Anruf erzeugt call.started … call.ended mit aufsteigendem seq", async () => {
  const { sink, events } = fakeSink();
  const r = createEventRepo(fakeBase(), sink, { enabled: true, loadRequest: async () => endedDoc });

  const id = await r.createRequest({
    channelId: "chan-9",
    mode: "agent",
    callerNumber: "+49171",
    targetNumber: "+49236",
    agentRef: "cust-7",
    externalRef: "crm-42",
    resolverStatus: "ok",
  });
  await r.appendFunctionCall(id, {
    name: "transfer_call",
    status: "ok",
    requestedAt: new Date("2026-08-21T09:01:00.000Z"),
    completedAt: new Date("2026-08-21T09:01:02.000Z"),
  });
  await r.setRecording(id, { gridFsId: "abc" as never, filename: "req-9.wav", durationSec: 213 });
  await r.appendTranscript(id, { t: 0, speaker: "agent", text: "Hallo" });
  await r.finalizeRequest(id, "completed", { bargeIns: 1, toolCalls: 1, toolErrors: 0 });

  assert.deepEqual(
    events.map((e) => e.event),
    ["call.started", "tool.called", "recording.ready", "call.ended"],
    "kein Ereignis für appendTranscript",
  );
  assert.deepEqual(events.map((e) => e.payload.seq), [0, 1, 2, 3]);
  for (const e of events) {
    assert.equal(e.payload.call.id, "req-9", `call.id fehlt in ${e.event}`);
    assert.equal(e.payload.agentRef, "cust-7");
    // Anders als agentRef gilt externalRef immer — auch ohne Overlay-Hook (0.10.0).
    assert.equal(e.payload.externalRef, "crm-42", `externalRef fehlt in ${e.event}`);
  }
  const ended = events[3]?.payload as Record<string, any>;
  assert.equal(ended.call.durationSec, 213);
  assert.equal(ended.call.language, "en");
  assert.equal(ended.call.resolverStatus, "ok");
  assert.equal(ended.transcript.length, 1);
  assert.equal(ended.transfer.connected, true);
  assert.deepEqual(ended.recording, { available: true, durationSec: 213 });
  assert.equal(ended.metrics.bargeIns, 1);
  // Warum das Gespräch endete und was der Assistent eröffnet hat (0.10.0) — beides ist im
  // Nachhinein sonst nicht mehr belegbar.
  assert.equal(ended.call.endedReason, "transfer");
  assert.equal(ended.greetingText, "Guten Morgen bei Musterfirma.");
});

// 8 ─ Fehlgeschlagener Anruf meldet sich als eigenes Ereignis.
test("finalizeRequest(failed) → call.failed", async () => {
  const { sink, events } = fakeSink();
  const r = createEventRepo(fakeBase(), sink, { enabled: true, loadRequest: async () => endedDoc });
  const id = await r.createRequest({ channelId: "chan-9", mode: "agent" });
  await r.finalizeRequest(id, "failed", undefined, "failed");
  assert.deepEqual(events.map((e) => e.event), ["call.started", "call.failed"]);
});

// 9 ─ Ohne konfigurierte URL ist der Dekorator gar nicht erst im Weg.
test("Ohne URL reicht der Dekorator das Repo unverändert durch", async () => {
  const { sink, events } = fakeSink();
  const base = fakeBase();
  const r = createEventRepo(base, sink, { enabled: false });
  assert.equal(r, base, "identische Referenz — kein Dekorator, kein Nachlesen");
  await r.createRequest({ channelId: "chan-9", mode: "agent" });
  assert.equal(events.length, 0);
});
