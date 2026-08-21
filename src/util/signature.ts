/**
 * Signatur für ausgehende Aufrufe an fremde Endpunkte (Overlay-Hook, Ereignis-Zustellung).
 *
 * Signiert wird der ROHE Body — genau der String, der auch gesendet wird. Deshalb wird
 * überall einmal serialisiert und dieselbe Zeichenkette signiert und übertragen; ein
 * zweites `JSON.stringify` könnte eine andere Schlüsselreihenfolge liefern und die
 * Prüfung beim Empfänger fehlschlagen lassen.
 */
import { createHmac } from "node:crypto";

/** `sha256=<hex>` über den rohen Body — Format des Headers `X-VOH-Signature`. */
export function signBody(raw: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
}
