import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "../src/db/models/Agent.js";

// Schema-Validierung ohne DB-Verbindung (validateSync) — Muster wie ambience.test.ts.

// 1 ─ Widget aktiv erfordert exten UND Routing über targetNumbers.
test("Widget-Schema: enabled erzwingt exten in targetNumbers", () => {
  const ohneExten = new Agent({ name: "a", widget: { enabled: true } });
  assert.match(String(ohneExten.validateSync()?.errors?.widget ?? ""), /exten/);

  const nichtGeroutet = new Agent({
    name: "a",
    targetNumbers: ["121"],
    widget: { enabled: true, exten: "120" },
  });
  assert.ok(nichtGeroutet.validateSync()?.errors?.widget, "exten fehlt in targetNumbers");

  const ok = new Agent({
    name: "a",
    targetNumbers: ["120"],
    widget: { enabled: true, exten: "120", allowedOrigins: ["https://kunde.de"] },
  });
  assert.equal(ok.validateSync(), undefined);
});

// 2 ─ exten muss exakt dreistellig numerisch sein.
test("Widget-Schema: exten-Format", () => {
  for (const bad of ["12", "1234", "abc", "12a"]) {
    const a = new Agent({ name: "a", targetNumbers: [bad], widget: { enabled: true, exten: bad } });
    assert.ok(a.validateSync(), `exten "${bad}" muss abgelehnt werden`);
  }
});

// 3 ─ allowedOrigins: nur Origins ohne Pfad.
test("Widget-Schema: allowedOrigins-Validierung", () => {
  const bad = new Agent({
    name: "a",
    widget: { allowedOrigins: ["https://kunde.de/pfad"] },
  });
  assert.ok(bad.validateSync()?.errors?.["widget.allowedOrigins"]);

  const ok = new Agent({
    name: "a",
    widget: { allowedOrigins: ["https://kunde.de", "http://localhost:3000"] },
  });
  assert.equal(ok.validateSync(), undefined);
});

// 4 ─ Defaults: Widget aus, Transkript-Anzeige an (sofern aktiviert).
test("Widget-Schema: Defaults", () => {
  const a = new Agent({ name: "a" });
  assert.equal(a.validateSync(), undefined);
  const w = a.toObject().widget as { enabled: boolean; showTranscript: boolean };
  assert.equal(w.enabled, false);
  assert.equal(w.showTranscript, true);
});

// 5 ─ ElevenLabs-voice_settings: stability/similarityBoost nur im Bereich 0–1.
test("Speak-Schema: voice_settings-Bereiche", () => {
  const bad = new Agent({ name: "a", speak: { stability: 1.5, similarityBoost: -0.1 } });
  const errs = bad.validateSync()?.errors ?? {};
  assert.ok(errs["speak.stability"], "stability > 1 muss abgelehnt werden");
  assert.ok(errs["speak.similarityBoost"], "similarityBoost < 0 muss abgelehnt werden");

  const ok = new Agent({
    name: "a",
    speak: { provider: "eleven_labs", voice: "v1", stability: 0.4, similarityBoost: 0.8, speed: 1.1 },
  });
  assert.equal(ok.validateSync(), undefined);
});
