import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "../src/db/models/Agent.js";

// Reine Schema-Prüfungen: Mongoose validiert und setzt Defaults ohne DB-Verbindung.

test("Neue Felder (0.10.0) werden übernommen statt still verworfen", () => {
  const a = new Agent({
    name: "Stub",
    externalRef: "crm-42",
    greetingPrompt: "Begrüße kurz für Musterfirma.",
    maxDurationSec: 300,
  });
  assert.equal(a.get("externalRef"), "crm-42");
  assert.equal(a.get("greetingPrompt"), "Begrüße kurz für Musterfirma.");
  assert.equal(a.get("maxDurationSec"), 300);
  assert.equal(a.validateSync(), undefined);
});

// Ein PATCH mit unbekanntem Feld verschwand bis 0.9.x stillschweigend (Mongoose `strict`) —
// genau das war die gemeldete Lücke.
test("recording.enabled ist standardmäßig an", () => {
  const a = new Agent({ name: "Stub" });
  assert.equal(a.get("recording.enabled"), true);
  const off = new Agent({ name: "Stub", recording: { enabled: false } });
  assert.equal(off.get("recording.enabled"), false);
});

// Unter 5 Sekunden wäre nicht einmal die Begrüßung zu Ende gesprochen.
test("maxDurationSec: unbrauchbar kleine Werte werden abgewiesen", () => {
  const err = new Agent({ name: "Stub", maxDurationSec: 2 }).validateSync();
  assert.match(String(err), /maxDurationSec/);
  assert.equal(new Agent({ name: "Stub", maxDurationSec: 5 }).validateSync(), undefined);
});
