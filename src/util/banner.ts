/**
 * Dekoratives Start-Banner für die Konsole: „VOH"-Blockschrift (pro Buchstabe eine Farbe,
 * Brand-Orangetöne) + Name/Version + Kernmerkmale der aktivierten Konfiguration.
 * Farben via ANSI-Truecolor; mit NO_COLOR=1 abschaltbar.
 */
import { readFileSync } from "node:fs";

import { config } from "../config.js";

const NO_COLOR = !!process.env.NO_COLOR;
const c = (code: string) => (NO_COLOR ? "" : code);
const RESET = c("\x1b[0m");
const DIM = c("\x1b[2m");
const BOLD = c("\x1b[1m");
const fg = (r: number, g: number, b: number) => c(`\x1b[38;2;${r};${g};${b}m`);

const ORANGE = fg(245, 166, 35); //  #f5a623
const AMBER = fg(255, 191, 82); //   #ffbf52
const RUST = fg(212, 105, 42); //    #d4692a
const GREEN = fg(52, 199, 89);
const GREY = fg(142, 142, 147);

// Blockschrift, je Buchstabe 5×5 — pro Buchstabe eine eigene Farbe.
const V = ["█   █", "█   █", "█   █", " █ █ ", "  █  "];
const O = [" ███ ", "█   █", "█   █", "█   █", " ███ "];
const H = ["█   █", "█   █", "█████", "█   █", "█   █"];

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "?");
  } catch {
    return "?";
  }
}

function flag(on: boolean): string {
  return on ? `${GREEN}✓${RESET}` : `${GREY}–${RESET}`;
}

export function printBanner(): void {
  const side = ["", `${BOLD}${ORANGE}Voice-Office-Hub${RESET}`, `${DIM}VOH-Appliance · v${version()}${RESET}`, "", ""];
  const out: string[] = [""];
  for (let i = 0; i < 5; i++) {
    let row = `  ${ORANGE}${V[i]}${RESET}  ${AMBER}${O[i]}${RESET}  ${RUST}${H[i]}${RESET}`;
    if (side[i]) row += `    ${side[i]}`;
    out.push(row);
  }

  const trunkOn = (process.env.TRUNK_ENABLED ?? "false") === "true";
  const facts = [
    `${flag(config.ari.embedAsterisk)} Asterisk ${DIM}(eingebettet)${RESET}`,
    `${flag(config.mongo.useLocal)} MongoDB ${DIM}(${config.mongo.useLocal ? "lokal" : "extern"})${RESET}`,
    `${flag(!!config.admin.password)} Admin-UI/API${config.admin.password ? ` ${DIM}:${config.admin.port}${RESET}` : ""}`,
    `${flag(trunkOn)} SIP-Trunk`,
    `${flag(config.summary.enabled)} Summary`,
  ];
  out.push("");
  out.push(`  ${DIM}Konfiguration:${RESET}  ${facts.join("   ")}`);
  out.push(`  ${DIM}Transport: ${config.audio.transport} · LLM: ${config.llm.provider} (${config.llm.model})${RESET}`);
  out.push("");

  console.log(out.join("\n"));
}
