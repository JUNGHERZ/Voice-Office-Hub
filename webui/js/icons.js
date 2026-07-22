/*
 * Gemeinsame Leading-Icons für glk-list-Zeilen (Stil wie webui/mockup.html,
 * Feather-artige 24er-Strokes).
 *
 * WICHTIG (GlassKit-Falle): Shadow-CSS der glk-Komponenten erreicht geslottete
 * Inhalte nicht — jede View muss die Icon-Größe selbst setzen, sonst kollabiert
 * das SVG auf 0×0:
 *   span[slot="leading"] { display: flex; align-items: center; justify-content: center; }
 *   span[slot="leading"] svg { width: 24px; height: 24px; }
 */
import { html } from "hybrids";

/** Headset — KI-Agent. */
export const ICON_AGENT = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;

/** Transfer-Pfeile — Passthrough/Weiterleitung. */
export const ICON_PASSTHROUGH = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;

/** Telefonhörer — Anruf über Trunk/Softphone. */
export const ICON_PHONE = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

/** Globus — Anruf aus dem Web-Widget (Caller-ID web-<uniqueid>). */
export const ICON_WEB = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

/** Anruf-Zeilen: Icon nach Herkunft (Web vs. Telefon) — der Modus steht im Badge/Filter. */
export function callIcon(r) {
  return /^web-/.test((r && r.callerNumber) || "") ? ICON_WEB : ICON_PHONE;
}
