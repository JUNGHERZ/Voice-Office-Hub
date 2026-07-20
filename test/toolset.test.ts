import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { buildCallToolset, registerAllTools, registerTool, type ToolContext } from "../src/tools/index.js";
import type { ResolvedCustomTool } from "../src/types.js";
import { testAgent } from "./helpers/fakes.js";

// ── Lokaler HTTP-Endpoint (kein Netz nach außen) ─────────────────────────────

interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
const seen: SeenRequest[] = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    const path = (req.url ?? "").split("?")[0];
    switch (path) {
      case "/echo":
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ received: JSON.parse(body || "{}") }));
        break;
      case "/text":
        res.setHeader("content-type", "text/plain");
        res.end("nur text");
        break;
      case "/big":
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ blob: "x".repeat(10_000) }));
        break;
      case "/fail":
        res.statusCode = 500;
        res.end("kaputt");
        break;
      case "/slow":
        setTimeout(() => res.end("{}"), 2_000).unref();
        break;
      default:
        res.statusCode = 404;
        res.end("not found");
    }
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.closeAllConnections();
  server.close();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

type EndpointOverrides = Partial<ResolvedCustomTool["endpoint"]>;

function customTool(
  overrides: Partial<Omit<ResolvedCustomTool, "endpoint">> & { endpoint?: EndpointOverrides } = {},
): ResolvedCustomTool {
  const { endpoint, ...rest } = overrides;
  return {
    name: "crm_lookup",
    description: "Sucht einen Kunden",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    enabled: true,
    ...rest,
    endpoint: { url: `${base}/echo`, method: "POST", headers: {}, timeoutMs: 3_000, ...endpoint },
  };
}

const ctx: ToolContext = {
  callId: "req-42",
  callerNumber: "+4915112345678",
  agentId: "agent-1",
  targetNumber: "120",
};

// ── Tests ────────────────────────────────────────────────────────────────────

test("HTTP-Tool POST: Envelope {arguments, call} + JSON-Ergebnis", async () => {
  const ts = await buildCallToolset(testAgent({ tools: [], customTools: [customTool()] }));
  assert.deepEqual(ts.definitions.map((d) => d.name), ["crm_lookup"]);

  const out = await ts.dispatch("crm_lookup", JSON.stringify({ q: "Meier" }), ctx);
  assert.equal(out.ok, true);
  const result = out.result as { received: { arguments: unknown; call: Record<string, unknown> } };
  assert.deepEqual(result.received.arguments, { q: "Meier" });
  assert.equal(result.received.call.callId, "req-42");
  assert.equal(result.received.call.callerNumber, "+4915112345678");
  assert.equal(result.received.call.agentId, "agent-1");
  assert.equal(result.received.call.targetNumber, "120");
});

test("HTTP-Tool: ${ENV:}-Platzhalter in URL und Headern werden aufgelöst", async () => {
  process.env.TOOLSET_TEST_KEY = "geheim-123";
  process.env.TOOLSET_TEST_PATH = "echo";
  const ts = await buildCallToolset(
    testAgent({
      tools: [],
      customTools: [
        customTool({
          endpoint: {
            url: `${base}/\${ENV:TOOLSET_TEST_PATH}`,
            headers: {
              authorization: "Bearer ${ENV:TOOLSET_TEST_KEY}",
              "x-fehlt": "${ENV:TOOLSET_TEST_GIBTS_NICHT}",
            },
          },
        }),
      ],
    }),
  );
  const out = await ts.dispatch("crm_lookup", "{}", ctx);
  assert.equal(out.ok, true);
  const req = seen.at(-1)!;
  assert.equal(req.url, "/echo", "Platzhalter in der URL aufgelöst");
  assert.equal(req.headers.authorization, "Bearer geheim-123");
  assert.equal(req.headers["x-fehlt"], "", "unauflösbarer Platzhalter wird leer");
});

test("HTTP-Tool GET: Argumente als Query-Parameter + call_id/caller_number", async () => {
  const ts = await buildCallToolset(
    testAgent({ tools: [], customTools: [customTool({ endpoint: { method: "GET" } })] }),
  );
  const out = await ts.dispatch("crm_lookup", JSON.stringify({ q: "Meier", limit: 5 }), ctx);
  assert.equal(out.ok, true);
  const url = new URL(base + seen.at(-1)!.url);
  assert.equal(url.searchParams.get("q"), "Meier");
  assert.equal(url.searchParams.get("limit"), "5", "Nicht-Strings werden JSON-serialisiert");
  assert.equal(url.searchParams.get("call_id"), "req-42");
  assert.equal(url.searchParams.get("caller_number"), "+4915112345678");
});

test("HTTP-Tool: Text-Antwort wird als {result} gekapselt", async () => {
  const ts = await buildCallToolset(
    testAgent({ tools: [], customTools: [customTool({ endpoint: { url: `${base}/text` } })] }),
  );
  const out = await ts.dispatch("crm_lookup", "{}", ctx);
  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { result: "nur text" });
});

test("HTTP-Tool: 5xx → ok:false mit Fehlertext, dispatch wirft nie", async () => {
  const ts = await buildCallToolset(
    testAgent({ tools: [], customTools: [customTool({ endpoint: { url: `${base}/fail` } })] }),
  );
  const out = await ts.dispatch("crm_lookup", "{}", ctx);
  assert.equal(out.ok, false);
  assert.match(String((out.result as { error: string }).error), /500/);
});

test("HTTP-Tool: Timeout bricht ab → ok:false", async () => {
  const ts = await buildCallToolset(
    testAgent({
      tools: [],
      customTools: [customTool({ endpoint: { url: `${base}/slow`, timeoutMs: 500 } })],
    }),
  );
  const started = Date.now();
  const out = await ts.dispatch("crm_lookup", "{}", ctx);
  assert.equal(out.ok, false);
  assert.ok(Date.now() - started < 1_800, "bricht deutlich vor den 2 s des Endpoints ab");
});

test("HTTP-Tool: übergroße Ergebnisse werden gekappt (truncated)", async () => {
  const ts = await buildCallToolset(
    testAgent({ tools: [], customTools: [customTool({ endpoint: { url: `${base}/big` } })] }),
  );
  const out = await ts.dispatch("crm_lookup", "{}", ctx);
  assert.equal(out.ok, true);
  const r = out.result as { truncated?: boolean; result?: string };
  assert.equal(r.truncated, true);
  assert.ok((r.result ?? "").length <= 4_096);
});

test("Toolset-Merge: Built-ins + Custom; Kollision und disabled werden übersprungen", async () => {
  registerAllTools();
  const ts = await buildCallToolset(
    testAgent({
      tools: ["end_call", "unbekanntes_builtin"],
      customTools: [
        customTool(),
        customTool({ name: "end_call" }), // Kollision mit aktivem Built-in → Netz greift
        customTool({ name: "deaktiviert", enabled: false }),
      ],
    }),
  );
  assert.deepEqual(ts.definitions.map((d) => d.name).sort(), ["crm_lookup", "end_call"]);
});

test("Dispatch: werfender Handler → ok:false, Fehler wird sprechbares Ergebnis", async () => {
  registerTool({
    name: "kaputt",
    description: "wirft",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("boom");
    },
  });
  const ts = await buildCallToolset(testAgent({ tools: ["kaputt"], customTools: [] }));
  const out = await ts.dispatch("kaputt", "{}", ctx);
  assert.equal(out.ok, false);
  assert.match(String((out.result as { error: string }).error), /boom/);
});

test("Dispatch: unbekanntes Tool und kaputtes JSON → ok:false", async () => {
  const ts = await buildCallToolset(testAgent({ tools: [], customTools: [customTool()] }));

  const unknown = await ts.dispatch("gibts_nicht", "{}", ctx);
  assert.equal(unknown.ok, false);
  assert.match(String((unknown.result as { error: string }).error), /Unbekanntes Tool/);

  const badJson = await ts.dispatch("crm_lookup", "{kein json", ctx);
  assert.equal(badJson.ok, false);
  assert.match(String((badJson.result as { error: string }).error), /kein JSON/);
});
