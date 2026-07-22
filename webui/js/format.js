/*
 * Kleine Formatierungs-Helfer für die Views (Datum, Dauer, Telefonnummern).
 */

/** Sekunden → "m:ss" (z. B. 89 → "1:29"). */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * Anruflänge (Sekunden) eines Requests. Priorität:
 *   1. durationSec (> 0)
 *   2. aus startedAt→endedAt berechnet (für Bestands-Anrufe ohne durationSec)
 *   3. recording.durationSec (> 0)
 *   4. sonst undefined → Anzeige "—"
 * Wichtig: 0 zählt NICHT als gültige Dauer (Schema-Default alter Requests).
 */
export function callDurationSec(r) {
  if (!r) return undefined;
  if (typeof r.durationSec === "number" && r.durationSec > 0) return r.durationSec;
  if (r.startedAt && r.endedAt) {
    const start = new Date(r.startedAt).getTime();
    const end = new Date(r.endedAt).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) {
      return Math.round((end - start) / 1000);
    }
  }
  if (r.recording && typeof r.recording.durationSec === "number" && r.recording.durationSec > 0) {
    return r.recording.durationSec;
  }
  return undefined;
}

/** Anruflänge formatiert ("m:ss") oder "—", wenn keine Dauer vorhanden. */
export function fmtCallDuration(r) {
  const sec = callDurationSec(r);
  return sec === undefined ? "—" : fmtDuration(sec);
}

/** Millisekunden → Sekunden mit einer Nachkommastelle ("1,2 s"). */
export function fmtSecondsFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "—";
  return `${(n / 1000).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/** ISO-Zeit → relative deutsche Kurzform ("vor 4 Min", "27.06. 18:31"). */
export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std`;
  // Älter: Datum + Uhrzeit
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Absolute deutsche Datums-/Zeitangabe. */
export function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "caller → target (Agent)"-Kurzbeschriftung eines Anrufs. */
export function callLabel(r) {
  // Web-Widget-Anrufe tragen eine synthetische Caller-ID (web-<uniqueid>) — als "Web" anzeigen.
  const raw = r.callerNumber || "unbekannt";
  const from = /^web-/.test(raw) ? "Web" : raw;
  const to = r.targetNumber || "—";
  // agentId kommt von der API populated ({_id, name}) — Name als Auflösung anhängen.
  const agent = r.agentId && r.agentId.name;
  return agent ? `${from} → ${to} (${agent})` : `${from} → ${to}`;
}

/** Modus für die Anzeige großschreiben ("agent" → "Agent"). Intern bleibt klein. */
export function modeLabel(mode) {
  if (!mode) return "—";
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

/** Badge-Variant passend zum Anruf-Status. */
export function statusVariant(status) {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  return "primary"; // in_progress
}

/** Anruf-Status für die Anzeige übersetzen (intern weiter englische Werte). */
export function statusLabel(status) {
  switch (status) {
    case "completed":
      return "Abgeschlossen";
    case "failed":
      return "Fehlgeschlagen";
    case "in_progress":
      return "Läuft";
    default:
      return status || "—";
  }
}
