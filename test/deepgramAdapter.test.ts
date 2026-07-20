import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { WebSocketServer, type WebSocket as WsSocket } from "ws";

import { testAgent, waitFor } from "./helpers/fakes.js";
import type { VoiceConversationText, VoiceFunctionCallRequest } from "../src/voice/types.js";

// Loopback-WS statt Deepgram: MUSS vor dem (dynamischen) Laden von src/config.ts gesetzt sein.
// Fixport analog audiosocket.test.ts (18099); Testdateien laufen in getrennten Prozessen.
const PORT = 18098;
process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${PORT}`;
process.env.DEEPGRAM_API_KEY = "test-key";

test("AgentSession: start() sendet Settings; Wire-Events → neutrale Events; Responses als JSON", async () => {
  // Dynamisch importieren, damit die ENV-Zuweisungen oben vor dem config-Load greifen.
  const { AgentSession } = await import("../src/deepgram/agentSession.js");
  const { buildSettings } = await import("../src/deepgram/settings.js");

  const wss = new WebSocketServer({ port: PORT });
  await new Promise<void>((r) => wss.once("listening", () => r()));

  const serverMessages: string[] = [];
  let serverSocket: WsSocket | undefined;
  const connected = new Promise<WsSocket>((resolve) => {
    wss.on("connection", (sock) => {
      serverSocket = sock;
      sock.on("message", (data, isBinary) => {
        if (!isBinary) serverMessages.push(data.toString());
      });
      resolve(sock);
    });
  });

  const session = new AgentSession(buildSettings(testAgent(), []), "call-1");
  const welcomes: string[] = [];
  const audio: Buffer[] = [];
  const texts: VoiceConversationText[] = [];
  const fnRequests: VoiceFunctionCallRequest[] = [];
  session.on("welcome", (id) => welcomes.push(id));
  session.on("audio", (chunk) => audio.push(chunk));
  session.on("conversationText", (ev) => texts.push(ev));
  session.on("functionCallRequest", (ev) => fnRequests.push(ev));

  try {
    await session.start();
    const sock = await connected;

    // 1) Erste Client-Nachricht ist die Settings-Message.
    await waitFor(() => serverMessages.length >= 1);
    const settings = JSON.parse(serverMessages[0] ?? "{}");
    assert.equal(settings.type, "Settings");
    assert.equal(settings.agent.greeting, "Hallo");

    // 2) Server-Events → neutral gemappte Session-Events.
    sock.send(JSON.stringify({ type: "Welcome", request_id: "rid-1" }));
    sock.send(Buffer.from([1, 2, 3]), { binary: true });
    sock.send(JSON.stringify({
      type: "FunctionCallRequest",
      functions: [{ id: "f1", name: "tool_x", arguments: '{"a":1}', client_side: true }],
    }));
    sock.send(JSON.stringify({ type: "ConversationText", role: "assistant", content: "Hi" }));

    await waitFor(() => welcomes.length === 1 && audio.length === 1 && fnRequests.length === 1 && texts.length === 1);
    assert.equal(welcomes[0], "rid-1");
    assert.deepEqual([...(audio[0] ?? Buffer.alloc(0))], [1, 2, 3]);
    assert.deepEqual(fnRequests[0]?.functions[0], {
      id: "f1",
      name: "tool_x",
      argumentsJson: '{"a":1}',
      clientSide: true,
    });
    assert.deepEqual(texts[0], { role: "assistant", content: "Hi" });

    // 3) FunctionCallResponse: content ist der JSON-String des Results.
    session.sendFunctionResponse("f1", "tool_x", { ok: true });
    await waitFor(() => serverMessages.length >= 2);
    const response = JSON.parse(serverMessages[1] ?? "{}");
    assert.equal(response.type, "FunctionCallResponse");
    assert.equal(response.id, "f1");
    assert.equal(response.content, JSON.stringify({ ok: true }));
  } finally {
    session.close();
    serverSocket?.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
});
