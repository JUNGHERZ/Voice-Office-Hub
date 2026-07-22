/**
 * Automatische Verwaltung der Widget-Pseudo-Durchwahl (widget.exten).
 *
 * Die Exten ist die interne "Rufnummer" des Agenten für Web-Anrufe: das Widget
 * wählt sie per SIP, Asterisk routet sie wie eine DDI in die Engine. Statt sie
 * dem Nutzer aufzubürden (Feld pflegen UND in targetNumbers eintragen), stellt
 * der Server sie beim Speichern automatisch sicher; der Schema-Validator bleibt
 * als Sicherheitsnetz dahinter bestehen.
 */

const EXTEN_PATTERN = /^\d{3}$/;
// Vergabe ab 120 (Konvention der Test-DDIs); 100–119 bleiben für Dev-Softphones frei.
const EXTEN_MIN = 120;
const EXTEN_MAX = 999;

export interface AgentNumbersLike {
  targetNumbers?: string[] | null;
  widget?: { exten?: string | null } | null;
}

/** Alle belegten 3-stelligen Nummern (DDIs + Widget-Extens) über alle Agents einsammeln. */
export function collectUsedExtens(agents: AgentNumbersLike[]): Set<string> {
  const used = new Set<string>();
  for (const a of agents) {
    for (const n of a.targetNumbers ?? []) if (EXTEN_PATTERN.test(n)) used.add(n);
    const ex = a.widget?.exten;
    if (ex && EXTEN_PATTERN.test(ex)) used.add(ex);
  }
  return used;
}

/** Niedrigste freie 3-stellige Durchwahl; undefined, wenn der Bereich (absurd) voll ist. */
export function pickFreeExten(used: Set<string>): string | undefined {
  for (let n = EXTEN_MIN; n <= EXTEN_MAX; n++) {
    const s = String(n);
    if (!used.has(s)) return s;
  }
  return undefined;
}

/**
 * Body vor dem Speichern konsistent machen: bei aktivem Widget eine Exten
 * sicherstellen und sie in targetNumbers ergänzen. Prioritaet: explizit im Body
 * (API-Clients) → bestehende Exten des Agenten → vorhandene 3-stellige DDI des
 * Agenten (lokale Test-Agents brauchen dann keine zweite Nummer) → niedrigste
 * freie Nummer. No-op bei deaktiviertem Widget oder partiellem Update ohne widget.
 */
export function ensureWidgetExten(
  body: { targetNumbers?: unknown; widget?: { enabled?: unknown; exten?: unknown } },
  currentExten: string | undefined,
  usedByOthers: Set<string>,
): void {
  const widget = body.widget;
  if (!widget || typeof widget !== "object" || !widget.enabled) return;
  const numbers = Array.isArray(body.targetNumbers) ? (body.targetNumbers as string[]) : undefined;
  // Kandidaten in Prioritätsreihenfolge; von ANDEREN Agents belegte Nummern werden
  // übersprungen und neu vergeben (Fall: stale exten aus einem alten Speicherversuch,
  // die inzwischen als DDI eines anderen Agenten existiert → sonst Routing-Kollision).
  const candidates = [
    typeof widget.exten === "string" ? widget.exten : undefined,
    currentExten,
    ...(numbers ?? []),
  ];
  let exten = candidates.find(
    (c): c is string => !!c && EXTEN_PATTERN.test(c) && !usedByOthers.has(c),
  );
  exten ??= pickFreeExten(usedByOthers);
  if (!exten) return; // kein freier Slot → der Schema-Validator meldet den Fehler
  widget.exten = exten;
  if (numbers && !numbers.includes(exten)) numbers.push(exten);
}
