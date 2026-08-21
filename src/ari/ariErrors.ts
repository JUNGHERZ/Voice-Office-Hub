/**
 * Deutung von ARI-Fehlern beim Anrufaufbau.
 *
 * Zwischen `StasisStart` und der fertigen Verdrahtung liegen mehrere ARI-Aufrufe
 * (answer, bridges.create, addChannel, externalMedia). Legt der Anrufer in diesem
 * Fenster auf, scheitern sie — nicht weil etwas kaputt ist, sondern weil der Kanal
 * weg ist. Das ist ein regulärer Ausgang und keine Störung.
 *
 * Bis 0.9.x war das Fenster ~1 ms breit und der Fall praktisch unmöglich; seit die
 * Begrüßung vor dem Answer erzeugt wird (0.10.0), sind es 1,2–1,6 s — und damit ein
 * Alltagsereignis, das nicht als Fehlschlag protokolliert werden darf.
 *
 * Asterisk meldet den verschwundenen Kanal je nach Aufruf unterschiedlich:
 * `answer` mit 409, `addChannel` mit 422 (beide „Channel not in Stasis application"),
 * ein bereits abgeräumter Kanal mit 404 („Channel not found"). Der ari-client legt den
 * JSON-Körper der Antwort in `err.message`, deshalb wird auf den Text geprüft.
 */

/** Meldet der Fehler einen Kanal, den es nicht mehr gibt (bzw. der Stasis verlassen hat)? */
export function isChannelGone(err: unknown): boolean {
  return /not in Stasis application|Channel not found/i.test(errorText(err));
}

function errorText(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" ? msg : String(err);
}
