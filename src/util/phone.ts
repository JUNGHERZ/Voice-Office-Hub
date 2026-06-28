/**
 * Rufnummern-Normalisierung fürs DDI-Routing. Trunks/Provider liefern Zielrufnummern
 * in unterschiedlichen Schreibweisen (`+4930…`, `004930…`, mit Leer-/Sonderzeichen);
 * Dev-Durchwahlen (z.B. `120`) bleiben unverändert. Für den Vergleich bringen wir beide
 * Seiten auf eine kanonische Form.
 */

/**
 * Kanonische Vergleichsform: Trennzeichen entfernt, internationaler Präfix vereinheitlicht —
 * führendes `+` **oder** `00` wird entfernt. So matchen `+49236298381975`, `0049236298381975`
 * und `49236298381975` (so wie der Trunk die DDI liefert) auf dieselbe Form. Eine nationale
 * Schreibweise mit führender `0` (z. B. `0236…`) bleibt unverändert und matcht daher NICHT die
 * internationale DDI — für das Routing-Feld immer die internationale Form eintragen.
 */
export function normalizePhone(input: string | undefined | null): string {
  if (!input) return "";
  let s = String(input).trim().replace(/[\s\-()/.]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  return s;
}

/** True, wenn beide Nummern nach Normalisierung gleich sind (leer zählt nie als Treffer). */
export function samePhone(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizePhone(a);
  return na.length > 0 && na === normalizePhone(b);
}

/**
 * Externe Rufnummer (PSTN/Mobil) vs. interne Durchwahl (z. B. `101`, `120`).
 * Heuristik: enthält `+`/`00`-Präfix ODER hat ≥ 7 Ziffern → extern (über den Trunk wählen).
 */
export function looksExternal(input: string | undefined | null): boolean {
  const s = normalizePhone(input);
  if (!s) return false;
  return s.replace(/\D/g, "").length >= 7;
}

/**
 * Absender-CLI im SIPGate-Format für `P-Preferred-Identity` (`<sip:49…@server>`):
 * `+` entfernen, nationale führende `0` → `49`, `0049` → `49` (über normalizePhone).
 * Liefert nur Ziffern; leere/interne Eingaben → "".
 */
export function toSipgateCli(input: string | undefined | null): string {
  let s = normalizePhone(input); // entfernt Trennzeichen, 00 → +
  if (!s) return "";
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("0")) s = "49" + s.slice(1);
  return s.replace(/\D/g, "");
}
