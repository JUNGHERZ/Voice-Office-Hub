/*
 * Live-Ansicht: laufende Anrufe (status=in_progress) mit tickender Dauer.
 * 3-s-Polling der Liste + 1-s-Ticker für die Anzeige; Klick → Anruf-Detail
 * (das bei laufendem Anruf selbst still nachlädt).
 *
 * Bewusst Polling statt Push: Admin-Prozess und Engine teilen nur MongoDB
 * (Standalone, keine Change Streams) — Ausbaustufe siehe docs/backlog.md.
 */
import { define, html } from "hybrids";

import { api } from "../api.js";
import { callLabel, fmtDuration } from "../format.js";
import { callIcon } from "../icons.js";

const POLL_MS = 3000;

function navigate(host, view, id) {
  host.dispatchEvent(
    new CustomEvent("navigate", { detail: { view, id }, bubbles: true, composed: true }),
  );
}

async function poll(host) {
  try {
    const res = await api.listRequests({ status: "in_progress", limit: 50 });
    host.items = res.items || [];
    host.error = "";
  } catch (e) {
    // Fehler nur anzeigen, solange noch nie Daten kamen — sonst still weiterversuchen.
    if (!host.items) host.error = "Live-Daten konnten nicht geladen werden.";
  } finally {
    host.loading = false;
  }
}

function liveDuration(r, now) {
  const start = new Date(r.startedAt).getTime();
  if (Number.isNaN(start)) return "—";
  return fmtDuration(Math.max(0, (now - start) / 1000));
}

export default define({
  tag: "live-view",
  loading: true,
  error: "",
  items: undefined,
  now: 0, // Ticker-Zeitstempel, treibt die laufende Dauer-Anzeige
  render: {
    value: ({ loading, error, items, now }) => html`
      <div class="head">
        <glk-title style="font-size:22px">Live</glk-title>
        <span class="pulse ${items && items.length ? "on" : ""}"></span>
      </div>

      ${error && html`<glk-status message="${error}"></glk-status>`}
      ${loading && !items
        ? html`<glk-status message="Lädt …"></glk-status>`
        : (items || []).length === 0
          ? html`<div class="empty">Gerade keine laufenden Anrufe.</div>`
          : html`
              <glk-list>
                ${items.map(
                  (r) => html`
                    <glk-list-item
                      interactive
                      title="${callLabel(r)}"
                      subtitle="${`${r.mode === "passthrough" ? "Passthrough" : "Agent"} · seit ${liveDuration(r, now)}`}"
                      onglk-click="${(host) => navigate(host, "request", r._id)}"
                    >
                      <span slot="leading">${callIcon(r)}</span>
                      <span slot="trailing">
                        <glk-badge variant="primary">Läuft</glk-badge>
                      </span>
                    </glk-list-item>
                  `,
                )}
              </glk-list>
            `}
    `.css`
      .head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
      .empty { font-size: 14px; color: var(--gl-color-text-muted); padding: 18px 4px; }
      .pulse {
        width: 10px; height: 10px; border-radius: 50%;
        background: var(--gl-color-text-muted); opacity: .35;
      }
      .pulse.on { background: #34c759; opacity: 1; animation: livePulse 1.6s ease-in-out infinite; }
      @keyframes livePulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(52, 199, 89, .45); }
        50% { box-shadow: 0 0 0 6px rgba(52, 199, 89, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .pulse.on { animation: none; }
      }
      /* GlassKit-Falle: Shadow-CSS erreicht Slot-Inhalte nicht — Icon-Größe hier setzen. */
      span[slot="leading"] { display: flex; align-items: center; justify-content: center; }
      span[slot="leading"] svg { width: 24px; height: 24px; }
    `,
    connect: (host) => {
      host.now = Date.now();
      poll(host);
      const pollTimer = setInterval(() => poll(host), POLL_MS);
      const tickTimer = setInterval(() => {
        host.now = Date.now();
      }, 1000);
      return () => {
        clearInterval(pollTimer);
        clearInterval(tickTimer);
      };
    },
  },
});
