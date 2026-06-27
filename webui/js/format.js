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
 * Anruflänge (Sekunden) eines Requests: bevorzugt das Top-Level-Feld durationSec
 * (startedAt→endedAt), Fallback auf recording.durationSec. Liefert undefined,
 * wenn nichts gesetzt ist (z. B. alte Seed-Requests).
 */
export function callDurationSec(r) {
  if (r && typeof r.durationSec === "number") return r.durationSec;
  if (r && r.recording && typeof r.recording.durationSec === "number") {
    return r.recording.durationSec;
  }
  return undefined;
}

/** Anruflänge formatiert ("m:ss") oder "—", wenn keine Dauer vorhanden. */
export function fmtCallDuration(r) {
  const sec = callDurationSec(r);
  return sec === undefined ? "—" : fmtDuration(sec);
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

/** "caller → target"-Kurzbeschriftung eines Anrufs. */
export function callLabel(r) {
  const from = r.callerNumber || "unbekannt";
  const to = r.targetNumber || "—";
  return `${from} → ${to}`;
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
