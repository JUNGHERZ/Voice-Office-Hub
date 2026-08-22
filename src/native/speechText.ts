/**
 * Text für die Sprachausgabe putzen (0.11.2).
 *
 * Sprachmodelle formatieren, als schrieben sie in ein Chatfenster: `**fett**`, Aufzählungs-
 * striche, gelegentlich ein Emoji. Eine Sprachsynthese liest das wörtlich — „Sternchen
 * Sternchen", und jedes Piktogramm als seine Beschreibung („winkende Hand"). Ein Hinweis im
 * Prompt ist nur eine Bitte an ein Modell; hier wird es zugesichert.
 *
 * **Nur der Weg zur Synthese.** Ins Transkript geht weiterhin, was das Modell geschrieben
 * hat — Auswertungen und Zusammenfassungen laufen darauf, und ein nachträglich geputzter
 * Text ließe sich nicht mehr von der Modellausgabe unterscheiden.
 *
 * Zwei Stufen, weil zwei verschiedene Probleme:
 *
 *  1. `createBreakNormalizer` läuft **vor** dem Satz-Zerleger, auf dem Token-Strom. Es macht
 *     ausschließlich aus Zeilenumbrüchen Satzgrenzen — sonst hätte eine Aufzählung ohne
 *     Satzzeichen gar keine, der Zerleger hielte sie bis zum Stream-Ende zurück, und der
 *     Sprechbeginn verschöbe sich um die gesamte Antwortdauer. Ein `\n` ist im Strom
 *     eindeutig, deshalb ist dieser Schritt zeichenweise sicher.
 *  2. `sanitizeForSpeech` läuft an der EINEN Stelle, an der Text in die Synthese geht
 *     (nativeSession.speak). Dort ist der Satz vollständig — Auszeichnungen, die über
 *     Delta-Grenzen verteilt ankamen, stehen wieder zusammen. Reste, die über eine
 *     Satzgrenze hinausreichen, fängt die Schlussregel ab.
 */

/**
 * Emoji, Piktogramme, Flaggen — alles, was eine Synthese als Beschreibung vorlesen würde.
 * Mit den Beiwerk-Zeichen (Variantenselektor, Zero-Width-Joiner, Keycap), sonst bleiben von
 * zusammengesetzten Emoji unsichtbare Reste stehen.
 */
const PICTOGRAPHS =
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D\u20E3]/gu;

/**
 * Keycap-Emoji („1️⃣") sind Ziffer + Beiwerk. Ohne eigene Regel bliebe die Ziffer stehen und
 * die Synthese läse eine Zahl vor, die niemand gemeint hat.
 */
const KEYCAPS = /[0-9#*]\uFE0F?\u20E3/gu;

/**
 * Zeilenumbrüche in Sprechpausen wandeln. Zustandsbehaftet, weil vor dem Umbruch schon ein
 * Satzzeichen stehen kann und dann kein zweites dazugehört („Guten Tag.\n" → „Guten Tag. ").
 */
export function createBreakNormalizer(): (delta: string) => string {
  let lastChar = "";
  return (delta) => {
    let out = "";
    for (const ch of delta) {
      if (ch === "\n" || ch === "\r") {
        // Mehrere Umbrüche hintereinander ergeben eine Pause, nicht mehrere.
        if (lastChar === "\n") continue;
        out += ".,;:!?…".includes(lastChar) || lastChar === "" ? " " : ". ";
        lastChar = "\n";
        continue;
      }
      out += ch;
      if (!/\s/.test(ch)) lastChar = ch;
    }
    return out;
  };
}

/**
 * Auszeichnung entfernen, Piktogramme entfernen, Zeilenumbrüche zu Pausen glätten.
 *
 * Reihenfolge ist Absicht: Erst die Blöcke (Zäune, Zeilenanfänge), dann die Paare, dann die
 * Reste. Ein `**`, dessen Gegenstück in der nächsten Sprecheinheit steht, fiele sonst durch.
 */
export function sanitizeForSpeech(text: string): string {
  let s = text;

  // Code-Zäune und ihre Sprachangabe: der Inhalt bleibt, die Zäune gehen.
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?/g, " ").replace(/```/g, " ");

  // Zeilenanfänge: Überschriften-Rauten, Zitatpfeile, Aufzählungs- und Nummernmarker.
  // Der Bindestrich nur MIT folgendem Leerzeichen — „E-Mail" und „- 5 Grad" bleiben heil.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  s = s.replace(/^[ \t]*>[ \t]?/gm, "");
  s = s.replace(/^[ \t]*[-*+•‣▪][ \t]+/gm, "");
  s = s.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");

  // Trennlinien einer eigenen Zeile ("---", "***", "___").
  s = s.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "");

  // Paarige Auszeichnung: Inhalt behalten, Marker weg. Bei ** vor *, sonst bleibt je ein
  // Sternchen stehen. `_` nur zwischen Wortgrenzen — „snake_case" ist keine Kursivschrift.
  s = s.replace(/\*\*\*(.+?)\*\*\*/gs, "$1");
  s = s.replace(/\*\*(.+?)\*\*/gs, "$1");
  s = s.replace(/\*(?!\s)(.+?)(?<!\s)\*/gs, "$1");
  s = s.replace(/(?<![A-Za-z0-9])__(.+?)__(?![A-Za-z0-9])/gs, "$1");
  s = s.replace(/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/gs, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");

  // Links: der Text wird gesprochen, das Ziel nicht. Ein Bild-Marker verschwindet ganz.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  s = s.replace(KEYCAPS, " ").replace(PICTOGRAPHS, " ");

  // Was von unpaariger Auszeichnung übrig ist — der Fall, in dem das Gegenstück in der
  // nächsten Sprecheinheit steht. Ohne diese Zeile bliebe genau das eine Sternchen stehen,
  // das die Synthese dann vorliest.
  //
  // Zwei Ausnahmen stecken in den Umschauen: Ein Zeichen MIT Buchstaben auf beiden Seiten
  // ist Teil eines Wortes („snake_case"), eines mit Leerraum auf beiden Seiten ist keine
  // Auszeichnung, sondern Text („2 * 3"). Nur was einseitig an einem Wort klebt, fliegt.
  s = s.replace(/(?<=\S)[*_`]+(?![A-Za-z0-9])|(?<![A-Za-z0-9])[*_`]+(?=\S)/g, "");

  // Zeilenumbrüche zu Sprechpausen (dieselbe Regel wie im Strom-Vorlauf): Wo schon ein
  // Satzzeichen steht, kommt keines dazu — sonst spricht die Synthese „Punkt Punkt".
  let joined = "";
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!joined) {
      joined = line;
      continue;
    }
    const before = joined.slice(-1);
    joined += (".,;:!?…".includes(before) ? " " : ". ") + line;
  }

  return joined.replace(/[ \t]{2,}/g, " ").trim();
}
