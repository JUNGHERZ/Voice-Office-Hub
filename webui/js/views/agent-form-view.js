/*
 * Agent-Formular (Anlegen/Bearbeiten). Felder: name, targetNumbers (Komma→Array),
 * mode, voiceProvider, language, listen.model (nova-3/flux + eot-Felder), greeting,
 * prompt, speak.model, Tools (Built-in-Toggles + Custom-HTTP-Tools mit Modal-Editor),
 * summary.enabled, enabled. Speichern → POST/PATCH, Löschen → Bestätigung via <glk-modal>.
 *
 * Wichtig: PATCH ersetzt Subdokumente komplett ($set) — deshalb tragen _listen/_speak
 * das geladene Original-Subobjekt mit und toBody() schreibt es vollständig zurück
 * (sonst verlöre jeder UI-Save z. B. listen.keyterms oder speak.voice).
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

// Kurzlabels für die Built-in-Toggles (Fallback: erster Satz der Registry-Beschreibung).
const TOOL_LABELS = {
  transfer_call: "Weiterleitung an Mensch/Durchwahl",
  end_call: "Gespräch selbst beenden (auflegen)",
  get_weather: "Wetter-Demo",
};

function toolLabel(b) {
  const short = TOOL_LABELS[b.name] || (b.description || "").split(". ")[0].slice(0, 70);
  return short ? `${b.name} · ${short}` : b.name;
}

// Fallback, falls /api/tools nicht erreichbar ist (Formular bleibt benutzbar).
const FALLBACK_BUILTINS = [
  { name: "transfer_call", description: "" },
  { name: "end_call", description: "" },
  { name: "get_weather", description: "" },
];

// Fallback, falls /api/ambience nicht erreichbar ist (Labels wie im Server-Manifest).
const FALLBACK_AMBIENCE = [
  { id: "office", label: "Büroatmosphäre (Raumklang + Tippen)" },
  { id: "room", label: "Neutraler Raumklang" },
  { id: "rain", label: "Regen" },
];

// Leeres Formularmodell (Defaults wie im Mongoose-Schema).
function emptyForm() {
  return {
    name: "",
    targetNumbers: "",
    mode: "agent",
    voiceProvider: "deepgram",
    passthroughTarget: "",
    language: "",
    listenModel: "nova-3",
    eotThreshold: "",
    eotTimeoutMs: "",
    greeting: "",
    prompt: "",
    speakProvider: "deepgram",
    speakModel: "",
    // Getrenntes Modellfeld je Provider: beim Umschalten geht kein Wert verloren.
    speakModelEleven: "",
    speakVoice: "",
    // ElevenLabs voice_settings (leer = Voice-Default aus dem Dashboard).
    speakStability: "",
    speakSimilarity: "",
    speakSpeed: "",
    ambienceEnabled: false,
    ambiencePreset: "office",
    ambienceVolume: "25",
    widgetEnabled: false,
    widgetOrigins: "",
    widgetShowTranscript: true,
    tools: ["transfer_call", "end_call"],
    customTools: [],
    mcpServers: [],
    useTransferCallerId: false,
    summaryEnabled: false,
    enabled: true,
    // Carry-along: komplette Subdokumente des geladenen Agents (siehe Kopfkommentar).
    _listen: {},
    _speak: {},
    _ambience: {},
    _widget: {},
  };
}

// API-Agent → Formularmodell.
function toForm(a) {
  const listen = a.listen || {};
  const ambience = a.ambience || {};
  const widget = a.widget || {};
  return {
    name: a.name || "",
    targetNumbers: (a.targetNumbers || []).join(", "),
    mode: a.mode || "agent",
    voiceProvider: a.voiceProvider || "deepgram",
    passthroughTarget: a.passthroughTarget || "",
    language: a.language || "",
    listenModel: listen.model || "nova-3",
    // != null, damit ein gespeicherter 0-Wert erhalten bleibt.
    eotThreshold: listen.eot_threshold != null ? String(listen.eot_threshold) : "",
    eotTimeoutMs: listen.eot_timeout_ms != null ? String(listen.eot_timeout_ms) : "",
    greeting: a.greeting || "",
    prompt: a.prompt || "",
    speakProvider: (a.speak && a.speak.provider) || "deepgram",
    // Gespeichertes Modell dem passenden Provider-Feld zuordnen (Aura-Werte gehören
    // nie ins ElevenLabs-Feld — dort gilt sonst der Server-Default eleven_turbo_v2_5).
    speakModel:
      (a.speak && a.speak.provider) === "eleven_labs" ? "" : (a.speak && a.speak.model) || "",
    speakModelEleven:
      (a.speak && a.speak.provider) === "eleven_labs" &&
      a.speak.model &&
      a.speak.model.indexOf("aura") !== 0
        ? a.speak.model
        : "",
    speakVoice: (a.speak && a.speak.voice) || "",
    speakStability: a.speak && a.speak.stability != null ? String(a.speak.stability) : "",
    speakSimilarity: a.speak && a.speak.similarityBoost != null ? String(a.speak.similarityBoost) : "",
    speakSpeed: a.speak && a.speak.speed != null ? String(a.speak.speed) : "",
    ambienceEnabled: !!ambience.enabled,
    ambiencePreset: ambience.preset || "office",
    ambienceVolume: String(Math.round((ambience.volume != null ? ambience.volume : 0.25) * 100)),
    widgetEnabled: !!widget.enabled,
    widgetOrigins: (widget.allowedOrigins || []).join("\n"),
    widgetShowTranscript: widget.showTranscript !== false,
    tools: a.tools && a.tools.length ? [...a.tools] : ["transfer_call", "end_call"],
    customTools: (a.customTools || []).map((t) => ({ ...t, endpoint: { ...(t.endpoint || {}) } })),
    mcpServers: (a.mcpServers || []).map((s) => ({ ...s })),
    useTransferCallerId: !!a.useTransferCallerId,
    summaryEnabled: !!(a.summary && a.summary.enabled),
    enabled: a.enabled !== false,
    _listen: { ...listen },
    _speak: { ...(a.speak || {}) },
    _ambience: { ...ambience },
    _widget: { ...widget },
  };
}

function isFluxModel(model) {
  return typeof model === "string" && model.indexOf("flux") === 0;
}

// Formularmodell → API-Body.
function toBody(f) {
  const isFlux = isFluxModel(f.listenModel);
  const num = (v) => (v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    name: f.name.trim(),
    targetNumbers: f.targetNumbers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    mode: f.mode,
    voiceProvider: f.voiceProvider,
    // passthroughTarget nur im passthrough-Modus mitsenden.
    passthroughTarget: f.mode === "passthrough" ? f.passthroughTarget.trim() || undefined : undefined,
    language: f.language.trim() || undefined,
    greeting: f.greeting,
    prompt: f.prompt,
    // Subdokumente vollständig zurückschreiben (Merge über _listen/_speak); eot_* nur bei
    // Flux — undefined lässt JSON.stringify die Keys fallen (Rückwechsel auf nova-3 räumt auf).
    listen: {
      ...f._listen,
      model: f.listenModel,
      eot_threshold: isFlux ? num(f.eotThreshold) : undefined,
      eot_timeout_ms: isFlux ? num(f.eotTimeoutMs) : undefined,
    },
    speak: {
      ...f._speak,
      provider: f.speakProvider,
      model:
        (f.speakProvider === "eleven_labs" ? f.speakModelEleven.trim() : f.speakModel.trim()) ||
        undefined,
      voice: f.speakVoice.trim() || undefined,
      // voice_settings: leeres Feld löscht den Wert (→ Voice-Default); Komma als
      // Dezimaltrenner zulassen ("0,5").
      stability: num(String(f.speakStability).replace(",", ".")),
      similarityBoost: num(String(f.speakSimilarity).replace(",", ".")),
      speed: num(String(f.speakSpeed).replace(",", ".")),
    },
    tools: f.tools,
    customTools: f.customTools,
    mcpServers: f.mcpServers,
    useTransferCallerId: f.useTransferCallerId,
    summary: { enabled: f.summaryEnabled },
    ambience: {
      ...f._ambience,
      enabled: f.ambienceEnabled,
      preset: f.ambiencePreset,
      volume: Math.max(0, Math.min(1, Number(f.ambienceVolume) / 100 || 0)),
    },
    // widget.key UND widget.exten werden server-seitig verwaltet (exten kommt
    // per Carry-along mit; beim ersten Aktivieren vergibt sie der Server).
    widget: {
      ...f._widget,
      enabled: f.widgetEnabled,
      allowedOrigins: f.widgetOrigins
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      showTranscript: f.widgetShowTranscript,
    },
    enabled: f.enabled,
  };
}

async function load(host) {
  host.error = "";
  host.loading = true;
  try {
    const res = await api.listTools();
    host.builtins = (res && res.builtin) || FALLBACK_BUILTINS;
  } catch (e) {
    host.builtins = FALLBACK_BUILTINS;
  }
  try {
    const res = await api.listAmbiencePresets();
    host.ambiencePresets = (res && res.presets) || FALLBACK_AMBIENCE;
  } catch (e) {
    host.ambiencePresets = FALLBACK_AMBIENCE;
  }
  if (!host.agentId) {
    host.form = emptyForm();
    host.loading = false;
    return;
  }
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

function toggleBuiltinTool(host, name, checked) {
  const current = new Set(host.form.tools);
  if (checked) current.add(name);
  else current.delete(name);
  setField(host, "tools", [...current]);
}

// ── Custom-Tool-Editor (Modal) ──────────────────────────────────────────────

function emptyToolDraft() {
  return {
    name: "",
    description: "",
    url: "",
    method: "POST",
    timeoutMs: "8000",
    enabled: true,
    parametersText: '{\n  "type": "object",\n  "properties": {}\n}',
    headers: [], // [{k, v}] — Werte dürfen ${ENV:NAME}-Platzhalter enthalten
  };
}

function openToolEditor(host, index) {
  const t = index >= 0 ? host.form.customTools[index] : null;
  host.toolError = "";
  host.toolEditIndex = index;
  host.toolDraft = t
    ? {
        name: t.name || "",
        description: t.description || "",
        url: (t.endpoint && t.endpoint.url) || "",
        method: (t.endpoint && t.endpoint.method) || "POST",
        timeoutMs: String(t.endpoint && t.endpoint.timeoutMs != null ? t.endpoint.timeoutMs : 8000),
        enabled: t.enabled !== false,
        parametersText: JSON.stringify(t.parameters || { type: "object", properties: {} }, null, 2),
        headers: Object.entries((t.endpoint && t.endpoint.headers) || {}).map(([k, v]) => ({ k, v })),
      }
    : emptyToolDraft();
  host.toolModalOpen = true;
}

function setDraft(host, key, value) {
  host.toolDraft = { ...host.toolDraft, [key]: value };
}

function setDraftHeader(host, index, key, value) {
  const headers = host.toolDraft.headers.map((row, i) =>
    i === index ? { ...row, [key]: value } : row,
  );
  setDraft(host, "headers", headers);
}

function removeDraftHeader(host, index) {
  setDraft(host, "headers", host.toolDraft.headers.filter((_, i) => i !== index));
}

function saveToolDraft(host) {
  const d = host.toolDraft;
  const name = d.name.trim();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
    host.toolError = "Name: kleinbuchstaben_mit_unterstrichen (a–z, 0–9, _), max. 64 Zeichen.";
    return;
  }
  const builtins = host.builtins || FALLBACK_BUILTINS;
  if (builtins.some((b) => b.name === name)) {
    host.toolError = `„${name}" ist ein eingebautes Tool — bitte anderen Namen wählen.`;
    return;
  }
  const duplicate = host.form.customTools.some((t, i) => t.name === name && i !== host.toolEditIndex);
  if (duplicate) {
    host.toolError = `Es gibt bereits ein Tool „${name}".`;
    return;
  }
  if (!d.description.trim()) {
    host.toolError = "Beschreibung ist erforderlich (das LLM entscheidet danach, wann es das Tool nutzt).";
    return;
  }
  if (!/^https?:\/\//i.test(d.url.trim())) {
    host.toolError = "Endpoint-URL muss mit http:// oder https:// beginnen.";
    return;
  }
  let parameters;
  try {
    parameters = JSON.parse(d.parametersText || "{}");
  } catch (e) {
    host.toolError = `Parameters: ungültiges JSON (${e.message}).`;
    return;
  }
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    host.toolError = "Parameters muss ein JSON-Objekt (Schema) sein.";
    return;
  }
  const headers = {};
  for (const row of d.headers) {
    const k = row.k.trim();
    if (k) headers[k] = row.v;
  }
  const timeoutMs = Number(d.timeoutMs);
  const tool = {
    name,
    description: d.description.trim(),
    parameters,
    endpoint: {
      url: d.url.trim(),
      method: d.method,
      headers,
      timeoutMs: Number.isFinite(timeoutMs) ? Math.min(30000, Math.max(500, timeoutMs)) : 8000,
    },
    enabled: d.enabled,
  };
  const list = [...host.form.customTools];
  if (host.toolEditIndex >= 0) list[host.toolEditIndex] = tool;
  else list.push(tool);
  setField(host, "customTools", list);
  host.toolModalOpen = false;
}

function removeCustomTool(host) {
  if (host.toolEditIndex >= 0) {
    setField(
      host,
      "customTools",
      host.form.customTools.filter((_, i) => i !== host.toolEditIndex),
    );
  }
  host.toolModalOpen = false;
}

function customToolSubtitle(t) {
  const method = (t.endpoint && t.endpoint.method) || "POST";
  const url = (t.endpoint && t.endpoint.url) || "";
  return `${method} ${url}`;
}

// ── MCP-Server-Editor (Modal) ───────────────────────────────────────────────

function emptyMcpDraft() {
  return {
    name: "",
    url: "",
    timeoutMs: "8000",
    enabled: true,
    toolFilter: "", // Komma-getrennt; leer = alle Tools des Servers
    headers: [], // [{k, v}] — Werte dürfen ${ENV:NAME}-Platzhalter enthalten
  };
}

function openMcpEditor(host, index) {
  const s = index >= 0 ? host.form.mcpServers[index] : null;
  host.mcpError = "";
  host.mcpEditIndex = index;
  host.mcpDraft = s
    ? {
        name: s.name || "",
        url: s.url || "",
        timeoutMs: String(s.timeoutMs != null ? s.timeoutMs : 8000),
        enabled: s.enabled !== false,
        toolFilter: (s.toolFilter || []).join(", "),
        headers: Object.entries(s.headers || {}).map(([k, v]) => ({ k, v })),
      }
    : emptyMcpDraft();
  host.mcpModalOpen = true;
}

function setMcpDraft(host, key, value) {
  host.mcpDraft = { ...host.mcpDraft, [key]: value };
}

function setMcpHeader(host, index, key, value) {
  const headers = host.mcpDraft.headers.map((row, i) =>
    i === index ? { ...row, [key]: value } : row,
  );
  setMcpDraft(host, "headers", headers);
}

function removeMcpHeader(host, index) {
  setMcpDraft(host, "headers", host.mcpDraft.headers.filter((_, i) => i !== index));
}

function saveMcpDraft(host) {
  const d = host.mcpDraft;
  const name = d.name.trim();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) {
    host.mcpError = "Name: kleinbuchstaben_mit_unterstrichen (a–z, 0–9, _), max. 32 Zeichen.";
    return;
  }
  const duplicate = host.form.mcpServers.some((s, i) => s.name === name && i !== host.mcpEditIndex);
  if (duplicate) {
    host.mcpError = `Es gibt bereits einen MCP-Server „${name}".`;
    return;
  }
  if (!/^https?:\/\//i.test(d.url.trim())) {
    host.mcpError = "URL muss mit http:// oder https:// beginnen.";
    return;
  }
  const headers = {};
  for (const row of d.headers) {
    const k = row.k.trim();
    if (k) headers[k] = row.v;
  }
  const timeoutMs = Number(d.timeoutMs);
  const server = {
    name,
    url: d.url.trim(),
    headers,
    enabled: d.enabled,
    toolFilter: d.toolFilter
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.min(30000, Math.max(500, timeoutMs)) : 8000,
  };
  const list = [...host.form.mcpServers];
  if (host.mcpEditIndex >= 0) list[host.mcpEditIndex] = server;
  else list.push(server);
  setField(host, "mcpServers", list);
  host.mcpModalOpen = false;
}

function removeMcpServer(host) {
  if (host.mcpEditIndex >= 0) {
    setField(
      host,
      "mcpServers",
      host.form.mcpServers.filter((_, i) => i !== host.mcpEditIndex),
    );
  }
  host.mcpModalOpen = false;
}

function mcpSubtitle(s) {
  const filter = s.toolFilter && s.toolFilter.length ? ` · Filter: ${s.toolFilter.join(", ")}` : "";
  return `${s.url || ""}${filter}`;
}

/** Kurzfassung der ElevenLabs-voice_settings für die Zeile neben dem Modal-Button. */
function voiceSettingsSummary(f) {
  const parts = [];
  if (f.speakStability !== "") parts.push(`Stabilität ${f.speakStability}`);
  if (f.speakSimilarity !== "") parts.push(`Ähnlichkeit ${f.speakSimilarity}`);
  if (f.speakSpeed !== "") parts.push(`Tempo ${f.speakSpeed}`);
  return parts.length ? parts.join(" · ") : "Voice-Defaults aus dem ElevenLabs-Dashboard";
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

async function rotateWidgetKey(host) {
  if (!host.agentId) return;
  try {
    const res = await api.rotateWidgetKey(host.agentId);
    host.form = { ...host.form, _widget: { ...host.form._widget, key: res.key } };
  } catch (e) {
    host.error = "Key-Rotation fehlgeschlagen.";
  }
}

function copyWidgetSnippet(host) {
  const key = host.form._widget && host.form._widget.key;
  if (!key) return;
  const snippet = `<script src="${location.origin}/widget.js" data-widget-key="${key}" async></script>`;
  navigator.clipboard && navigator.clipboard.writeText(snippet);
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
  builtins: undefined,
  ambiencePresets: undefined,
  toolModalOpen: false,
  toolEditIndex: -1,
  toolDraft: undefined,
  toolError: "",
  mcpModalOpen: false,
  mcpEditIndex: -1,
  mcpDraft: undefined,
  mcpError: "",
  voiceModalOpen: false,
  render: {
    value: ({ agentId, loading, busy, error, confirmOpen, form, builtins, ambiencePresets, toolModalOpen, toolEditIndex, toolDraft, toolError, mcpModalOpen, mcpEditIndex, mcpDraft, mcpError, voiceModalOpen }) => {
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
                  hint="Komma-getrennt; in Prod E.164 (+49…). Bei aktivem Web-Widget ergänzt der Server die interne Web-Durchwahl automatisch."
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

                <glk-select
                  id="voiceProviderSelect"
                  label="Voice-Provider"
                  onglk-change="${(host, e) => setField(host, "voiceProvider", e.detail.value)}"
                >
                  <option value="deepgram">Deepgram Voice Agent</option>
                  <option value="native">Native (STT→LLM→TTS-Kaskade, Flux + Aura)</option>
                </glk-select>

                <glk-input
                  label="Sprache"
                  value="${f.language}"
                  placeholder="z. B. de, en, multi"
                  onglk-input="${(host, e) => setField(host, "language", e.detail.value)}"
                ></glk-input>

                <glk-select
                  id="listenModelSelect"
                  label="STT-Modell (listen.model)"
                  onglk-change="${(host, e) => setField(host, "listenModel", e.detail.value)}"
                >
                  <option value="nova-3">nova-3</option>
                  <option value="flux-general-multi">flux-general-multi (mehrsprachig, Turn-Detection)</option>
                  <option value="flux-general-en">flux-general-en (Englisch, Turn-Detection)</option>
                </glk-select>

                ${isFluxModel(f.listenModel) &&
                html`
                  <glk-input
                    label="End-of-Turn-Schwelle (eot_threshold)"
                    type="number"
                    value="${f.eotThreshold}"
                    placeholder="z. B. 0.7"
                    hint="0–1; leer = Deepgram-Default"
                    onglk-input="${(host, e) => setField(host, "eotThreshold", e.detail.value)}"
                  ></glk-input>

                  <glk-input
                    label="End-of-Turn-Timeout (eot_timeout_ms)"
                    type="number"
                    value="${f.eotTimeoutMs}"
                    placeholder="z. B. 3000"
                    hint="Millisekunden; leer = Deepgram-Default"
                    onglk-input="${(host, e) => setField(host, "eotTimeoutMs", e.detail.value)}"
                  ></glk-input>
                `}

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

                <glk-select
                  id="speakProviderSelect"
                  label="TTS-Provider (speak.provider)"
                  onglk-change="${(host, e) => setField(host, "speakProvider", e.detail.value)}"
                >
                  <option value="deepgram">Deepgram (Aura)</option>
                  <option value="eleven_labs">ElevenLabs</option>
                </glk-select>

                ${f.speakProvider === "eleven_labs"
                  ? html`
                      <glk-input
                        label="ElevenLabs Voice-ID"
                        value="${f.speakVoice}"
                        placeholder="z. B. 21m00Tcm4TlvDq8ikWAM"
                        hint="API-Key kommt aus dem Server-Env (ELEVENLABS_API_KEY) — ohne Key/Voice-ID fällt der Anruf auf die Deepgram-Stimme zurück"
                        onglk-input="${(host, e) => setField(host, "speakVoice", e.detail.value)}"
                      ></glk-input>
                      <glk-input
                        label="ElevenLabs-Modell (optional)"
                        value="${f.speakModelEleven}"
                        placeholder="leer = eleven_turbo_v2_5"
                        onglk-input="${(host, e) => setField(host, "speakModelEleven", e.detail.value)}"
                      ></glk-input>
                      <div class="group-head">
                        <glk-button
                          size="sm"
                          variant="secondary"
                          onclick="${(host) => {
                            host.voiceModalOpen = true;
                          }}"
                        >
                          Erweiterte Stimm-Einstellungen…
                        </glk-button>
                        <span class="empty-hint">${voiceSettingsSummary(f)}</span>
                      </div>
                    `
                  : html`
                      <glk-input
                        label="TTS-Modell (speak.model)"
                        value="${f.speakModel}"
                        placeholder="z. B. aura-2-thalia-en"
                        onglk-input="${(host, e) => setField(host, "speakModel", e.detail.value)}"
                      ></glk-input>
                    `}

                <glk-divider></glk-divider>

                <glk-toggle
                  label="Hintergrundatmosphäre (Ambience)"
                  checked="${f.ambienceEnabled}"
                  onglk-change="${(host, e) => setField(host, "ambienceEnabled", e.detail.checked)}"
                ></glk-toggle>
                ${f.ambienceEnabled &&
                html`
                  <glk-select
                    id="ambiencePresetSelect"
                    label="Preset"
                    onglk-change="${(host, e) => setField(host, "ambiencePreset", e.detail.value)}"
                  >
                    ${(ambiencePresets || FALLBACK_AMBIENCE).map(
                      (p) => html`<option value="${p.id}">${p.label}</option>`,
                    )}
                  </glk-select>
                  <glk-range
                    label="Lautstärke (%)"
                    min="0"
                    max="100"
                    step="5"
                    value="${f.ambienceVolume}"
                    onglk-input="${(host, e) => setField(host, "ambienceVolume", e.detail.value)}"
                  ></glk-range>
                  <div class="empty-hint">
                    Leise Dauerschleife, die der Anrufer das ganze Gespräch über hört (auch in
                    Sprechpausen). Landet mit in der Aufnahme; pausiert bei Übergabe an einen Menschen.
                  </div>
                `}

                <glk-divider></glk-divider>

                <glk-toggle
                  label="Web-Widget (einbettbares Browser-Softphone)"
                  checked="${f.widgetEnabled}"
                  onglk-change="${(host, e) => setField(host, "widgetEnabled", e.detail.checked)}"
                ></glk-toggle>
                ${f.widgetEnabled &&
                html`
                  <div class="empty-hint">
                    ${f._widget && f._widget.exten
                      ? html`Interne Web-Durchwahl: <strong>${f._widget.exten}</strong> (automatisch
                          verwaltet — dorthin routet der Web-Anruf, steht deshalb auch unter
                          Zielrufnummern).`
                      : html`Die interne Web-Durchwahl wird beim Speichern automatisch vergeben und
                          den Zielrufnummern hinzugefügt.`}
                  </div>
                  <glk-textarea
                    label="Erlaubte Websites (eine Origin pro Zeile)"
                    rows="3"
                    value="${f.widgetOrigins}"
                    placeholder="https://kunde.de"
                    onglk-input="${(host, e) => setField(host, "widgetOrigins", e.detail.value)}"
                  ></glk-textarea>
                  <div class="empty-hint">
                    Nur diese Websites dürfen das Widget einbetten (CSP frame-ancestors). Die
                    Appliance-Domain selbst ist immer erlaubt (Demo-Seite).
                  </div>
                  <glk-toggle
                    label="Live-Transkript im Widget anzeigen"
                    checked="${f.widgetShowTranscript}"
                    onglk-change="${(host, e) => setField(host, "widgetShowTranscript", e.detail.checked)}"
                  ></glk-toggle>
                  ${f._widget && f._widget.key
                    ? html`
                        <glk-input label="Widget-Key (server-verwaltet)" value="${f._widget.key}" readonly></glk-input>
                        <div class="group-head">
                          <glk-button size="sm" variant="secondary" onclick="${copyWidgetSnippet}">
                            Embed-Snippet kopieren
                          </glk-button>
                          <glk-button
                            size="sm"
                            variant="secondary"
                            onclick="${(host) => window.open(`/widget-demo.html?key=${encodeURIComponent(host.form._widget.key)}`, "_blank")}"
                          >
                            Demo öffnen
                          </glk-button>
                          <glk-button size="sm" variant="tertiary" onclick="${rotateWidgetKey}">
                            Schlüssel rotieren
                          </glk-button>
                        </div>
                      `
                    : html`<div class="empty-hint">
                        Der Widget-Key wird beim Speichern erzeugt — danach erscheinen hier
                        Embed-Snippet und Demo-Link.
                      </div>`}
                `}

                <glk-divider></glk-divider>

                <div class="group-label">Eingebaute Tools</div>
                ${(builtins || FALLBACK_BUILTINS).map(
                  (b) => html`
                    <glk-toggle
                      label="${toolLabel(b)}"
                      checked="${f.tools.indexOf(b.name) !== -1}"
                      onglk-change="${(host, e) => toggleBuiltinTool(host, b.name, e.detail.checked)}"
                    ></glk-toggle>
                  `,
                )}

                <div class="group-head">
                  <div class="group-label">Eigene HTTP-Tools</div>
                  <glk-button size="sm" variant="secondary" onclick="${(host) => openToolEditor(host, -1)}">
                    + Tool
                  </glk-button>
                </div>
                ${f.customTools.length
                  ? html`
                      <glk-list>
                        ${f.customTools.map(
                          (t, i) => html`
                            <glk-list-item
                              interactive
                              title="${t.name}${t.enabled === false ? " (inaktiv)" : ""}"
                              subtitle="${customToolSubtitle(t)}"
                              onglk-click="${(host) => openToolEditor(host, i)}"
                            ></glk-list-item>
                          `,
                        )}
                      </glk-list>
                    `
                  : html`<div class="empty-hint">
                      Fachliche Funktionen (CRM-Lookup, Termine …) als externe HTTP-Endpoints —
                      Kontrakt siehe docs/tools.md.
                    </div>`}

                <div class="group-head">
                  <div class="group-label">MCP-Server (Tool-Quellen)</div>
                  <glk-button size="sm" variant="secondary" onclick="${(host) => openMcpEditor(host, -1)}">
                    + Server
                  </glk-button>
                </div>
                ${f.mcpServers.length
                  ? html`
                      <glk-list>
                        ${f.mcpServers.map(
                          (s, i) => html`
                            <glk-list-item
                              interactive
                              title="${s.name}${s.enabled === false ? " (inaktiv)" : ""}"
                              subtitle="${mcpSubtitle(s)}"
                              onglk-click="${(host) => openMcpEditor(host, i)}"
                            ></glk-list-item>
                          `,
                        )}
                      </glk-list>
                    `
                  : html`<div class="empty-hint">
                      Tools eines MCP-Servers erscheinen dem Agenten als
                      server_toolname (Streamable HTTP, statische Auth-Header).
                    </div>`}

                <glk-divider></glk-divider>

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

              <glk-modal
                title="ElevenLabs — erweiterte Stimm-Einstellungen"
                open="${voiceModalOpen}"
                onglk-close="${(host) => {
                  host.voiceModalOpen = false;
                }}"
              >
                <div class="tool-form">
                  <div class="empty-hint">
                    Leer = Voice-Default aus dem ElevenLabs-Dashboard. Die Werte wirken in der
                    nativen Kaskade; im Deepgram-Agent-Modus gelten immer die Dashboard-Defaults.
                  </div>
                  <glk-input
                    label="Stabilität (0–1)"
                    value="${f.speakStability}"
                    placeholder="z. B. 0.5"
                    hint="Niedrig = lebendiger/expressiver, hoch = gleichmäßiger"
                    onglk-input="${(host, e) => setField(host, "speakStability", e.detail.value)}"
                  ></glk-input>
                  <glk-input
                    label="Similarity Boost (0–1)"
                    value="${f.speakSimilarity}"
                    placeholder="z. B. 0.75"
                    hint="Wie eng die Synthese am Original der Stimme bleibt"
                    onglk-input="${(host, e) => setField(host, "speakSimilarity", e.detail.value)}"
                  ></glk-input>
                  <glk-input
                    label="Sprechtempo (0.7–1.2)"
                    value="${f.speakSpeed}"
                    placeholder="1.0 = normal"
                    hint="Werte außerhalb 0.7–1.2 werden beim Sprechen geklemmt"
                    onglk-input="${(host, e) => setField(host, "speakSpeed", e.detail.value)}"
                  ></glk-input>
                </div>
                <div slot="actions">
                  <button
                    class="glass-modal__action"
                    onclick="${(host) => {
                      host.form = { ...host.form, speakStability: "", speakSimilarity: "", speakSpeed: "" };
                    }}"
                  >Zurücksetzen</button>
                  <button
                    class="glass-modal__action"
                    onclick="${(host) => {
                      host.voiceModalOpen = false;
                    }}"
                  >Fertig</button>
                </div>
              </glk-modal>

              <glk-modal
                title="${toolEditIndex >= 0 ? "HTTP-Tool bearbeiten" : "Neues HTTP-Tool"}"
                open="${toolModalOpen}"
                onglk-close="${(host) => {
                  host.toolModalOpen = false;
                }}"
              >
                ${toolDraft &&
                html`
                  <div class="tool-form">
                    ${toolError && html`<glk-status message="${toolError}"></glk-status>`}

                    <glk-input
                      label="Name"
                      value="${toolDraft.name}"
                      placeholder="crm_lookup"
                      hint="a–z, 0–9, _ — unter diesem Namen ruft das LLM das Tool auf"
                      onglk-input="${(host, e) => setDraft(host, "name", e.detail.value)}"
                    ></glk-input>

                    <glk-input
                      label="Beschreibung"
                      value="${toolDraft.description}"
                      hint="Wann soll das LLM dieses Tool nutzen?"
                      onglk-input="${(host, e) => setDraft(host, "description", e.detail.value)}"
                    ></glk-input>

                    <glk-select
                      id="toolMethodSelect"
                      label="Methode"
                      onglk-change="${(host, e) => setDraft(host, "method", e.detail.value)}"
                    >
                      <option value="POST">POST (JSON-Envelope)</option>
                      <option value="GET">GET (Query-Parameter)</option>
                    </glk-select>

                    <glk-input
                      label="Endpoint-URL"
                      value="${toolDraft.url}"
                      placeholder="https://api.example.com/voice-tools/crm-lookup"
                      onglk-input="${(host, e) => setDraft(host, "url", e.detail.value)}"
                    ></glk-input>

                    <glk-input
                      label="Timeout (ms)"
                      type="number"
                      value="${toolDraft.timeoutMs}"
                      hint="500–30000; während des Aufrufs herrscht Stille im Gespräch"
                      onglk-input="${(host, e) => setDraft(host, "timeoutMs", e.detail.value)}"
                    ></glk-input>

                    <div class="group-label">
                      HTTP-Header — Werte dürfen \${ENV:NAME} enthalten (Secret aus der Server-Umgebung)
                    </div>
                    ${toolDraft.headers.map(
                      (row, i) => html`
                        <div class="hdr-row">
                          <glk-input
                            placeholder="authorization"
                            value="${row.k}"
                            onglk-input="${(host, e) => setDraftHeader(host, i, "k", e.detail.value)}"
                          ></glk-input>
                          <glk-input
                            placeholder="Bearer \${ENV:CRM_API_KEY}"
                            value="${row.v}"
                            onglk-input="${(host, e) => setDraftHeader(host, i, "v", e.detail.value)}"
                          ></glk-input>
                          <glk-button size="sm" variant="tertiary" onclick="${(host) => removeDraftHeader(host, i)}">
                            ✕
                          </glk-button>
                        </div>
                      `,
                    )}
                    <glk-button
                      size="sm"
                      variant="secondary"
                      onclick="${(host) => setDraft(host, "headers", [...host.toolDraft.headers, { k: "", v: "" }])}"
                    >+ Header</glk-button>

                    <glk-textarea
                      label="Parameters (JSON-Schema der Argumente)"
                      rows="6"
                      value="${toolDraft.parametersText}"
                      onglk-input="${(host, e) => setDraft(host, "parametersText", e.detail.value)}"
                    ></glk-textarea>

                    <glk-toggle
                      label="Aktiv"
                      checked="${toolDraft.enabled}"
                      onglk-change="${(host, e) => setDraft(host, "enabled", e.detail.checked)}"
                    ></glk-toggle>
                  </div>
                `}
                <div slot="actions">
                  ${toolEditIndex >= 0 &&
                  html`
                    <button class="glass-modal__action glass-modal__action--danger" onclick="${removeCustomTool}">
                      Entfernen
                    </button>
                  `}
                  <button
                    class="glass-modal__action"
                    onclick="${(host) => {
                      host.toolModalOpen = false;
                    }}"
                  >Abbrechen</button>
                  <button class="glass-modal__action" onclick="${saveToolDraft}">Übernehmen</button>
                </div>
              </glk-modal>

              <glk-modal
                title="${mcpEditIndex >= 0 ? "MCP-Server bearbeiten" : "Neuer MCP-Server"}"
                open="${mcpModalOpen}"
                onglk-close="${(host) => {
                  host.mcpModalOpen = false;
                }}"
              >
                ${mcpDraft &&
                html`
                  <div class="tool-form">
                    ${mcpError && html`<glk-status message="${mcpError}"></glk-status>`}

                    <glk-input
                      label="Name (Tool-Präfix)"
                      value="${mcpDraft.name}"
                      placeholder="crm"
                      hint="Tools erscheinen als name_toolname (a–z, 0–9, _)"
                      onglk-input="${(host, e) => setMcpDraft(host, "name", e.detail.value)}"
                    ></glk-input>

                    <glk-input
                      label="Server-URL (Streamable HTTP)"
                      value="${mcpDraft.url}"
                      placeholder="https://mcp.example.com/mcp"
                      onglk-input="${(host, e) => setMcpDraft(host, "url", e.detail.value)}"
                    ></glk-input>

                    <glk-input
                      label="Tool-Filter (optional, Komma-getrennt)"
                      value="${mcpDraft.toolFilter}"
                      placeholder="leer = alle Tools des Servers"
                      hint="Unpräfixierte Tool-Namen, z. B. search_customer, book_slot"
                      onglk-input="${(host, e) => setMcpDraft(host, "toolFilter", e.detail.value)}"
                    ></glk-input>

                    <glk-input
                      label="Timeout (ms)"
                      type="number"
                      value="${mcpDraft.timeoutMs}"
                      hint="500–30000; gilt für Verbindung und Tool-Aufrufe"
                      onglk-input="${(host, e) => setMcpDraft(host, "timeoutMs", e.detail.value)}"
                    ></glk-input>

                    <div class="group-label">
                      HTTP-Header — Werte dürfen \${ENV:NAME} enthalten (Secret aus der Server-Umgebung)
                    </div>
                    ${mcpDraft.headers.map(
                      (row, i) => html`
                        <div class="hdr-row">
                          <glk-input
                            placeholder="authorization"
                            value="${row.k}"
                            onglk-input="${(host, e) => setMcpHeader(host, i, "k", e.detail.value)}"
                          ></glk-input>
                          <glk-input
                            placeholder="Bearer \${ENV:MCP_API_KEY}"
                            value="${row.v}"
                            onglk-input="${(host, e) => setMcpHeader(host, i, "v", e.detail.value)}"
                          ></glk-input>
                          <glk-button size="sm" variant="tertiary" onclick="${(host) => removeMcpHeader(host, i)}">
                            ✕
                          </glk-button>
                        </div>
                      `,
                    )}
                    <glk-button
                      size="sm"
                      variant="secondary"
                      onclick="${(host) => setMcpDraft(host, "headers", [...host.mcpDraft.headers, { k: "", v: "" }])}"
                    >+ Header</glk-button>

                    <glk-toggle
                      label="Aktiv"
                      checked="${mcpDraft.enabled}"
                      onglk-change="${(host, e) => setMcpDraft(host, "enabled", e.detail.checked)}"
                    ></glk-toggle>
                  </div>
                `}
                <div slot="actions">
                  ${mcpEditIndex >= 0 &&
                  html`
                    <button class="glass-modal__action glass-modal__action--danger" onclick="${removeMcpServer}">
                      Entfernen
                    </button>
                  `}
                  <button
                    class="glass-modal__action"
                    onclick="${(host) => {
                      host.mcpModalOpen = false;
                    }}"
                  >Abbrechen</button>
                  <button class="glass-modal__action" onclick="${saveMcpDraft}">Übernehmen</button>
                </div>
              </glk-modal>
            `}
      `.css`
        .head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
        .form { display: flex; flex-direction: column; gap: 14px; }
        .group-label { font-size: 13px; opacity: 0.75; }
        .group-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .empty-hint { font-size: 13px; opacity: 0.55; }
        .tool-form { display: flex; flex-direction: column; gap: 10px; max-height: 60vh; overflow-y: auto; padding-right: 4px; }
        .hdr-row { display: grid; grid-template-columns: 1fr 1.4fr auto; gap: 8px; align-items: center; }
      `;
    },
    // Nach jedem Render die Selects imperativ auf den echten State setzen.
    // Grund: glk-select klont seine <option>s per rAF und übernimmt nur das
    // value-ATTRIBUT (nicht die von Hybrids gesetzte selected-Property), daher
    // greift weder option[selected] noch das value-Property zuverlässig.
    observe: (host) => {
      if (!host.form) return;
      const selects = [
        ["modeSelect", host.form.mode],
        ["voiceProviderSelect", host.form.voiceProvider],
        ["listenModelSelect", host.form.listenModel],
        ["speakProviderSelect", host.form.speakProvider],
        ["ambiencePresetSelect", host.form.ambiencePreset],
        ["toolMethodSelect", host.toolDraft && host.toolDraft.method],
      ];
      for (const [id, value] of selects) {
        const sel = host.shadowRoot && host.shadowRoot.getElementById(id);
        // Attribut → glk-select.onAttributeChanged('value') wendet es an;
        // wird auch von der initialen rAF-Option-Übernahme gelesen.
        if (sel && value) sel.setAttribute("value", value);
      }
    },
    connect: (host) => {
      load(host);
    },
  },
});
