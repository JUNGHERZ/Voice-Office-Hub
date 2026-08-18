/**
 * Zustandsbehafteter linear16-Resampler (mono, 16-bit LE) für TTS-Provider, deren
 * Ausgabe nicht auf der System-Sample-Rate liegt — Mistral Voxtral liefert fest
 * 24 kHz, die Telefonstrecke fährt 8 kHz (AUDIO_SAMPLE_RATE).
 *
 * WARUM nicht einfach jedes n-te Sample nehmen: ohne Tiefpass faltet sich alles
 * oberhalb der Ziel-Nyquistfrequenz zurück ins Sprachband. Bei 24→8 kHz landen
 * 4–12 kHz (Zischlaute, Plosive) als metallisches Sirren mitten im Telefonband —
 * der klassische Roboterklang. Die vorhandenen Filter im Medienpfad helfen nicht:
 * DC_ALPHA in audiosocketServer.ts ist ein ~6-Hz-HOCHpass, die Rampen sind
 * 5-ms-Hüllkurven; beide sind Kilohertz vom Problem entfernt.
 *
 * Verfahren: rationales Polyphase-L/M (Interpolation um L, FIR-Tiefpass, Dezimation
 * um M) mit Fenster-Sinc-Prototyp (Hamming). Der Zustand überlebt Chunk-Grenzen —
 * inklusive eines übrig gebliebenen halben Samples, denn ein Netzwerk-Chunk darf
 * mitten in ein 16-Bit-Sample fallen.
 */

/** Ziel-Länge des Prototyp-Filters auf der Zwischenrate (fromRate·L). */
const TAPS_TARGET = 96;
/**
 * Durchlassgrenze als Anteil der kleineren Nyquistfrequenz. 0,9 legt den Cutoff
 * bei 24→8 kHz auf 3600 Hz: knapp über dem Telefon-Durchlassband (3400 Hz) und
 * unter Nyquist (4000 Hz) — Restaliasing landet oberhalb 3,5 kHz auf niedrigem Pegel.
 */
const CUTOFF_RATIO = 0.9;
/** Obergrenze für den Interpolationsfaktor; darüber wird der Filter unwirtschaftlich. */
const MAX_L = 16;

export interface Resampler {
  /** PCM-Chunk einspeisen; liefert das resamplete Stück (ggf. leer). */
  push(pcm: Buffer): Buffer;
  /** Zustand verwerfen (Barge-in) — der nächste push startet sauber. */
  reset(): void;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** L/M-Zerlegung des Ratenverhältnisses (gekürzt). */
function ratio(fromRate: number, toRate: number): { L: number; M: number } {
  const g = gcd(toRate, fromRate);
  return { L: toRate / g, M: fromRate / g };
}

export function supportsResample(fromRate: number, toRate: number): boolean {
  if (!Number.isInteger(fromRate) || !Number.isInteger(toRate)) return false;
  if (fromRate <= 0 || toRate <= 0) return false;
  if (fromRate === toRate) return true;
  return ratio(fromRate, toRate).L <= MAX_L;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/**
 * Fenster-Sinc-Tiefpass auf der Zwischenrate. Die DC-Verstärkung wird auf L
 * normiert — das Nullstopfen der Interpolation senkt die Energie um genau diesen
 * Faktor, sonst käme die Ausgabe um 1/L zu leise heraus.
 */
function buildKernel(L: number, fromRate: number, toRate: number): Float64Array {
  const tapsPerPhase = Math.ceil(TAPS_TARGET / L);
  const taps = tapsPerPhase * L;
  const intermediateRate = fromRate * L;
  const cutoffHz = (CUTOFF_RATIO * Math.min(fromRate, toRate)) / 2;
  const fc = cutoffHz / intermediateRate; // normiert auf die Zwischenrate
  const center = (taps - 1) / 2;

  const h = new Float64Array(taps);
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (taps - 1));
    const v = 2 * fc * sinc(2 * fc * (k - center)) * window;
    h[k] = v;
    sum += v;
  }
  // Normierung auf DC-Verstärkung L (Ausgleich fürs Nullstopfen).
  const scale = L / sum;
  for (let k = 0; k < taps; k++) h[k] = (h[k] ?? 0) * scale;
  return h;
}

/** Reiner Durchreicher für gleiche Raten — kein Kopieraufwand, kein Zustand. */
function identityResampler(): Resampler {
  return { push: (pcm) => pcm, reset: () => {} };
}

/**
 * Polyphase-Kern. Für Ausgabesample n gilt y[n] = Σ_i h[p + i·L] · x[base − i]
 * mit base = ⌊n·M/L⌋ und p = (n·M) mod L. base und p werden inkrementell
 * fortgeschrieben, damit n nicht unbegrenzt wächst.
 */
function polyphaseResampler(fromRate: number, toRate: number): Resampler {
  const { L, M } = ratio(fromRate, toRate);
  const h = buildKernel(L, fromRate, toRate);
  const tapsPerPhase = h.length / L;
  /** So viele Vorgänger-Samples braucht jedes Ausgabesample. */
  const histLen = tapsPerPhase - 1;

  let buf = new Int16Array(histLen); // Vorlauf mit Stille
  let cursor = histLen; // Index des base-Samples des nächsten Ausgabesamples
  let phase = 0;
  /** Halbes Sample aus dem vorigen Chunk (Netzwerkgrenze mitten im 16-Bit-Wort). */
  let oddByte: number | undefined;

  const reset = (): void => {
    buf = new Int16Array(histLen);
    cursor = histLen;
    phase = 0;
    oddByte = undefined;
  };

  const push = (pcm: Buffer): Buffer => {
    if (!pcm.length && oddByte === undefined) return Buffer.alloc(0);

    // Übrig gebliebenes Byte des Vorgängers voranstellen.
    let raw = pcm;
    if (oddByte !== undefined) {
      raw = Buffer.concat([Buffer.from([oddByte]), pcm]);
      oddByte = undefined;
    }
    const usable = raw.length - (raw.length % 2);
    if (usable < raw.length) oddByte = raw[usable];
    if (!usable) return Buffer.alloc(0);

    // Eingang an den Zustand anhängen.
    const incoming = usable / 2;
    const merged = new Int16Array(buf.length + incoming);
    merged.set(buf, 0);
    for (let i = 0; i < incoming; i++) merged[buf.length + i] = raw.readInt16LE(i * 2);
    buf = merged;

    // Alles produzieren, wofür genügend Vorlauf UND Nachschub da ist.
    const out: number[] = [];
    while (cursor < buf.length) {
      let acc = 0;
      for (let i = 0; i < tapsPerPhase; i++) {
        acc += (h[phase + i * L] ?? 0) * (buf[cursor - i] ?? 0);
      }
      out.push(acc < -32768 ? -32768 : acc > 32767 ? 32767 : Math.round(acc));
      phase += M;
      cursor += Math.floor(phase / L);
      phase %= L;
    }

    // Nur den benötigten Vorlauf behalten.
    const keepFrom = Math.max(0, cursor - histLen);
    if (keepFrom > 0) {
      buf = buf.slice(keepFrom);
      cursor -= keepFrom;
    }

    const result = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) result.writeInt16LE(out[i] ?? 0, i * 2);
    return result;
  };

  return { push, reset };
}

/**
 * Resampler für ein Ratenpaar. Gleiche Raten ⇒ Durchreicher. Nicht unterstützte
 * Paare wirft die Funktion NICHT — der Aufrufer prüft vorher mit supportsResample()
 * und fällt sonst auf einen anderen TTS-Provider zurück (ein Anruf scheitert nie
 * an der TTS-Auswahl).
 */
export function createResampler(fromRate: number, toRate: number): Resampler {
  if (fromRate === toRate) return identityResampler();
  if (!supportsResample(fromRate, toRate)) {
    throw new Error(`Resampling ${fromRate}→${toRate} Hz wird nicht unterstützt`);
  }
  return polyphaseResampler(fromRate, toRate);
}
