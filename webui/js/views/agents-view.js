/*
 * Agents-Liste: Name, DDI(s), Modus-Badge. Klick → Bearbeiten. "+ Neuer Agent".
 */
import { define, html } from "hybrids";

import { api } from "../api.js";
import { modeLabel } from "../format.js";

function navigate(host, view, id) {
  host.dispatchEvent(
    new CustomEvent("navigate", { detail: { view, id }, bubbles: true, composed: true }),
  );
}

async function load(host) {
  host.loading = true;
  host.error = "";
  try {
    const res = await api.listAgents();
    host.agents = res.agents || [];
  } catch (e) {
    host.error = "Agents konnten nicht geladen werden.";
  } finally {
    host.loading = false;
  }
}

function ddiLabel(a) {
  const ddis = (a.targetNumbers || []).join(", ") || "—";
  const voice = a.mode === "passthrough" ? `leitet an ${a.passthroughTarget || "?"}` : a.speak?.model || "";
  return voice ? `DDI ${ddis} · ${voice}` : `DDI ${ddis}`;
}

export default define({
  tag: "agents-view",
  loading: false,
  error: "",
  agents: undefined,
  render: {
    value: ({ loading, error, agents }) => html`
      <div class="head">
        <glk-title style="font-size:22px">Agents</glk-title>
        <glk-button
          variant="primary"
          size="sm"
          onclick="${(host) => navigate(host, "agent-new")}"
        >+ Neuer Agent</glk-button>
      </div>

      ${error && html`<glk-status message="${error}"></glk-status>`}
      ${loading
        ? html`<glk-status message="Lädt …"></glk-status>`
        : html`
            <glk-list>
              ${(agents || []).map(
                (a) => html`
                  <glk-list-item
                    interactive
                    title="${a.name}${a.enabled ? "" : " (inaktiv)"}"
                    subtitle="${ddiLabel(a)}"
                    onglk-click="${(host) => navigate(host, "agent", a._id)}"
                  >
                    <span slot="trailing">
                      <glk-badge variant="${a.mode === "passthrough" ? "primary" : "success"}">
                        ${modeLabel(a.mode)}
                      </glk-badge>
                    </span>
                  </glk-list-item>
                `,
              )}
            </glk-list>
          `}
    `.css`
      .head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; margin-bottom: 14px;
      }
    `,
    connect: (host) => {
      load(host);
    },
  },
});
