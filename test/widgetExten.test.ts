/** Auto-Vergabe der Widget-Pseudo-Durchwahl (reine Logik, ohne DB). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectUsedExtens, ensureWidgetExten, pickFreeExten } from "../src/admin/widgetExten.js";

describe("collectUsedExtens", () => {
  it("sammelt 3-stellige DDIs und Widget-Extens, ignoriert E.164", () => {
    const used = collectUsedExtens([
      { targetNumbers: ["+4912345", "120"], widget: { exten: "130" } },
      { targetNumbers: ["121"] },
      { targetNumbers: null, widget: null },
    ]);
    assert.deepEqual([...used].sort(), ["120", "121", "130"]);
  });
});

describe("pickFreeExten", () => {
  it("vergibt ab 120 die niedrigste freie Nummer", () => {
    assert.equal(pickFreeExten(new Set()), "120");
    assert.equal(pickFreeExten(new Set(["120", "121"])), "122");
  });

  it("liefert undefined, wenn der komplette Bereich belegt ist", () => {
    const all = new Set<string>();
    for (let n = 120; n <= 999; n++) all.add(String(n));
    assert.equal(pickFreeExten(all), undefined);
  });
});

describe("ensureWidgetExten", () => {
  it("ist ein No-op bei deaktiviertem Widget oder fehlendem widget-Objekt", () => {
    const body1 = { targetNumbers: ["+49111"], widget: { enabled: false } };
    ensureWidgetExten(body1, undefined, new Set());
    assert.equal((body1.widget as { exten?: string }).exten, undefined);

    const body2 = { targetNumbers: ["+49111"] } as { targetNumbers: string[]; widget?: never };
    ensureWidgetExten(body2, undefined, new Set());
    assert.deepEqual(body2.targetNumbers, ["+49111"]);
  });

  it("vergibt eine freie Exten und ergänzt sie in targetNumbers", () => {
    const body = { targetNumbers: ["+49236298381975"], widget: { enabled: true } };
    ensureWidgetExten(body, undefined, new Set(["120"]));
    assert.equal((body.widget as { exten?: string }).exten, "121");
    assert.deepEqual(body.targetNumbers, ["+49236298381975", "121"]);
  });

  it("behält die bestehende Exten des Agenten und ergänzt sie erneut in targetNumbers", () => {
    // usedByOthers enthält die EIGENE Exten nie (Route schließt self aus der Abfrage aus).
    const body = { targetNumbers: ["+49111"], widget: { enabled: true } };
    ensureWidgetExten(body, "140", new Set(["120"]));
    assert.equal((body.widget as { exten?: string }).exten, "140");
    assert.deepEqual(body.targetNumbers, ["+49111", "140"]);
  });

  it("nutzt eine vorhandene 3-stellige DDI des Agenten mit, statt neu zu vergeben", () => {
    const body = { targetNumbers: ["121", "+49111"], widget: { enabled: true } };
    ensureWidgetExten(body, undefined, new Set());
    assert.equal((body.widget as { exten?: string }).exten, "121");
    assert.deepEqual(body.targetNumbers, ["121", "+49111"]); // kein Duplikat
  });

  it("respektiert eine explizit im Body gesetzte Exten (API-Clients)", () => {
    const body = { targetNumbers: ["+49111"], widget: { enabled: true, exten: "555" } };
    ensureWidgetExten(body, "140", new Set());
    assert.equal((body.widget as { exten?: string }).exten, "555");
    assert.deepEqual(body.targetNumbers, ["+49111", "555"]);
  });

  it("vergibt neu, wenn die gewünschte Exten von einem anderen Agent belegt ist", () => {
    // Fall "Weiterleitungs Fred": stale exten 120 + 120 in targetNumbers, aber 120
    // gehört dem Vertrieb-Agenten → Kollision überspringen, 123 vergeben.
    const body = {
      targetNumbers: ["+49236298381975", "120"],
      widget: { enabled: true, exten: "120" },
    };
    ensureWidgetExten(body, "120", new Set(["120", "121", "122"]));
    assert.equal((body.widget as { exten?: string }).exten, "123");
    assert.deepEqual(body.targetNumbers, ["+49236298381975", "120", "123"]);
  });
});
