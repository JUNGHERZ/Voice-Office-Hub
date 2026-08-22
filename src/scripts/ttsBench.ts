/**
 * TTS-Messharness: schickt dieselben deutschen Sätze durch jeden konfigurierten
 * Provider und misst Time-to-First-Audio (TTFA), Audiodauer, Verbrauch und Kosten.
 *
 * Zweck: Die Provider-Entscheidung (etwa ElevenLabs → Voxtral) soll aus eigenen
 * Zahlen fallen statt aus Herstellerangaben. Die Angaben unterscheiden sich
 * erheblich — Mistral nennt 70–90 ms MODELL-Latenz, die API liefert laut eigener
 * Doku aber ~0,8 s End-to-End; ElevenLabs hält dagegen einen warmen Socket.
 *
 * Ausführen (im Container):  node dist/scripts/ttsBench.js
 * bzw. lokal:                npx tsx src/scripts/ttsBench.ts
 * Optional: TTS_BENCH_PROVIDERS=mistral,eleven_labs begrenzt die Auswahl.
 *
 * Braucht KEINE Datenbank und KEIN Asterisk — nur die API-Keys im Env.
 */
import { config } from "../config.js";
import { buildNativeTts } from "../native/ttsFactory.js";
import type { TtsStreamLike } from "../native/types.js";
import { TTS_PROVIDERS, type TtsProviderEntry } from "../tts/catalog.js";
import type { ResolvedAgent, ResolvedSpeak } from "../types.js";

/** Repräsentative Turns eines Telefonats: kurz, mittel, lang. */
const SENTENCES = [
  "Guten Tag, hier ist das Büro von Doktor Meier.",
  "Einen Moment bitte, ich schaue kurz im Kalender nach.",
  "Ich habe am Donnerstag um vierzehn Uhr dreißig einen Termin frei, passt Ihnen das? Andernfalls hätte ich noch Freitagvormittag anzubieten.",
];

/** Stimme je Provider fürs Benchmark — bewusst deutsche Stimmen, wo verfügbar. */
const BENCH_VOICE: Record<string, { model?: string; voice?: string }> = {
  deepgram: { model: "aura-2-viktoria-de" },
  eleven_labs: { model: "eleven_flash_v2_5", voice: process.env.TTS_BENCH_ELEVEN_VOICE ?? "" },
  // Voxtral hat KEINE deutschen Preset-Stimmen (Cloning-Modell) — die englische
  // Neutral-Stimme spricht den deutschen Text cross-lingual.
  mistral: { model: "voxtral-mini-tts-latest", voice: "en_paul_neutral" },
  azure: { model: "de-DE-KatjaNeural" },
  // Flux TTS gibt es nur auf Englisch — der deutsche Testsatz misst hier also
  // Latenz und Kosten, nicht die Aussprache.
  deepgram_flux: { model: "flux-haley-en" },
  // Deutsche Stimme aus dem simba-3.0-Katalog (live abgefragt 2026-08-18).
  speechify: { model: "simba-3.0", voice: process.env.TTS_BENCH_SPEECHIFY_VOICE ?? "katharina-agent" },
  fish_audio: { model: "s2.1-pro", voice: process.env.TTS_BENCH_FISH_VOICE ?? "" },
};

interface Sample {
  ttfaMs: number;
  audioMs: number;
}

function benchAgent(entry: TtsProviderEntry): ResolvedAgent {
  const pick = BENCH_VOICE[entry.id] ?? {};
  const speak: ResolvedSpeak = {
    provider: entry.id,
    model: pick.model ?? entry.defaultModel,
    ...(pick.voice ? { voice: pick.voice } : {}),
    // Der Bench misst die Synthese, nicht die Textaufbereitung — die Messsätze sind roh.
    sanitize: false,
  };
  // Nur die Felder, die der TTS-Bau liest — das Harness startet keine Session.
  return { speak } as ResolvedAgent;
}

/**
 * Einen Satz synthetisieren und dabei TTFA sowie Audiodauer messen.
 *
 * Das Ende erkennt ein Ruhe-Timeout statt des `flushed`-Events: ElevenLabs sendet
 * `isFinal` am realen Endpoint erst beim Verbindungsende, nicht nach `flush`
 * (live gemessen 2026-08-18, siehe ttsElevenLabs.ts). Ein Harness, das auf
 * `flushed` wartet, misst deshalb je nach Provider verschiedene Dinge — oder
 * läuft in einen Timeout. Gemessen wird ohnehin die TTFA; die ist von der
 * Ende-Erkennung unabhängig.
 */
const QUIET_MS = 1500;

function speakOnce(tts: TtsStreamLike, text: string, sampleRate: number): Promise<Sample> {
  return new Promise<Sample>((resolve, reject) => {
    const t0 = Date.now();
    let firstAt = 0;
    let bytes = 0;
    let quiet: NodeJS.Timeout | undefined;
    const hard = setTimeout(() => finish(new Error("Timeout (25 s) ohne Audio")), 25_000);

    const finish = (err?: Error): void => {
      clearTimeout(hard);
      if (quiet) clearTimeout(quiet);
      if (err) return reject(err);
      resolve({
        ttfaMs: firstAt ? firstAt - t0 : -1,
        // linear16 mono: 2 Byte je Sample.
        audioMs: Math.round((bytes / 2 / sampleRate) * 1000),
      });
    };

    tts.on("audio", ((chunk: Buffer) => {
      if (!firstAt) firstAt = Date.now();
      bytes += chunk.length;
      // Nach jedem Chunk das Ruhefenster neu aufziehen.
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => finish(), QUIET_MS);
    }) as never);
    tts.on("flushed", (() => finish()) as never); // Provider, die es können, sind sofort fertig
    tts.on("error", ((e: string) => finish(new Error(e))) as never);

    tts.sendText(text);
    tts.flush();
  });
}

async function benchProvider(entry: TtsProviderEntry): Promise<void> {
  const agent = benchAgent(entry);
  const samples: Sample[] = [];
  let characters = 0;
  let actualProvider: string = entry.id;

  for (const text of SENTENCES) {
    // Pro Satz ein frischer Strom: sonst misst man beim zweiten Satz einen warmen
    // Socket und beim ersten den Verbindungsaufbau — zwei verschiedene Dinge.
    const tts = buildNativeTts(agent, "bench");
    try {
      await tts.start();
      samples.push(await speakOnce(tts, text, config.audio.sampleRate));
      characters += text.length;
      actualProvider = tts.usage?.()?.provider ?? entry.id;
    } finally {
      tts.close();
    }
  }

  // buildNativeTts fällt bei fehlender Konfiguration still auf Aura zurück —
  // sonst stünde hier zweimal Aura in der Tabelle.
  if (actualProvider !== entry.id) {
    console.log(`${entry.label.padEnd(22)} übersprungen (Fallback auf ${actualProvider} — ${entry.envKey} gesetzt?)`);
    return;
  }

  const ttfas = samples.map((s) => s.ttfaMs).sort((a, b) => a - b);
  const median = ttfas[Math.floor(ttfas.length / 2)] ?? -1;
  const audioSec = samples.reduce((n, s) => n + s.audioMs, 0) / 1000;
  const costUsd = (characters / 1000) * entry.costPer1kChars;
  const costPerMin = audioSec > 0 ? (costUsd / audioSec) * 60 : 0;

  console.log(
    [
      entry.label.padEnd(22),
      `TTFA ${String(median).padStart(5)} ms (min ${ttfas[0]}, max ${ttfas[ttfas.length - 1]})`,
      `Audio ${audioSec.toFixed(1)} s`,
      `${characters} Zeichen`,
      `$${costUsd.toFixed(4)} ≈ $${costPerMin.toFixed(4)}/min`,
    ].join(" · "),
  );
}

async function main(): Promise<void> {
  const only = (process.env.TTS_BENCH_PROVIDERS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const candidates = TTS_PROVIDERS.filter(
    (p) => p.implemented && p.paths.includes("native") && (!only.length || only.includes(p.id)),
  );

  console.log(`TTS-Benchmark · ${SENTENCES.length} Sätze · Ziel-Rate ${config.audio.sampleRate} Hz\n`);
  for (const entry of candidates) {
    try {
      await benchProvider(entry);
    } catch (err) {
      console.log(`${entry.label.padEnd(22)} FEHLER: ${String(err)}`);
    }
  }
  console.log(
    "\nHinweis: TTFA enthält den Verbindungsaufbau (pro Satz frischer Strom) — genau das,\n" +
      "was der Anrufer beim ersten Wort einer Antwort erlebt. Kosten sind Listenpreise\n" +
      "aus src/tts/catalog.ts, keine Abrechnung.",
  );
}

main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
