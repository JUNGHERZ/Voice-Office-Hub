/*
 * Anruf-Detail: Meta-Badges, Audio-Player (nur wenn Aufnahme vorhanden),
 * Transkript als Bubbles (Sprecherseiten unterschiedlich ausgerichtet),
 * Summary-Card und optional functionCalls-Liste.
 *
 * Attribut "request-id" steuert, welcher Anruf geladen wird.
 */
import { define, html } from "hybrids";

import { api } from "../api.js";
import { callDurationSec, callLabel, fmtDuration, fmtSecondsFromMs, modeLabel, statusLabel, statusVariant } from "../format.js";

function navigate(host, view, id) {
  host.dispatchEvent(
    new CustomEvent("navigate", { detail: { view, id }, bubbles: true, composed: true }),
  );
}

async function load(host) {
  host.loading = true;
  host.error = "";
  try {
    const res = await api.getRequest(host.requestId);
    host.request = res.request;
  } catch (e) {
    host.error = "Anruf konnte nicht geladen werden.";
  } finally {
    host.loading = false;
  }
}

/* Bei laufendem Anruf still nachladen (kein loading-Flag → kein Flackern). */
async function silentReload(host) {
  try {
    const res = await api.getRequest(host.requestId);
    host.request = res.request;
  } catch (e) {
    /* still — der nächste Tick versucht es erneut */
  }
}

// Sprecherseite → Bubble-Ausrichtung. agent-Modus: agent|caller; passthrough: caller|callee.
function isLeft(speaker) {
  return speaker === "agent" || speaker === "callee";
}
function speakerLabel(speaker) {
  switch (speaker) {
    case "agent":
      return "Agent";
    case "caller":
      return "Anrufer";
    case "callee":
      return "Angerufener";
    default:
      return speaker || "—";
  }
}

export default define({
  tag: "request-detail-view",
  requestId: "",
  loading: true,
  error: "",
  request: undefined,
  render: {
    value: ({ loading, error, request: r }) => {
      if (loading) {
        return html`
          <div class="head">
            <glk-button size="sm" variant="tertiary" onclick="${(host) => navigate(host, "requests")}">← Zurück</glk-button>
            <glk-title style="font-size:18px">Anruf</glk-title>
          </div>
          <glk-status message="Lädt …"></glk-status>
        `;
      }
      if (error || !r) {
        return html`
          <div class="head">
            <glk-button size="sm" variant="tertiary" onclick="${(host) => navigate(host, "requests")}">← Zurück</glk-button>
            <glk-title style="font-size:18px">Anruf</glk-title>
          </div>
          <glk-status message="${error || "Nicht gefunden."}"></glk-status>
        `;
      }

      const hasRecording = !!(r.recording && r.recording.gridFsId);
      // Primär: Anruflänge (startedAt→endedAt) aus durationSec, Fallback recording.
      const callSec = callDurationSec(r);
      // Sekundär: reine Medien-/Aufnahmelänge (für separate Kleinanzeige).
      // 0 gilt NICHT als gültige Länge (Schema-Default alter Anrufe) → Zeile entfällt.
      const mediaSec =
        r.recording && typeof r.recording.durationSec === "number" && r.recording.durationSec > 0
          ? r.recording.durationSec
          : undefined;
      const transcript = r.transcript || [];
      const calls = r.functionCalls || [];
      const m = r.metrics || {};

      return html`
        <div class="head">
          <glk-button size="sm" variant="tertiary" onclick="${(host) => navigate(host, "requests")}">← Zurück</glk-button>
          <glk-title style="font-size:18px">${callLabel(r)}</glk-title>
        </div>

        <div class="badges">
          <glk-badge variant="${statusVariant(r.status)}">${statusLabel(r.status)}</glk-badge>
          <glk-badge variant="${r.mode === "passthrough" ? "primary" : "success"}">${modeLabel(r.mode)}</glk-badge>
          ${r.language && html`<glk-badge>${r.language}</glk-badge>`}
          ${callSec !== undefined ? html`<glk-badge>${fmtDuration(callSec)}</glk-badge>` : ""}
          ${r.forwardedTo && html`<glk-badge variant="primary">→ ${r.forwardedTo}</glk-badge>`}
          ${typeof m.timeToFirstAudioMs === "number"
            ? html`<glk-badge>Erste Antwort ${fmtSecondsFromMs(m.timeToFirstAudioMs)}</glk-badge>`
            : ""}
          ${m.bargeIns > 0
            ? html`<glk-badge>${m.bargeIns} Barge-in${m.bargeIns === 1 ? "" : "s"}</glk-badge>`
            : ""}
          ${m.toolCalls > 0
            ? html`<glk-badge variant="${m.toolErrors > 0 ? "error" : ""}">
                ${m.toolCalls} Tool${m.toolCalls === 1 ? "" : "s"}${m.toolErrors > 0 ? ` (${m.toolErrors} Fehler)` : ""}
              </glk-badge>`
            : ""}
        </div>

        ${hasRecording &&
        html`
          <glk-card>
            <audio controls preload="none" style="width:100%" src="${api.recordingUrl(r._id)}"></audio>
            ${mediaSec !== undefined
              ? html`<div class="media-len">Aufnahmelänge: ${fmtDuration(mediaSec)}</div>`
              : ""}
          </glk-card>
        `}

        <div class="section">Transkript</div>
        ${transcript.length === 0
          ? html`<glk-status message="Kein Transkript vorhanden."></glk-status>`
          : html`
              <div class="chat">
                ${transcript.map(
                  (turn) => html`
                    <div class="bubble ${isLeft(turn.speaker) ? "left" : "right"}">
                      <div class="who">${speakerLabel(turn.speaker)} · ${fmtDuration(turn.t)}</div>
                      ${turn.text}
                    </div>
                  `,
                )}
              </div>
            `}

        ${r.summary && (r.summary.text || r.summary.status)
          ? html`
              <div class="section">Zusammenfassung</div>
              ${r.summary.text
                ? html`<glk-card glow><p style="margin:0">${r.summary.text}</p></glk-card>`
                : html`<glk-status message="${`Summary: ${r.summary.status}`}"></glk-status>`}
            `
          : ""}

        ${calls.length > 0
          ? html`
              <div class="section">Funktionsaufrufe</div>
              <glk-list>
                ${calls.map(
                  (c) => html`
                    <glk-list-item
                      title="${c.name}"
                      subtitle="${c.arguments ? JSON.stringify(c.arguments) : ""}"
                    >
                      <span slot="trailing">
                        <glk-badge variant="${c.status === "error" ? "error" : "success"}">${c.status || "—"}</glk-badge>
                      </span>
                    </glk-list-item>
                  `,
                )}
              </glk-list>
            `
          : ""}
      `.css`
        .head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
        .badges { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
        .section {
          text-transform: uppercase; letter-spacing: .06em; font-size: 12px;
          color: var(--gl-color-text-muted); font-weight: 600; margin: 18px 0 10px;
        }
        .chat { display: flex; flex-direction: column; gap: 10px; }
        .bubble {
          max-width: 82%;
          padding: 10px 14px;
          border-radius: var(--gl-radius-input);
          background: var(--gl-surface-2);
          border: 1px solid var(--gl-border-subtle);
          color: var(--gl-color-text);
          font-size: var(--gl-font-size-base);
        }
        .bubble.left { align-self: flex-start; }
        .bubble.right { align-self: flex-end; background: var(--gl-surface-3); }
        .who { font-size: 11px; color: var(--gl-color-text-muted); margin-bottom: 2px; }
        glk-card { display: block; margin-bottom: 4px; }
        .media-len { margin-top: 8px; font-size: 12px; color: var(--gl-color-text-muted); }
      `;
    },
    connect: (host) => {
      load(host);
      // Laufender Anruf: Transkript/Status alle 2 s still aktualisieren; sobald der
      // Anruf einen Terminal-Status hat, endet das Polling (sichtbar im Netzwerk-Tab).
      const timer = setInterval(() => {
        const r = host.request;
        if (host.loading || !r) return;
        if (r.status !== "in_progress") {
          clearInterval(timer);
          return;
        }
        silentReload(host);
      }, 2000);
      return () => clearInterval(timer);
    },
  },
});
