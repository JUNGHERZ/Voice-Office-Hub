import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { buildCallToolset, registerAllTools, type ToolContext } from "../src/tools/index.js";
import { resetMcpToolCache } from "../src/tools/mcp.js";
import type { ResolvedMcpServer } from "../src/types.js";
import { testAgent } from "./helpers/fakes.js";

registerAllTools();

// ── Mini-MCP-Server (stateless Streamable HTTP; frische Instanz pro Request) ──

function buildMcp(): McpServer {
  const mcp = new McpServer({ name: "test-mcp", version: "1.0.0" });
  mcp.registerTool(
    "say_hello",
    { description: "Grüßt eine Person", inputSchema: { name: z.string() } },
    async ({ name }) => ({ content: [{ type: "text", text: `Hallo ${name}!` }] }),
  );
  mcp.registerTool(
    "secret_tool",
    { description: "soll per toolFilter ausgeblendet werden", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "geheim" }] }),
  );
  mcp.registerTool(
    "kaputt",
    { description: "wirft immer", inputSchema: {} },
    async () => {
      throw new Error("kaputt!");
    },
  );
  return mcp;
}

let httpRequests = 0;

const httpServer = createServer((req, res) => {
  httpRequests += 1;
  void (async () => {
    const mcp = buildMcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  })().catch(() => {
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
});

await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;

after(() => {
  httpServer.closeAllConnections();
  httpServer.close();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function mcpServerCfg(overrides: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer {
  return { name: "crm", url: base, headers: {}, enabled: true, toolFilter: [], timeoutMs: 5_000, ...overrides };
}

const ctx: ToolContext = { callId: "req-99" };

// ── Tests ────────────────────────────────────────────────────────────────────

test("MCP: Tools erscheinen präfixiert im Toolset und sind aufrufbar", async () => {
  resetMcpToolCache();
  const ts = await buildCallToolset(
    testAgent({ tools: [], customTools: [], mcpServers: [mcpServerCfg()] }),
  );
  assert.deepEqual(
    ts.definitions.map((d) => d.name).sort(),
    ["crm_kaputt", "crm_say_hello", "crm_secret_tool"],
  );
  const def = ts.definitions.find((d) => d.name === "crm_say_hello");
  assert.equal((def?.parameters as { type?: string }).type, "object", "inputSchema → parameters");

  const out = await ts.dispatch("crm_say_hello", JSON.stringify({ name: "Marcel" }), ctx);
  assert.equal(out.ok, true);
  assert.match(String((out.result as { result: string }).result), /Hallo Marcel/);
  await ts.close();
});

test("MCP: Tool-Fehler (isError) → ok:false mit Fehlertext, Call-Toolset wirft nie", async () => {
  resetMcpToolCache();
  const ts = await buildCallToolset(
    testAgent({ tools: [], customTools: [], mcpServers: [mcpServerCfg()] }),
  );
  const out = await ts.dispatch("crm_kaputt", "{}", ctx);
  assert.equal(out.ok, false);
  assert.match(String((out.result as { error: string }).error), /kaputt/);
  await ts.close();
});

test("MCP: toolFilter begrenzt auf gelistete Tools", async () => {
  resetMcpToolCache();
  const ts = await buildCallToolset(
    testAgent({ tools: [], customTools: [], mcpServers: [mcpServerCfg({ toolFilter: ["say_hello"] })] }),
  );
  assert.deepEqual(ts.definitions.map((d) => d.name), ["crm_say_hello"]);
  await ts.close();
});

test("MCP: Tool-Listen-Cache — zweites Toolset ohne neue HTTP-Anfragen", async () => {
  resetMcpToolCache();
  const first = await buildCallToolset(
    testAgent({ tools: [], customTools: [], mcpServers: [mcpServerCfg()] }),
  );
  assert.equal(first.definitions.length, 3);
  await first.close();

  const before = httpRequests;
  const second = await buildCallToolset(
    testAgent({ tools: [], customTools: [], mcpServers: [mcpServerCfg()] }),
  );
  assert.equal(second.definitions.length, 3);
  assert.equal(httpRequests, before, "Cache-Hit: kein initialize/tools-list übers Netz");
  await second.close();
});

test("MCP: unerreichbarer Server → Toolset ohne MCP-Tools, Call startet trotzdem", async () => {
  resetMcpToolCache();
  const ts = await buildCallToolset(
    testAgent({
      tools: ["end_call"],
      customTools: [],
      mcpServers: [mcpServerCfg({ name: "tot", url: "http://127.0.0.1:9/mcp", timeoutMs: 800 })],
    }),
  );
  assert.deepEqual(ts.definitions.map((d) => d.name), ["end_call"]);
  await ts.close();
});
