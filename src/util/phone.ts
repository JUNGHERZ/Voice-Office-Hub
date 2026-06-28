/**
 * Rufnummern-Normalisierung fürs DDI-Routing. Trunks/Provider liefern Zielrufnummern
 * in unterschiedlichen Schreibweisen (`+4930…`, `004930…`, mit Leer-/Sonderzeichen);
 * Dev-Durchwahlen (z.B. `120`) bleiben unverändert. Für den Vergleich bringen wir beide
 * Seiten auf eine kanonische Form.
 */

/** Kanonische Form: Trennzeichen entfernt, führendes `00` → `+`. */
export function normalizePhone(input: string | undefined | null): string {
  if (!input) return "";
  let s = String(input).trim().replace(/[\s\-()/.]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  return s;
}

/** True, wenn beide Nummern nach Normalisierung gleich sind (leer zählt nie als Treffer). */
export function samePhone(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizePhone(a);
  return na.length > 0 && na === normalizePhone(b);
}
