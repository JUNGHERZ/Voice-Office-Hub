/*
 * Agent-Formular (Anlegen/Bearbeiten). Felder: name, targetNumbers (Komma→Array),
 * mode, language, greeting, prompt, speak.model, summary.enabled, enabled.
 * Speichern → POST/PATCH, Löschen → Bestätigung via <glk-modal>.
 *
 * Attribut "agent-id" steuert den Modus: leer = neu, gesetzt = bearbeiten.
 */
import { define, html } from "hybrids";

import { api } from "../api.js";

function navigate(host, view, id) {
  host.dispatchEvent(
    new CustomEvent("navigate", { detail: { view, id }, bubbles: true, composed: true }),
  );
}

// Leeres Formularmodell (Defaults wie im Mongoose-Schema).
function emptyForm() {
  return {
    name: "",
    targetNumbers: "",
    mode: "agent",
    passthroughTarget: "",
    language: "",
    greeting: "",
    prompt: "",
    speakModel: "",
    tools: "transfer_call, end_call",
    useTransferCallerId: false,
    summaryEnabled: false,
    enabled: true,
  };
}

// API-Agent → Formularmodell.
function toForm(a) {
  return {
    name: a.name || "",
    targetNumbers: (a.targetNumbers || []).join(", "),
    mode: a.mode || "agent",
    passthroughTarget: a.passthroughTarget || "",
    language: a.language || "",
    greeting: a.greeting || "",
    prompt: a.prompt || "",
    speakModel: (a.speak && a.speak.model) || "",
    tools: (a.tools && a.tools.length ? a.tools : ["transfer_call", "end_call"]).join(", "),
    useTransferCallerId: !!a.useTransferCallerId,
    summaryEnabled: !!(a.summary && a.summary.enabled),
    enabled: a.enabled !== false,
  };
}

// Formularmodell → API-Body.
function toBody(f) {
  return {
    name: f.name.trim(),
    targetNumbers: f.targetNumbers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    mode: f.mode,
    // passthroughTarget nur im passthrough-Modus mitsenden.
    passthroughTarget: f.mode === "passthrough" ? f.passthroughTarget.trim() || undefined : undefined,
    language: f.language.trim() || undefined,
    greeting: f.greeting,
    prompt: f.prompt,
    speak: { model: f.speakModel.trim() || undefined },
    tools: f.tools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    useTransferCallerId: f.useTransferCallerId,
    summary: { enabled: f.summaryEnabled },
    enabled: f.enabled,
  };
}

async function load(host) {
  host.error = "";
  if (!host.agentId) {
    host.form = emptyForm();
    host.loading = false;
    return;
  }
  host.loading = true;
  try {
    const res = await api.getAgent(host.agentId);
    host.form = toForm(res.agent);
  } catch (e) {
    host.error = "Agent konnte nicht geladen werden.";
    host.form = emptyForm();
  } finally {
    host.loading = false;
  }
}

// Feld-Setter: erzeugt eine neue Form-Kopie (Hybrids erkennt so die Änderung).
function setField(host, key, value) {
  host.form = { ...host.form, [key]: value };
}

async function save(host) {
  if (host.busy) return;
  host.error = "";
  if (!host.form.name.trim()) {
    host.error = "Name ist erforderlich.";
    return;
  }
  host.busy = true;
  try {
    const body = toBody(host.form);
    if (host.agentId) {
      await api.updateAgent(host.agentId, body);
    } else {
      await api.createAgent(body);
    }
    navigate(host, "agents");
  } catch (e) {
    host.error = e && e.message ? `Speichern fehlgeschlagen: ${e.message}` : "Speichern fehlgeschlagen.";
  } finally {
    host.busy = false;
  }
}

async function confirmDelete(host) {
  host.confirmOpen = false;
  if (!host.agentId) return;
  host.busy = true;
  try {
    await api.deleteAgent(host.agentId);
    navigate(host, "agents");
  } catch (e) {
    host.error = "Löschen fehlgeschlagen.";
  } finally {
    host.busy = false;
  }
}

export default define({
  tag: "agent-form-view",
  agentId: "",
  loading: true,
  busy: false,
  error: "",
  confirmOpen: false,
  form: undefined,
  render: {
    value: ({ agentId, loading, busy, error, confirmOpen, form }) => {
      const f = form || emptyForm();
      const title = agentId ? f.name || "Agent" : "Neuer Agent";
      return html`
        <div class="head">
          <glk-button size="sm" variant="tertiary" onclick="${(host) => navigate(host, "agents")}">
            ← Zurück
          </glk-button>
          <glk-title style="font-size:20px">${title}</glk-title>
        </div>

        ${error && html`<glk-status message="${error}"></glk-status>`}

        ${loading
          ? html`<glk-status message="Lädt …"></glk-status>`
          : html`
              <div class="form">
                <glk-input
                  label="Name"
                  value="${f.name}"
                  onglk-input="${(host, e) => setField(host, "name", e.detail.value)}"
                ></glk-input>

                <glk-input
                  label="Zielrufnummern (DDI)"
                  value="${f.targetNumbers}"
                  hint="Komma-getrennt; in Prod E.164 (+49…)"
                  onglk-input="${(host, e) => setField(host, "targetNumbers", e.detail.value)}"
                ></glk-input>

                <glk-select
                  id="modeSelect"
                  label="Modus"
                  onglk-change="${(host, e) => setField(host, "mode", e.detail.value)}"
                >
                  <option value="agent">agent</option>
                  <option value="passthrough">passthrough</option>
                </glk-select>

                ${f.mode === "passthrough" &&
                html`
                  <glk-input
                    label="Zielrufnummer (Passthrough)"
                    value="${f.passthroughTarget}"
                    placeholder="z. B. 101 oder +49…"
                    onglk-input="${(host, e) => setField(host, "passthroughTarget", e.detail.value)}"
                  ></glk-input>
                `}

                <glk-input
                  label="Sprache"
                  value="${f.language}"
                  placeholder="z. B. de, en, multi"
                  onglk-input="${(host, e) => setField(host, "language", e.detail.value)}"
                ></glk-input>

                <glk-input
                  label="Begrüßung"
                  value="${f.greeting}"
                  onglk-input="${(host, e) => setField(host, "greeting", e.detail.value)}"
                ></glk-input>

                <glk-textarea
                  label="System-Prompt"
                  rows="4"
                  value="${f.prompt}"
                  onglk-input="${(host, e) => setField(host, "prompt", e.detail.value)}"
                ></glk-textarea>

                <glk-input
                  label="TTS-Modell (speak.model)"
                  value="${f.speakModel}"
                  placeholder="z. B. aura-2-thalia-en"
                  onglk-input="${(host, e) => setField(host, "speakModel", e.detail.value)}"
                ></glk-input>

                <glk-input
                  label="Tools (Komma-getrennt)"
                  value="${f.tools}"
                  placeholder="transfer_call, end_call"
                  onglk-input="${(host, e) => setField(host, "tools", e.detail.value)}"
                ></glk-input>

                <glk-toggle
                  label="Anrufer-Nr. bei externem Transfer (CLIP no screening)"
                  checked="${f.useTransferCallerId}"
                  onglk-change="${(host, e) => setField(host, "useTransferCallerId", e.detail.checked)}"
                ></glk-toggle>

                <glk-toggle
                  label="Post-Call-Summary"
                  checked="${f.summaryEnabled}"
                  onglk-change="${(host, e) => setField(host, "summaryEnabled", e.detail.checked)}"
                ></glk-toggle>

                <glk-toggle
                  label="Aktiv"
                  checked="${f.enabled}"
                  onglk-change="${(host, e) => setField(host, "enabled", e.detail.checked)}"
                ></glk-toggle>

                <glk-divider></glk-divider>

                <glk-button variant="primary" onclick="${save}">
                  ${busy ? "Speichern …" : "Speichern"}
                </glk-button>
                ${agentId &&
                html`
                  <glk-button
                    variant="tertiary"
                    onclick="${(host) => {
                      host.confirmOpen = true;
                    }}"
                  >Löschen</glk-button>
                `}
              </div>

              <glk-modal
                title="Agent löschen?"
                open="${confirmOpen}"
                onglk-close="${(host) => {
                  host.confirmOpen = false;
                }}"
              >
                <p>Dieser Agent wird dauerhaft gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.</p>
                <div slot="actions">
                  <button
                    class="glass-modal__action"
                    onclick="${(host) => {
                      host.confirmOpen = false;
                    }}"
                  >Abbrechen</button>
                  <button class="glass-modal__action glass-modal__action--danger" onclick="${confirmDelete}">
                    Löschen
                  </button>
                </div>
              </glk-modal>
            `}
      `.css`
        .head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
        .form { display: flex; flex-direction: column; gap: 14px; }
      `;
    },
    // Nach jedem Render den Modus-Select imperativ auf den echten State setzen.
    // Grund: glk-select klont seine <option>s per rAF und übernimmt nur das
    // value-ATTRIBUT (nicht die von Hybrids gesetzte selected-Property), daher
    // greift weder option[selected] noch das value-Property zuverlässig.
    observe: (host) => {
      if (!host.form) return;
      const sel = host.shadowRoot && host.shadowRoot.getElementById("modeSelect");
      if (sel) {
        // Attribut → glk-select.onAttributeChanged('value') wendet es an;
        // wird auch von der initialen rAF-Option-Übernahme gelesen.
        sel.setAttribute("value", host.form.mode);
      }
    },
    connect: (host) => {
      load(host);
    },
  },
});
