import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAdminServer } from "../src/admin/server.js";
import { config } from "../src/config.js";

/**
 * buildAdminServer() öffnet keine Mongo-Verbindung (das macht admin/index.ts) —
 * der Katalog-Endpoint ist damit ohne Datenbank testbar.
 */
async function withServer(fn: (app: Awaited<ReturnType<typeof buildAdminServer>>) => Promise<void>) {
  const prev = config.admin.apiKey;
  config.admin.apiKey = "test-admin-key";
  const app = await buildAdminServer();
  try {
    await fn(app);
  } finally {
    await app.close();
    config.admin.apiKey = prev;
  }
}

test("GET /api/tts/providers: ohne Auth abgewiesen", async () => {
  await withServer(async (app) => {
    const res = await app.inject({ method: "GET", url: "/api/tts/providers" });
    assert.equal(res.statusCode, 401);
  });
});

test("GET /api/tts/providers: liefert implementierte und freigegebene Provider", async () => {
  await withServer(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tts/providers",
      headers: { "x-api-key": "test-admin-key" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { providers: Array<Record<string, unknown>> };
    const ids = body.providers.map((p) => p.id);
    // fish_audio fehlt bewusst: Drittland, ohne FISH_AUDIO_ENABLED nicht im Panel.
    assert.deepEqual(ids.sort(), ["azure", "deepgram", "deepgram_flux", "eleven_labs", "mistral", "speechify"]);

    const mistral = body.providers.find((p) => p.id === "mistral");
    assert.equal(mistral?.defaultModel, "voxtral-mini-tts-latest");
    assert.equal(mistral?.residency, "eu");
    assert.deepEqual(mistral?.paths, ["native"]);
    assert.ok(Array.isArray(mistral?.voices) && (mistral.voices as unknown[]).length > 0);
  });
});

test("GET /api/tts/providers: meldet Key-Status, nie den Key selbst", async () => {
  const prevMistral = config.mistral.apiKey;
  config.mistral.apiKey = "mi-geheim";
  try {
    await withServer(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/api/tts/providers",
        headers: { "x-api-key": "test-admin-key" },
      });
      const body = res.json() as { providers: Array<Record<string, unknown>> };
      assert.equal(body.providers.find((p) => p.id === "mistral")?.configured, true);
      assert.equal(body.providers.find((p) => p.id === "mistral")?.envKey, "MISTRAL_API_KEY");
      assert.ok(!res.payload.includes("mi-geheim"), "der Key darf den Server nie verlassen");
    });
  } finally {
    config.mistral.apiKey = prevMistral;
  }
});

test("Voice-Cloning: ohne MISTRAL_API_KEY sauberes 503 statt Absturz", async () => {
  const prev = config.mistral.apiKey;
  config.mistral.apiKey = "";
  try {
    await withServer(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/api/tts/voices",
        headers: { "x-api-key": "test-admin-key" },
      });
      assert.equal(res.statusCode, 503);
      assert.match(res.json().error as string, /MISTRAL_API_KEY/);
    });
  } finally {
    config.mistral.apiKey = prev;
  }
});

test("Voice-Cloning: Anlegen verlangt Name und Referenzaudio", async () => {
  await withServer(async (app) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tts/voices",
      headers: { "x-api-key": "test-admin-key" },
      payload: { name: "Nur ein Name" },
    });
    assert.equal(res.statusCode, 400, "sampleAudio fehlt → Schemafehler");
  });
});


test("GET /api/tts/providers: Fish Audio erscheint erst nach Drittland-Freigabe", async () => {
  const prev = config.fishAudio.enabled;
  config.fishAudio.enabled = true;
  try {
    await withServer(async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/api/tts/providers",
        headers: { "x-api-key": "test-admin-key" },
      });
      const ids = (res.json() as { providers: Array<Record<string, unknown>> }).providers.map((p) => p.id);
      assert.ok(ids.includes("fish_audio"));
    });
  } finally {
    config.fishAudio.enabled = prev;
  }
});
