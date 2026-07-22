/*
 * Agents-Liste: Leading-Icon (Modus), Name, DDI(s), Modus-Badge. Klick → Bearbeiten.
 * "+ Neuer Agent". Icons wie im ursprünglichen Mockup (Headset/Transfer-Pfeile).
 */
import { define, html } from "hybrids";

import { api } from "../api.js";
import { modeLabel } from "../format.js";
import { ICON_AGENT, ICON_PASSTHROUGH } from "../icons.js";

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

// TTS-Beschriftung der Zeile: bei ElevenLabs nie das (dort bedeutungslose)
// Aura-Modell zeigen — entweder das explizite ElevenLabs-Modell oder "ElevenLabs".
function voiceLabel(a) {
  if (a.mode === "passthrough") return `leitet an ${a.passthroughTarget || "?"}`;
  const speak = a.speak || {};
  if (speak.provider === "eleven_labs") {
    const m = speak.model && speak.model.indexOf("aura") !== 0 ? speak.model : "";
    return m || "ElevenLabs";
  }
  return speak.model || "";
}

function ddiLabel(a) {
  const ddis = (a.targetNumbers || []).join(", ") || "—";
  const voice = voiceLabel(a);
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
                    <span slot="leading">
                      ${a.mode === "passthrough" ? ICON_PASSTHROUGH : ICON_AGENT}
                    </span>
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
      /* GlassKits ".glass-list__leading svg"-Regel erreicht geslottete Inhalte nicht
         (Shadow-Grenze) — Größe deshalb hier setzen, sonst kollabiert das SVG auf 0×0. */
      span[slot="leading"] { display: flex; align-items: center; justify-content: center; }
      span[slot="leading"] svg { width: 24px; height: 24px; }
    `,
    connect: (host) => {
      load(host);
    },
  },
});
