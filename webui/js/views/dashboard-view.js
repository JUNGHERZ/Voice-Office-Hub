/*
 * Dashboard: Stat-Cards (Anrufe gesamt, Agents, Anrufe mit Aufnahme) +
 * "Letzte Anrufe"-Liste (limit=8). Klick auf einen Anruf → Detail.
 */
import { define, html } from "hybrids";

import { api } from "../api.js";
import { callLabel, fmtCallDuration, fmtTime, modeLabel, statusVariant } from "../format.js";

function navigate(host, view, id) {
  host.dispatchEvent(
    new CustomEvent("navigate", { detail: { view, id }, bubbles: true, composed: true }),
  );
}

async function load(host) {
  host.loading = true;
  host.error = "";
  try {
    // Ein größerer Pull liefert sowohl total als auch die Aufnahmen-Zählung.
    const [agentsRes, allRes] = await Promise.all([
      api.listAgents(),
      api.listRequests({ limit: 200 }),
    ]);
    host.agentCount = (agentsRes.agents || []).length;
    host.callTotal = allRes.total ?? (allRes.items || []).length;
    host.recent = (allRes.items || []).slice(0, 8);
    host.recordedCount = (allRes.items || []).filter(
      (r) => r.recording && r.recording.gridFsId,
    ).length;
  } catch (e) {
    host.error = "Daten konnten nicht geladen werden.";
  } finally {
    host.loading = false;
  }
}

export default define({
  tag: "dashboard-view",
  loading: false,
  error: "",
  agentCount: 0,
  callTotal: 0,
  recordedCount: 0,
  recent: undefined,
  render: {
    value: ({ loading, error, agentCount, callTotal, recordedCount, recent }) => html`
      <glk-title>Dashboard</glk-title>

      ${error && html`<glk-status message="${error}"></glk-status>`}

      <div class="stat-grid">
        <glk-card class="card" onclick="${(host) => navigate(host, "requests")}">
          <div class="stat"><div class="num">${callTotal}</div><div class="lbl">Anrufe</div></div>
        </glk-card>
        <glk-card class="card" onclick="${(host) => navigate(host, "agents")}">
          <div class="stat"><div class="num">${agentCount}</div><div class="lbl">Agents</div></div>
        </glk-card>
        <glk-card class="card" onclick="${(host) => navigate(host, "requests")}">
          <div class="stat"><div class="num">${recordedCount}</div><div class="lbl">Aufnahmen</div></div>
        </glk-card>
      </div>

      <div class="section">Letzte Anrufe</div>
      ${loading
        ? html`<glk-status message="Lädt …"></glk-status>`
        : html`
            <glk-list>
              ${(recent || []).map(
                (r) => html`
                  <glk-list-item
                    interactive
                    title="${callLabel(r)}"
                    subtitle="${`${fmtTime(r.startedAt)} · ${fmtCallDuration(r)}`}"
                    onglk-click="${(host) => navigate(host, "request", r._id)}"
                  >
                    <span slot="trailing">
                      <glk-badge variant="${statusVariant(r.status)}">${modeLabel(r.mode)}</glk-badge>
                    </span>
                  </glk-list-item>
                `,
              )}
              <glk-list-item
                center
                interactive
                variant="accent"
                title="Alle Anrufe anzeigen"
                onglk-click="${(host) => navigate(host, "requests")}"
              ></glk-list-item>
            </glk-list>
          `}
    `.css`
      .stat-grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin: 16px 0; }
      @media (min-width: 520px) { .stat-grid { grid-template-columns: repeat(3, 1fr); } }
      .card {
        cursor: pointer;
        transition: transform .12s ease, filter .12s ease;
      }
      .card:hover { transform: translateY(-2px); filter: brightness(1.08); }
      .card:active { transform: translateY(0); }
      .stat { text-align: center; }
      .num { font-size: 28px; font-weight: 700; color: var(--gl-color-text-heading); }
      .lbl { font-size: 13px; color: var(--gl-color-text-muted); }
      .section {
        text-transform: uppercase; letter-spacing: .06em; font-size: 12px;
        color: var(--gl-color-text-muted); font-weight: 600; margin: 18px 0 10px;
      }
    `,
    connect: (host) => {
      load(host);
    },
  },
});
