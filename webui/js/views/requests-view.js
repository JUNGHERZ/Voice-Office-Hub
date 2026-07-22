/*
 * Anrufe-Liste: paginiert (limit/skip), Filter nach Modus. Klick → Detail.
 */
import { define, html } from "hybrids";

import { api } from "../api.js";
import { callLabel, fmtCallDuration, fmtDateTime, statusLabel, statusVariant } from "../format.js";
import { callIcon } from "../icons.js";

const PAGE = 15;

function navigate(host, view, id) {
  host.dispatchEvent(
    new CustomEvent("navigate", { detail: { view, id }, bubbles: true, composed: true }),
  );
}

async function load(host) {
  host.loading = true;
  host.error = "";
  try {
    const res = await api.listRequests({
      limit: PAGE,
      skip: host.skip,
      mode: host.mode || undefined,
    });
    host.items = res.items || [];
    host.total = res.total || 0;
  } catch (e) {
    host.error = "Anrufe konnten nicht geladen werden.";
  } finally {
    host.loading = false;
  }
}

function setMode(host, mode) {
  host.mode = mode;
  host.skip = 0;
  load(host);
}

function page(host, delta) {
  const next = host.skip + delta * PAGE;
  if (next < 0 || next >= host.total) return;
  host.skip = next;
  load(host);
}

export default define({
  tag: "requests-view",
  loading: false,
  error: "",
  mode: "",
  skip: 0,
  total: 0,
  items: undefined,
  render: {
    value: ({ loading, error, mode, skip, total, items }) => {
      const from = total === 0 ? 0 : skip + 1;
      const to = Math.min(skip + PAGE, total);
      return html`
        <div class="head">
          <glk-title style="font-size:22px">Anrufe</glk-title>
          <div class="filters">
            <glk-badge
              variant="${mode === "" ? "primary" : ""}"
              onclick="${(host) => setMode(host, "")}"
              style="cursor:pointer"
            >Alle</glk-badge>
            <glk-badge
              variant="${mode === "agent" ? "primary" : ""}"
              onclick="${(host) => setMode(host, "agent")}"
              style="cursor:pointer"
            >Agent</glk-badge>
            <glk-badge
              variant="${mode === "passthrough" ? "primary" : ""}"
              onclick="${(host) => setMode(host, "passthrough")}"
              style="cursor:pointer"
            >Passthrough</glk-badge>
          </div>
        </div>

        ${error && html`<glk-status message="${error}"></glk-status>`}
        ${loading
          ? html`<glk-status message="Lädt …"></glk-status>`
          : html`
              <glk-list>
                ${(items || []).map(
                  (r) => html`
                    <glk-list-item
                      interactive
                      title="${callLabel(r)}"
                      subtitle="${`${fmtDateTime(r.startedAt)} · ${fmtCallDuration(r)}`}"
                      onglk-click="${(host) => navigate(host, "request", r._id)}"
                    >
                      <span slot="leading">${callIcon(r)}</span>
                      <span slot="trailing" class="trail">
                        ${r.recording && r.recording.gridFsId
                          ? html`<span class="hp">🎧</span>`
                          : ""}
                        <glk-badge variant="${statusVariant(r.status)}">${statusLabel(r.status)}</glk-badge>
                      </span>
                    </glk-list-item>
                  `,
                )}
              </glk-list>

              <div class="pager">
                <glk-button size="sm" variant="tertiary" onclick="${(host) => page(host, -1)}">
                  ← Zurück
                </glk-button>
                <span class="count">${from}–${to} von ${total}</span>
                <glk-button size="sm" variant="tertiary" onclick="${(host) => page(host, 1)}">
                  Weiter →
                </glk-button>
              </div>
            `}
      `.css`
        .head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; flex-wrap: wrap; margin-bottom: 14px;
        }
        .filters { display: flex; gap: 6px; }
        .trail { display: inline-flex; align-items: center; gap: 8px; }
        /* GlassKit-Falle: Shadow-CSS erreicht Slot-Inhalte nicht — Icon-Größe hier setzen. */
        span[slot="leading"] { display: flex; align-items: center; justify-content: center; }
        span[slot="leading"] svg { width: 24px; height: 24px; }
        .pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; }
        .count { font-size: 13px; color: var(--gl-color-text-muted); }
      `;
    },
    connect: (host) => {
      load(host);
    },
  },
});
