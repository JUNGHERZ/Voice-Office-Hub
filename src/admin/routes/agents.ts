/**
 * Management-API: Agents-CRUD über die `agents`-Collection (Mongoose-Modell wiederverwendet).
 * Geschützt per requireAuth (Session-Cookie ODER API-Key).
 */
import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { fromDoc as agentFromDoc } from "../../ari/agentResolver.js";
import { config } from "../../config.js";
import { Agent } from "../../db/models/Agent.js";
import { detectContentLanguage } from "../../llm/languageScorer.js";
import {
  catalogLabel,
  ensureTranslations,
  knownLanguages,
  loadEntries,
  refreshAllLanguages,
  saveTranslations,
  staleKeys,
  translatableCatalog,
  UnknownCatalogKeys,
} from "../../llm/translationStore.js";
import { requireAuth } from "../auth.js";
import { collectUsedExtens, ensureWidgetExten } from "../widgetExten.js";

/** Widget-Key ist SERVER-verwaltet: Client-Werte werden nie übernommen. */
function newWidgetKey(): string {
  return randomBytes(16).toString("hex");
}

/**
 * `contentLanguage` auffüllen, wenn der Nutzer „Automatisch erkennen" gelassen hat (leerer Wert).
 * Ein gesetzter Wert wird NIE überschrieben — die Erkennung ist ein Vorschlag, keine Korrektur.
 * Beim Teil-Update zählt der zusammengesetzte Stand aus Body und gespeichertem Dokument, damit
 * eine PATCH-Änderung nur am Prompt trotzdem die richtige Sprache ermittelt.
 */
export function fillContentLanguage(
  body: Record<string, unknown>,
  current?: { greeting?: string; prompt?: string; contentLanguage?: string },
): void {
  const explicit = typeof body.contentLanguage === "string" ? body.contentLanguage.trim() : "";
  if (explicit) return;
  // Body kennt das Feld nicht und gespeichert steht schon etwas → nichts anfassen.
  if (!("contentLanguage" in body) && current?.contentLanguage) return;
  const greeting = (body.greeting as string) ?? current?.greeting;
  const prompt = (body.prompt as string) ?? current?.prompt;
  body.contentLanguage = detectContentLanguage(greeting, prompt) ?? config.defaultAgent.contentLanguage;
}

const idParam = {
  type: "object",
  properties: { id: { type: "string", description: "Agent-ObjectId" } },
  required: ["id"],
} as const;

// Agent-Body bewusst offen (das Schema ist reich/verschachtelt; Validierung macht Mongoose).
const agentBody = { type: "object", additionalProperties: true } as const;

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Liste
  app.get("/", { schema: { tags: ["agents"], summary: "Agents auflisten" } }, async () => {
    const agents = await Agent.find().sort({ name: 1 }).lean();
    return { agents };
  });

  // Detail
  app.get("/:id", { schema: { tags: ["agents"], summary: "Agent (Detail)", params: idParam } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await Agent.findById(id).lean();
    if (!agent) return reply.code(404).send({ error: "not found" });
    return { agent };
  });

  // Anlegen
  app.post("/", { schema: { tags: ["agents"], summary: "Agent anlegen", body: agentBody } }, async (req, reply) => {
    const body = { ...(req.body as Record<string, unknown>) };
    const widget = body.widget as Record<string, unknown> | undefined;
    if (widget && typeof widget === "object") {
      widget.key = newWidgetKey();
      if (widget.enabled) {
        // Pseudo-Durchwahl server-seitig sicherstellen (Exten + targetNumbers-Eintrag).
        const all = await Agent.find({}, { targetNumbers: 1, "widget.exten": 1 }).lean();
        ensureWidgetExten(body, undefined, collectUsedExtens(all));
      }
    }
    fillContentLanguage(body);
    const agent = await Agent.create(body);
    return reply.code(201).send({ agent: agent.toObject() });
  });

  // Ändern (Teil-Update)
  app.patch(
    "/:id",
    { schema: { tags: ["agents"], summary: "Agent ändern", params: idParam, body: agentBody } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = { ...(req.body as Record<string, unknown>) };
      const current = await Agent.findById(id, {
        "widget.key": 1,
        "widget.exten": 1,
        greeting: 1,
        prompt: 1,
        contentLanguage: 1,
      }).lean<{
        widget?: { key?: string; exten?: string };
        greeting?: string;
        prompt?: string;
        contentLanguage?: string;
      }>();
      if (!current) return reply.code(404).send({ error: "not found" });
      const widget = body.widget as Record<string, unknown> | undefined;
      if (widget && typeof widget === "object") {
        // PATCH ersetzt Subdokumente komplett — den bestehenden Key bewahren
        // (bzw. beim ersten Aktivieren erzeugen); Client-Werte zählen nie.
        widget.key = current.widget?.key || newWidgetKey();
        if (widget.enabled) {
          // Pseudo-Durchwahl server-seitig sicherstellen; belegte Nummern anderer
          // Agents meiden (die eigenen kommen ggf. aus dem Body selbst).
          const others = await Agent.find(
            { _id: { $ne: id } },
            { targetNumbers: 1, "widget.exten": 1 },
          ).lean();
          ensureWidgetExten(body, current.widget?.exten, collectUsedExtens(others));
        }
      }
      fillContentLanguage(body, current);
      const agent = await Agent.findByIdAndUpdate(id, body, {
        new: true,
        runValidators: true,
        // Update-Validatoren mit Query-Kontext (Widget-Validator liest targetNumbers aus dem Update).
        context: "query",
      }).lean();
      if (!agent) return reply.code(404).send({ error: "not found" });
      // Geänderte Ansagen entwerten ihre Übersetzungen sofort (Quelltext-Hash, siehe
      // translationStore.ts) — hier wird die Frische wiederhergestellt. Im Hintergrund:
      // Bis das durch ist, spricht der Agent die Standardsprache, was korrekt ist.
      void refreshAllLanguages(agentFromDoc(agent));
      return { agent };
    },
  );

  /**
   * Vorübersetzte Ansagen ansehen. Zeigt Original und Übersetzung nebeneinander samt
   * Aktualitäts-Flag — der einzige Ort, an dem sichtbar wird, was der Agent im Ernstfall
   * sagen wird, BEVOR ein Anrufer es hört. Fehlende Keys erscheinen bewusst als leerer
   * Eintrag statt zu verschwinden: Ein Übersetzungs-Fehlschlag soll auffallen.
   */
  app.get(
    "/:id/translations",
    { schema: { tags: ["agents"], summary: "Vorübersetzte Ansagen", params: idParam } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const doc = await Agent.findById(id).lean();
      if (!doc) return reply.code(404).send({ error: "not found" });
      const agent = agentFromDoc(doc);
      const catalog = translatableCatalog(agent);
      const langs = await knownLanguages(id);

      const languages = [];
      for (const lang of langs.sort()) {
        const entries = await loadEntries(id, lang);
        const stale = new Set(staleKeys(catalog, entries));
        languages.push({
          lang,
          entries: Object.entries(catalog).map(([key, source]) => ({
            key,
            label: catalogLabel(key),
            source,
            translation: entries[key]?.text ?? "",
            stale: stale.has(key),
          })),
        });
      }
      return { contentLanguage: agent.contentLanguage, languages };
    },
  );

  /**
   * Zielsprache aus dem Pfad prüfen: Kürzel wie `en` oder `fr`, nicht die Ausgangssprache
   * selbst — für die gibt es nichts zu übersetzen, und ein stilles „ok" führte in die Irre.
   */
  const targetLanguage = (raw: string, contentLanguage: string): string | { error: string } => {
    const lang = raw.trim().toLowerCase();
    if (!/^[a-z]{2,3}$/.test(lang)) return { error: `„${raw}" ist kein Sprachkürzel (z. B. en, fr).` };
    if (lang === contentLanguage) return { error: `${lang} ist die Ausgangssprache der Ansagen.` };
    return lang;
  };

  /**
   * Übersetzungen einer Sprache erzeugen — nur fehlende und veraltete Einträge. Legt eine
   * noch unbekannte Sprache an (0.18.3: „Sprache anlegen" im Admin), sodass schon der erste
   * Anruf in ihr passend begrüßt werden kann.
   */
  app.post(
    "/:id/translations/:lang/regenerate",
    {
      schema: {
        tags: ["agents"],
        summary: "Übersetzung erzeugen oder neu erzeugen",
        params: {
          type: "object",
          properties: { id: { type: "string" }, lang: { type: "string" } },
          required: ["id", "lang"],
        },
      },
    },
    async (req, reply) => {
      const { id, lang: raw } = req.params as { id: string; lang: string };
      const doc = await Agent.findById(id).lean();
      if (!doc) return reply.code(404).send({ error: "not found" });
      const agent = agentFromDoc(doc);
      const lang = targetLanguage(raw, agent.contentLanguage);
      if (typeof lang !== "string") return reply.code(400).send({ error: "bad_request", message: lang.error });
      // Synchron: Der Aufrufer hat den Knopf gedrückt und will das Ergebnis sehen.
      await ensureTranslations(agent, lang);
      return { ok: true };
    },
  );

  /**
   * Übersetzungen von Hand korrigieren (0.18.3). Ein Text gilt als frisch, bis jemand das
   * Original ändert — die automatische Neuerzeugung überschreibt ihn nicht. Ein leerer Text
   * löscht den Eintrag; die Lücke füllt das nächste Neu-Erzeugen.
   */
  app.put(
    "/:id/translations/:lang",
    {
      schema: {
        tags: ["agents"],
        summary: "Übersetzung von Hand korrigieren",
        params: {
          type: "object",
          properties: { id: { type: "string" }, lang: { type: "string" } },
          required: ["id", "lang"],
        },
        body: {
          type: "object",
          properties: {
            entries: {
              type: "object",
              description: "Katalog-Key → Übersetzung; leerer Text löscht den Eintrag.",
              additionalProperties: { type: "string", maxLength: 2000 },
            },
          },
          required: ["entries"],
        },
      },
    },
    async (req, reply) => {
      const { id, lang: raw } = req.params as { id: string; lang: string };
      const { entries } = req.body as { entries: Record<string, string> };
      const doc = await Agent.findById(id).lean();
      if (!doc) return reply.code(404).send({ error: "not found" });
      const agent = agentFromDoc(doc);
      const lang = targetLanguage(raw, agent.contentLanguage);
      if (typeof lang !== "string") return reply.code(400).send({ error: "bad_request", message: lang.error });
      try {
        await saveTranslations(agent, lang, entries);
      } catch (err) {
        if (err instanceof UnknownCatalogKeys) {
          return reply.code(400).send({ error: "bad_request", message: err.message });
        }
        throw err;
      }
      return { ok: true };
    },
  );

  // Widget-Key rotieren (macht einen geleakten Embed-Key sofort wertlos).
  app.post(
    "/:id/widget/key",
    { schema: { tags: ["agents"], summary: "Widget-Key rotieren", params: idParam } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const key = newWidgetKey();
      const agent = await Agent.findByIdAndUpdate(id, { $set: { "widget.key": key } }, { new: true }).lean();
      if (!agent) return reply.code(404).send({ error: "not found" });
      return { key };
    },
  );

  // Löschen
  app.delete("/:id", { schema: { tags: ["agents"], summary: "Agent löschen", params: idParam } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await Agent.findByIdAndDelete(id).lean();
    if (!deleted) return reply.code(404).send({ error: "not found" });
    return { deleted: true };
  });
}
