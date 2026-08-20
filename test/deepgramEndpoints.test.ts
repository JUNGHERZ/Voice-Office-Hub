import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEEPGRAM_REGIONS,
  deepgramEndpoints,
  mismatchedEndpoints,
  parseDeepgramRegion,
} from "../src/deepgram/endpoints.js";

test("Region eu legt alle vier Dienste auf api.eu.deepgram.com", () => {
  const e = deepgramEndpoints("eu");
  assert.deepEqual(e, {
    sttUrl: "wss://api.eu.deepgram.com/v2/listen",
    ttsUrl: "wss://api.eu.deepgram.com/v1/speak",
    fluxTtsUrl: "wss://api.eu.deepgram.com/v2/speak",
    agentUrl: "wss://api.eu.deepgram.com/v1/agent/converse",
  });
});

// Die Asymmetrie ist die eigentliche Falle: global liegt der Voice-Agent auf einer
// EIGENEN Domain, in der EU nicht. Ein "agent.eu.deepgram.com" existiert nicht
// (live geprüft: DNS löst nicht auf) — wer stumpf "eu." einsetzt, baut eine tote URL.
test("Region global nutzt fuer den Voice-Agent eine eigene Domain", () => {
  const e = deepgramEndpoints("global");
  assert.equal(new URL(e.sttUrl).host, "api.deepgram.com");
  assert.equal(new URL(e.ttsUrl).host, "api.deepgram.com");
  assert.equal(new URL(e.fluxTtsUrl).host, "api.deepgram.com");
  assert.equal(new URL(e.agentUrl).host, "agent.deepgram.com");
  assert.notEqual(new URL(deepgramEndpoints("eu").agentUrl).host, "agent.eu.deepgram.com");
});

test("Alle Regionen liefern vollstaendige, parsbare wss-URLs", () => {
  for (const r of DEEPGRAM_REGIONS) {
    for (const [key, url] of Object.entries(deepgramEndpoints(r))) {
      const u = new URL(url);
      assert.equal(u.protocol, "wss:", `${r}/${key}`);
      assert.ok(u.pathname.length > 1, `${r}/${key}: kein Pfad`);
    }
  }
});

test("parseDeepgramRegion ist tolerant, aber nicht raterisch", () => {
  assert.deepEqual(parseDeepgramRegion("eu"), { region: "eu", recognized: true });
  assert.deepEqual(parseDeepgramRegion("  EU  "), { region: "eu", recognized: true });
  assert.deepEqual(parseDeepgramRegion("global"), { region: "global", recognized: true });
  // Leer = nicht gesetzt: global, und das ist kein Fehler.
  assert.deepEqual(parseDeepgramRegion(""), { region: "global", recognized: true });
  // Tippfehler landen NICHT stillschweigend irgendwo — der Aufrufer meldet sie laut.
  assert.deepEqual(parseDeepgramRegion("europe"), { region: "global", recognized: false });
  assert.deepEqual(parseDeepgramRegion("eu-central-1"), { region: "global", recognized: false });
});

test("mismatchedEndpoints erkennt den halb gesetzten Zustand", () => {
  const eu = deepgramEndpoints("eu");
  assert.deepEqual(mismatchedEndpoints("eu", eu), []);
  // Eine einzelne vergessene URL-Variable — genau der Fall, der unbemerkt blieb.
  assert.deepEqual(
    mismatchedEndpoints("eu", { ...eu, ttsUrl: "wss://api.deepgram.com/v1/speak" }),
    ["ttsUrl"],
  );
  // Mehrere gleichzeitig, Reihenfolge stabil.
  assert.deepEqual(
    mismatchedEndpoints("eu", {
      ...eu,
      sttUrl: "wss://api.deepgram.com/v2/listen",
      agentUrl: "wss://agent.deepgram.com/v1/agent/converse",
    }),
    ["sttUrl", "agentUrl"],
  );
  // Abweichender Pfad bei gleichem Host ist KEIN Regionsproblem.
  assert.deepEqual(mismatchedEndpoints("eu", { ...eu, sttUrl: "wss://api.eu.deepgram.com/v1/listen" }), []);
  // Unparsbares faellt auf und wird gemeldet statt verschluckt.
  assert.deepEqual(mismatchedEndpoints("eu", { ...eu, ttsUrl: "kaputt" }), ["ttsUrl"]);
});
