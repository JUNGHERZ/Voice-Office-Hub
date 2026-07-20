# Tools: eingebaut + eigene HTTP-Endpoints + MCP-Server pro Agent

Der Voice-Agent kann während des Gesprächs Funktionen aufrufen (Function Calling). Es gibt
drei Quellen, die pro Anruf zu **einem Toolset** zusammengeführt werden
([src/tools/toolset.ts](../src/tools/toolset.ts)):

1. **Eingebaute Tools** (`agent.tools`, Namensliste): `transfer_call`, `end_call`, `get_weather`
   (Demo). Sie laufen in der Engine und haben Zugriff auf die Telefonie (Transfer, Auflegen).
2. **Eigene HTTP-Tools** (`agent.customTools[]`): fachliche Funktionen (CRM-Lookup,
   Terminbuchung, Bestellstatus …), die als **HTTP-Endpoint außerhalb der Appliance** leben.
   Die Engine ruft den Endpoint selbst auf — URL/Header (inkl. Secrets) verlassen den Server
   nie Richtung Voice-Provider.
3. **MCP-Server** (`agent.mcpServers[]`): ein Server nach dem **Model Context Protocol**
   stellt gleich mehrere Tools bereit — siehe [Abschnitt MCP](#mcp-server-als-tool-quelle).

## customTools — Felder

```jsonc
{
  "name": "crm_lookup",            // ^[a-z][a-z0-9_]{0,63}$, eindeutig, keine Built-in-Namen
  "description": "Sucht einen Kunden anhand von Name oder Kundennummer.",
  "parameters": {                   // JSON-Schema der Argumente (geht 1:1 an das LLM)
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Name oder Kundennummer" }
    },
    "required": ["query"]
  },
  "endpoint": {
    "url": "https://api.example.com/voice-tools/crm-lookup",
    "method": "POST",              // POST (Default) oder GET
    "headers": { "authorization": "Bearer ${ENV:CRM_API_KEY}" },
    "timeoutMs": 8000               // 500–30000, Default 8000
  },
  "enabled": true
}
```

Anlegen/ändern per `PATCH /api/agents/:id` (Feld `customTools`) oder ab 0.6.2 im Admin-UI.

## Aufruf-Kontrakt (was dein Endpoint bekommt)

**POST** (Default) — JSON-Envelope:

```json
{
  "arguments": { "query": "Meier" },
  "call": {
    "callId": "665f0c…",           // Anruf-ID (= requests-Dokument, transportneutral)
    "callerNumber": "+49151…",     // falls übermittelt
    "agentId": "664a…",            // DB-Id des Agenten (fehlt beim Default-Agenten)
    "targetNumber": "+49221…"      // angerufene DDI
  }
}
```

**GET** — Argumente flach als Query-Parameter (Nicht-Strings JSON-serialisiert) plus
`call_id` und `caller_number`:

```
GET /voice-tools/crm-lookup?query=Meier&call_id=665f0c…&caller_number=%2B49151…
```

**Antwort:** Idealerweise JSON (`2xx`) — das Objekt wird dem LLM als Tool-Ergebnis gegeben.
Nicht-JSON-Antworten werden als `{ "result": "<text>" }` gekapselt. Ergebnisse werden bei
~4 kB gekappt (`{"truncated":true,…}`), damit kein Endpoint das LLM-Kontextfenster flutet.

**Fehler:** Non-`2xx`, Timeout oder Netzwerkfehler werfen den Anruf **nie** ab. Das LLM
erhält `{ "error": "Tool \"crm_lookup\" fehlgeschlagen: …" }` und kann sich sprachlich
herauswinden („Das kann ich gerade nicht nachschlagen …"). Im Anruf-Log erscheint der
Function-Call mit `status: "error"`.

## Secrets: `${ENV:NAME}`

Header-Werte und die URL dürfen `${ENV:NAME}`-Platzhalter enthalten. Sie werden **erst beim
Aufruf** durch die gleichnamige Umgebungsvariable der Engine ersetzt — API-Keys stehen damit
in der `.env`/Deployment-Umgebung, nicht in der Datenbank oder im Admin-UI. Unauflösbare
Platzhalter werden zu `""` (Warn-Log); der Endpoint antwortet dann typischerweise 401 —
sichtbarer als ein stiller Abbruch.

## Latenz-Hinweis (Dead Air)

Während des Tool-Aufrufs herrscht Stille im Gespräch. **Halte Endpoints < 2 s** (Timeout
großzügiger, aber die Ziel-Antwortzeit klein). Bei absehbar langsamen Operationen: sofort
antworten (`{"status":"wird_bearbeitet"}`) und das Ergebnis im nächsten Turn nachreichen,
oder den Agenten im Prompt anweisen, den Aufruf anzukündigen („Einen Moment, ich schaue
nach …" — Ansage läuft, dann erst das Tool aufrufen).

## MCP-Server als Tool-Quelle

Statt einzelne Endpoints zu pflegen, kann ein Agent komplette **MCP-Server** einbinden
(Transport: **Streamable HTTP**; SDK `@modelcontextprotocol/sdk`, Version gepinnt).

```jsonc
{
  "name": "crm",                          // Tool-Präfix: Tools erscheinen als crm_<toolname>
  "url": "https://mcp.example.com/mcp",
  "headers": { "authorization": "Bearer ${ENV:MCP_API_KEY}" },
  "toolFilter": ["search_customer"],       // optional: Whitelist (unpräfixierte Namen); leer = alle
  "timeoutMs": 8000,                       // 500–30000; gilt für Verbindung + Tool-Aufrufe
  "enabled": true
}
```

**Verhalten:**

- **Tool-Namen** werden mit `<server>_` präfixiert (`crm_search_customer`) — kollisionsfrei
  zu Built-ins/Custom-Tools und kompatibel zum Zeichensatz der Voice-Provider.
- **Tool-Listen-Cache** (~5 min pro Server-URL, prozessweit): der Call-Aufbau wartet nicht
  pro Anruf auf `tools/list`; neue Tools eines Servers erscheinen nach spätestens 5 Minuten.
- **Lazy Connect:** die Verbindung entsteht erst beim ersten Tool-Aufruf des Gesprächs, lebt
  für die Call-Dauer und wird im Teardown geschlossen.
- **Fehlertoleranz:** ist der Server beim Call-Aufbau nicht erreichbar, startet der Anruf
  ohne dessen Tools (Warn-Log) — die Begrüßung verzögert sich nicht. Tool-Fehler (`isError`)
  werden wie bei HTTP-Tools zum sprechbaren `{error}`-Ergebnis.
- **Ergebnis-Normalisierung:** `structuredContent` wird direkt übernommen, sonst werden die
  Text-Content-Teile konkateniert; Kappung ~4 kB wie bei HTTP-Tools.
- **Auth v1:** statische Header (mit `${ENV:NAME}`), kein OAuth-Flow.

**Latenz-Hinweis:** Für Gesprächs-Tools gilt dieselbe Dead-Air-Regel wie oben — MCP-Server
mit trägen Tools (Web-Recherche etc.) lieber per `toolFilter` auf die schnellen Tools
begrenzen.

## Beispiel: Mini-Endpoint (Node)

```js
import { createServer } from "node:http";

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { arguments: args, call } = JSON.parse(body || "{}");
    // … Fachlogik (CRM, Kalender, …) — args.query, call.callerNumber stehen bereit
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ found: true, customer: { name: "Meier GmbH", openTickets: 2 } }));
  });
}).listen(8090);
```

Test ohne Telefon: [test/toolset.test.ts](../test/toolset.test.ts) zeigt den kompletten
HTTP-Kontrakt (Envelope, GET-Query, `${ENV:}`, Timeout- und Fehlerverhalten) gegen einen
lokalen HTTP-Server; [test/mcpToolset.test.ts](../test/mcpToolset.test.ts) dasselbe für MCP
gegen einen Mini-MCP-Server (list + call, toolFilter, Cache, unerreichbarer Server).
