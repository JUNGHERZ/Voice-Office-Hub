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

// Kurzname je TTS-Provider für die Zeilenbeschriftung. Deepgram-Aura zeigt nur
// das Modell (es IST die Stimme); alle übrigen führen den Providernamen mit,
// damit ein Modellwechsel nicht wie ein anderer Anbieter aussieht.
const PROVIDER_SHORT = {
  deepgram_flux: "Flux TTS",
  eleven_labs: "ElevenLabs",
  mistral: "Voxtral",
  speechify: "Speechify",
  fish_audio: "Fish Audio",
};

function voiceLabel(a) {
  if (a.mode === "passthrough") return `leitet an ${a.passthroughTarget || "?"}`;
  const speak = a.speak || {};
  const short = PROVIDER_SHORT[speak.provider];
  if (!short) return speak.model || ""; // Deepgram Aura: Modell = Stimme
  // Die Stimme sagt mehr als die Modell-ID, wo es beides gibt.
  const detail = speak.voice || speak.model || "";
  return detail ? `${short} · ${detail}` : short;
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
