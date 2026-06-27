/**
 * Seed-Skript für Demo-/Test-Agenten (Multi-Agent / DDI-Routing).
 *
 * Legt einige Agents mit unterschiedlichen DDIs in der `agents`-Collection an (idempotent,
 * upsert per Name), damit sich das DDI-Routing ohne Admin-UI testen lässt:
 *   - 120 → KI-Agent "Vertrieb" (deutsch)
 *   - 121 → KI-Agent "Support" (deutsch)
 *   - 122 → Passthrough an 101 (Durchleitung + Aufnahme)
 *
 * Ausführen (im Container):  node dist/scripts/seedAgents.js
 * bzw. lokal mit gesetztem MONGO_URI:  npm run seed
 */
import { connectMongo, disconnectMongo } from "../db/mongo.js";
import { Agent } from "../db/models/Agent.js";
import { logger } from "../util/logger.js";

const log = logger.child({ mod: "seed" });

const DEMO_AGENTS = [
  {
    name: "Vertrieb Demo",
    enabled: true,
    targetNumbers: ["120"],
    mode: "agent" as const,
    language: "de",
    greeting: "Willkommen beim Vertrieb! Wie kann ich Ihnen weiterhelfen?",
    prompt:
      "Du bist eine freundliche Vertriebs-Assistentin am Telefon. Antworte immer auf Deutsch, " +
      "kurz und natuerlich gesprochen. Hilf bei Produktfragen und Angeboten. Wenn der Anrufer " +
      "einen Mitarbeiter sprechen moechte, rufe transfer_call mit target='101' auf. Bei Abschied " +
      "sage GENAU EINEN kurzen Abschiedssatz und rufe DANACH end_call auf.",
    speak: { provider: "deepgram", model: "aura-2-viktoria-de" },
    tools: ["transfer_call", "end_call"],
    summary: { enabled: true, prompt: "Fasse das Vertriebsgespraech in 3-5 Saetzen sachlich zusammen." },
    tags: ["demo", "vertrieb", "de"],
  },
  {
    name: "Support Demo",
    enabled: true,
    targetNumbers: ["121"],
    mode: "agent" as const,
    language: "de",
    greeting: "Hallo, hier ist der technische Support. Was kann ich fuer Sie tun?",
    prompt:
      "Du bist ein ruhiger, kompetenter technischer Support-Assistent am Telefon. Antworte immer " +
      "auf Deutsch, kurz und natuerlich gesprochen. Hilf bei technischen Problemen. Wenn noetig, " +
      "rufe transfer_call mit target='101' auf. Bei Abschied sage GENAU EINEN kurzen Abschiedssatz " +
      "und rufe DANACH end_call auf.",
    speak: { provider: "deepgram", model: "aura-2-viktoria-de" },
    tools: ["transfer_call", "end_call"],
    summary: { enabled: true, prompt: "Fasse das Support-Gespraech in 3-5 Saetzen sachlich zusammen." },
    tags: ["demo", "support", "de"],
  },
  {
    name: "Passthrough Demo (101)",
    enabled: true,
    targetNumbers: ["122"],
    mode: "passthrough" as const,
    passthroughTarget: "101",
    language: "de",
    summary: { enabled: true, prompt: "Fasse das durchgeleitete Gespraech in 3-5 Saetzen zusammen." },
    tags: ["demo", "passthrough"],
  },
];

async function main(): Promise<void> {
  await connectMongo();
  for (const a of DEMO_AGENTS) {
    await Agent.updateOne({ name: a.name }, { $set: a }, { upsert: true });
    log.info("Agent geseedet", { name: a.name, targetNumbers: a.targetNumbers, mode: a.mode });
  }
  const total = await Agent.countDocuments();
  log.info("Seed fertig", { demoAgents: DEMO_AGENTS.length, agentsInDb: total });
  await disconnectMongo();
}

main().catch((err) => {
  log.error("Seed fehlgeschlagen", { err: String(err) });
  process.exitCode = 1;
});
