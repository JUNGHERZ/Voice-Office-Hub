/*
 * Agent-Formular (Anlegen/Bearbeiten). Felder: name, targetNumbers (Komma→Array),
 * mode, voiceProvider, language, listen.model (nova-3/flux + eot-Felder), greeting,
 * greetingPrompt, prompt, speak.model, Tools (Built-in-Toggles + Custom-HTTP-Tools mit Modal-Editor,
 * inkl. optionaler Per-Tool-Filler-Phrase), transferFailedAnnouncement, fillers (Timer-
 * Filler bei Tool-Wartezeiten), idlePrompts (Nachfassen bei Stille, optional mit
 * Auflegen), summary.enabled, enabled. Speichern → POST/PATCH,
 * Löschen → Bestätigung via <glk-modal>.
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

// Fallback, falls /api/tts/providers nicht erreichbar ist. Bewusst knapp: das
// Formular soll bedienbar bleiben, die Feinheiten (Stimmlisten, DSGVO-Hinweise)
// liefert der Server.
const FALLBACK_TTS_PROVIDERS = [
  {
    id: "deepgram",
    label: "Deepgram Aura",
    paths: ["native", "deepgram"],
    models: [{ id: "aura-2-thalia-en", label: "Thalia (englisch)", languages: ["en"] }],
    defaultModel: "aura-2-thalia-en",
    modelFreeText: true,
    voices: [],
    voiceFreeText: false,
    knobs: ["speed", "volume"],
    residency: "eu-optional",
    residencyNote: "",
    costPer1kChars: 0.03,
    envKey: "DEEPGRAM_API_KEY",
    configured: true,
  },
];

// Kurztext + Farbe des DSGVO-Badges neben der Provider-Auswahl.
const RESIDENCY_LABELS = {
  eu: { text: "EU-Verarbeitung", variant: "success" },
  "eu-optional": { text: "EU-Endpoint möglich", variant: "success" },
  us: { text: "USA — SCC/DPF nötig", variant: "warning" },
  "third-country": { text: "Drittland", variant: "danger" },
};

// Nur Provider, die im gewählten voiceProvider-Pfad tatsächlich laufen. Ausgrauen
// wäre erklärungsbedürftig — die Hinweiszeile darunter sagt stattdessen, warum
// die Liste kurz ist.
function providersForPath(providers, voiceProvider) {
  // `duplex` ist dieselbe Kaskade wie `native`, nur mit Gesprächsführung davor — es
  // muss deshalb dieselbe TTS-Auswahl bekommen. Ohne diese Zeile bekäme ein
  // Duplex-Agent die kurze Voice-Agent-Liste angeboten.
  const path = voiceProvider === "native" || voiceProvider === "duplex" ? "native" : "deepgram";
  return (providers || []).filter((p) => (p.paths || []).indexOf(path) !== -1);
}

function providerById(providers, id) {
  return (providers || []).filter((p) => p.id === id)[0];
}

// Stimmen sind teils ans Modell gebunden (Speechify: die *_32-Stimmen gehören zu 3.2).
function voicesForModel(provider, modelId) {
  if (!provider) return [];
  return (provider.voices || []).filter((v) => !v.models || v.models.indexOf(modelId) !== -1);
}

function knobActive(provider, knob) {
  return Boolean(provider && (provider.knobs || []).indexOf(knob) !== -1);
}

// Auswahl für „Sprache der Ansagen". Deckt die Sprachen ab, die der serverseitige
// Stopwort-Scorer erkennt (src/llm/languageScorer.ts) — nur für die kann die automatische
// Ermittlung überhaupt ein Ergebnis liefern.
const CONTENT_LANGUAGES = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "Englisch" },
  { code: "fr", label: "Französisch" },
  { code: "es", label: "Spanisch" },
  { code: "it", label: "Italienisch" },
  { code: "nl", label: "Niederländisch" },
  { code: "pt", label: "Portugiesisch" },
  { code: "pl", label: "Polnisch" },
  { code: "tr", label: "Türkisch" },
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
    greetingPrompt: "",
    prompt: "",
    speakProvider: "deepgram",
    // Modell und Stimme je Provider getrennt halten: beim Umschalten geht kein
    // Wert verloren, und es braucht keine Heuristik über Modellnamen mehr.
    // In der DB landet immer nur der Wert des AKTIVEN Providers.
    modelBy: {},
    voiceBy: {},
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
    transferFailedAnnouncement: "",
    fillersEnabled: false,
    fillersDelayMs: "2000",
    fillersPhrases: "",
    idleEnabled: false,
    idleTimeoutMs: "8000",
    idleMaxPrompts: "2",
    idlePhrases: "",
    idleHangupAfter: false,
    idleHangupAnnouncement: "",
    // Leer = "Automatisch erkennen"; der Server trägt beim Speichern den erkannten Code ein.
    contentLanguage: "",
    callerMemoryLanguage: false,
    tools: ["transfer_call", "end_call"],
    customTools: [],
    mcpServers: [],
    useTransferCallerId: false,
    summaryEnabled: false,
    recordingEnabled: true,
    enabled: true,
    // Carry-along: komplette Subdokumente des geladenen Agents (siehe Kopfkommentar).
    _listen: {},
    _speak: {},
    _ambience: {},
    _widget: {},
    _fillers: {},
    _idlePrompts: {},
    _callerMemory: {},
  };
}

// API-Agent → Formularmodell.
function toForm(a) {
  const listen = a.listen || {};
  const ambience = a.ambience || {};
  const widget = a.widget || {};
  const fillers = a.fillers || {};
  const idle = a.idlePrompts || {};
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
    greetingPrompt: a.greetingPrompt || "",
    prompt: a.prompt || "",
    speakProvider: (a.speak && a.speak.provider) || "deepgram",
    // Der gespeicherte Wert gehört per Definition dem aktiven Provider — damit
    // entfällt das alte Raten über Modellpräfixe.
    modelBy: { [(a.speak && a.speak.provider) || "deepgram"]: (a.speak && a.speak.model) || "" },
    voiceBy: { [(a.speak && a.speak.provider) || "deepgram"]: (a.speak && a.speak.voice) || "" },
    speakStability: a.speak && a.speak.stability != null ? String(a.speak.stability) : "",
    speakSimilarity: a.speak && a.speak.similarityBoost != null ? String(a.speak.similarityBoost) : "",
    speakSpeed: a.speak && a.speak.speed != null ? String(a.speak.speed) : "",
    ambienceEnabled: !!ambience.enabled,
    ambiencePreset: ambience.preset || "office",
    ambienceVolume: String(Math.round((ambience.volume != null ? ambience.volume : 0.25) * 100)),
    widgetEnabled: !!widget.enabled,
    widgetOrigins: (widget.allowedOrigins || []).join("\n"),
    widgetShowTranscript: widget.showTranscript !== false,
    transferFailedAnnouncement: a.transferFailedAnnouncement || "",
    fillersEnabled: !!fillers.enabled,
    fillersDelayMs: fillers.delayMs != null ? String(fillers.delayMs) : "2000",
    fillersPhrases: (fillers.phrases || []).join("\n"),
    idleEnabled: !!idle.enabled,
    idleTimeoutMs: idle.timeoutMs != null ? String(idle.timeoutMs) : "8000",
    idleMaxPrompts: idle.maxPrompts != null ? String(idle.maxPrompts) : "2",
    idlePhrases: (idle.phrases || []).join("\n"),
    idleHangupAfter: !!idle.hangupAfter,
    idleHangupAnnouncement: idle.hangupAnnouncement || "",
    contentLanguage: a.contentLanguage || "",
    callerMemoryLanguage: !!(a.callerMemory && a.callerMemory.language),
    tools: a.tools && a.tools.length ? [...a.tools] : ["transfer_call", "end_call"],
    customTools: (a.customTools || []).map((t) => ({ ...t, endpoint: { ...(t.endpoint || {}) } })),
    mcpServers: (a.mcpServers || []).map((s) => ({ ...s })),
    useTransferCallerId: !!a.useTransferCallerId,
    summaryEnabled: !!(a.summary && a.summary.enabled),
    // Fehlendes Feld = aufnehmen: Agents von vor 0.10.0 kennen es nicht, und ein
    // ausgeschalteter Schalter wäre dort schlicht falsch.
    recordingEnabled: !(a.recording && a.recording.enabled === false),
    enabled: a.enabled !== false,
    _listen: { ...listen },
    _speak: { ...(a.speak || {}) },
    _ambience: { ...ambience },
    _widget: { ...widget },
    _fillers: { ...fillers },
    _idlePrompts: { ...idle },
    _callerMemory: { ...(a.callerMemory || {}) },
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
    greetingPrompt: f.greetingPrompt.trim(),
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
      model: (f.modelBy[f.speakProvider] || "").trim() || undefined,
      voice: (f.voiceBy[f.speakProvider] || "").trim() || undefined,
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
    recording: { enabled: f.recordingEnabled },
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
    transferFailedAnnouncement: f.transferFailedAnnouncement.trim() || undefined,
    fillers: {
      ...f._fillers,
      enabled: f.fillersEnabled,
      delayMs: num(f.fillersDelayMs) ?? 2000,
      phrases: f.fillersPhrases
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    idlePrompts: {
      ...f._idlePrompts,
      enabled: f.idleEnabled,
      timeoutMs: num(f.idleTimeoutMs) ?? 8000,
      maxPrompts: num(f.idleMaxPrompts) ?? 2,
      phrases: f.idlePhrases
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      hangupAfter: f.idleHangupAfter,
      hangupAnnouncement: f.idleHangupAnnouncement.trim() || undefined,
    },
    // Leer mitsenden ist Absicht: Der Server erkennt die Sprache dann neu aus Greeting/Prompt.
    contentLanguage: f.contentLanguage.trim(),
    callerMemory: { ...f._callerMemory, language: f.callerMemoryLanguage },
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
  try {
    const res = await api.listTtsProviders();
    host.ttsProviders = (res && res.providers) || FALLBACK_TTS_PROVIDERS;
  } catch (e) {
    host.ttsProviders = FALLBACK_TTS_PROVIDERS;
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

// Setter für die providergebundenen Maps (modelBy/voiceBy).
function setByProvider(host, map, value) {
  const f = host.form;
  host.form = { ...f, [map]: { ...f[map], [f.speakProvider]: value } };
}

/**
 * Voice-Provider wechseln. Der Deepgram-Voice-Agent reicht nur eigene Stimmen und
 * ElevenLabs durch — steht dort ein nativ-only-TTS (z. B. Voxtral), fällt die
 * Auswahl mit zurück auf Deepgram. Sonst zeigte das Formular einen Provider, den
 * der Anruf gar nicht nutzen könnte.
 */
function selectVoiceProvider(host, value) {
  const allowed = providersForPath(host.ttsProviders, value).map((p) => p.id);
  const f = host.form;
  const speak = allowed.length && allowed.indexOf(f.speakProvider) === -1 ? "deepgram" : f.speakProvider;
  host.form = { ...f, voiceProvider: value, speakProvider: speak };
}

// Provider wechseln: Modell des neuen Providers vorbelegen, falls dort noch nichts steht.
function selectProvider(host, providers, id) {
  const entry = providerById(providers, id);
  const f = host.form;
  const model = f.modelBy[id] || (entry && entry.defaultModel) || "";
  host.form = { ...f, speakProvider: id, modelBy: { ...f.modelBy, [id]: model } };
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
    fillerPhrase: "",
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
        fillerPhrase: t.fillerPhrase || "",
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
    fillerPhrase: (d.fillerPhrase || "").trim() || undefined,
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

// ── Vorübersetzte Ansagen ────────────────────────────────────────────────────

/**
 * Zeile neben dem Modal-Button: welche Sprachen es gibt und ob sie zum aktuellen Original
 * passen. „veraltet" erscheint, sobald jemand oben eine Ansage geändert hat, und verschwindet
 * von selbst, wenn die Neuerzeugung durch ist.
 */
function translationSummary(agentId, translations) {
  if (!agentId) return "verfügbar, sobald der Agent gespeichert ist";
  if (!translations) return "noch nicht geladen";
  const langs = translations.languages || [];
  if (!langs.length) return "noch keine — entsteht nach dem ersten fremdsprachigen Anruf";
  return langs
    .map((l) => {
      const stale = (l.entries || []).filter((e) => e.stale).length;
      return stale ? `${l.lang.toUpperCase()} ⚠ ${stale} veraltet` : `${l.lang.toUpperCase()} ✓`;
    })
    .join(" · ");
}

/**
 * Inhalt des Modals: Original und Übersetzung untereinander (Ansagen sind Sätze, keine
 * Tabellenzellen). Ein FEHLENDER Eintrag wird als leeres Feld gezeigt statt weggelassen —
 * ein Übersetzungs-Fehlschlag soll auffallen, statt lautlos zu verschwinden.
 */
function renderTranslations(translations, lang, f) {
  if (!translations) return html`<div class="empty-hint">Wird geladen…</div>`;
  const langs = translations.languages || [];
  if (!langs.length) {
    return html`<div class="empty-hint">
      Für diesen Agenten gibt es noch keine Übersetzungen. Sie entstehen automatisch, sobald
      jemand in einer anderen Sprache angerufen hat — ab dem nächsten Anruf derselben Nummer
      begrüßt der Agent dann direkt in dieser Sprache.
    </div>`;
  }
  const current = langs.find((l) => l.lang === lang) || langs[0];
  const src = (translations.contentLanguage || f.contentLanguage || "de").toUpperCase();
  return html`
    <glk-select
      id="translationLangSelect"
      label="Sprache"
      onglk-change="${(host, e) => {
        host.translationLang = e.detail.value;
      }}"
    >
      ${langs.map((l) => html`<option value="${l.lang}">${l.lang.toUpperCase()}</option>`)}
    </glk-select>
    ${(current.entries || []).map(
      (e) => html`
        <div class="tr-entry">
          <div class="tr-head">
            <strong>${e.label}</strong>
            ${e.stale ? html`<span class="tr-stale">⚠ veraltet</span>` : ""}
          </div>
          <div class="tr-line"><span class="tr-lang">${src}</span> ${e.source}</div>
          <div class="tr-line">
            <span class="tr-lang">${current.lang.toUpperCase()}</span>
            ${e.translation || html`<em class="tr-missing">— fehlt —</em>`}
          </div>
          ${e.stale
            ? html`<div class="empty-hint">
                Das Original wurde geändert. Bis zur Neuerzeugung spricht der Agent hier die
                Standardsprache.
              </div>`
            : ""}
        </div>
      `,
    )}
  `;
}

async function loadTranslations(host) {
  if (!host.agentId) return;
  try {
    const res = await api.getTranslations(host.agentId);
    host.translations = res;
    const langs = (res.languages || []).map((l) => l.lang);
    // Gewählte Sprache halten, solange es sie noch gibt.
    if (!langs.includes(host.translationLang)) host.translationLang = langs[0] || "";
  } catch (err) {
    host.error = String((err && err.message) || err);
  }
}

async function openTranslations(host) {
  host.translationsOpen = true;
  await loadTranslations(host);
}

async function regenerateTranslation(host) {
  if (host.translationsBusy || !host.translationLang) return;
  host.translationsBusy = true;
  try {
    await api.regenerateTranslation(host.agentId, host.translationLang);
    await loadTranslations(host);
  } catch (err) {
    host.error = String((err && err.message) || err);
  } finally {
    host.translationsBusy = false;
  }
}

/**
 * Agent duplizieren: legt die aktuelle Konfiguration als NEUEN Agenten an und öffnet ihn.
 *
 * Zwei Dinge werden bewusst nicht mitkopiert, weil sie einen Agenten eindeutig identifizieren
 * und sonst kollidieren würden:
 *  - `targetNumbers` — zwei Agenten auf derselben DDI: der Anruf landete beim erstbesten
 *    Treffer, und welcher das ist, wäre Zufall. Die Kopie startet ohne Rufnummer.
 *  - `widget.exten`/`widget.key` — die Pseudo-Durchwahl ist ebenfalls eine Nummer, und der
 *    Embed-Key ist ein Geheimnis. Beides vergibt der Server für die Kopie neu.
 */
async function cloneAgent(host) {
  if (host.busy || !host.agentId) return;
  host.error = "";
  host.busy = true;
  try {
    const body = toBody(host.form);
    body.name = `${body.name} (Kopie)`;
    body.targetNumbers = [];
    if (body.widget) {
      delete body.widget.exten;
      delete body.widget.key;
    }
    const res = await api.createAgent(body);
    const id = res && res.agent && (res.agent._id || res.agent.id);
    if (!id) throw new Error("Server lieferte keine ID für die Kopie");
    navigate(host, "agent", String(id));
  } catch (err) {
    host.error = `Duplizieren fehlgeschlagen: ${String((err && err.message) || err)}`;
  } finally {
    host.busy = false;
  }
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
  ttsProviders: undefined,
  toolModalOpen: false,
  toolEditIndex: -1,
  toolDraft: undefined,
  toolError: "",
  mcpModalOpen: false,
  mcpEditIndex: -1,
  mcpDraft: undefined,
  mcpError: "",
  voiceModalOpen: false,
  // Vorübersetzte Ansagen: erst beim Öffnen geladen (eigener Endpoint, nicht Teil des Agenten).
  translationsOpen: false,
  translations: undefined,
  translationLang: "",
  translationsBusy: false,
  render: {
    value: ({ agentId, loading, busy, error, confirmOpen, form, builtins, ambiencePresets, ttsProviders, toolModalOpen, toolEditIndex, toolDraft, toolError, mcpModalOpen, mcpEditIndex, mcpDraft, mcpError, voiceModalOpen, translationsOpen, translations, translationLang, translationsBusy }) => {
      const f = form || emptyForm();
      const title = agentId ? f.name || "Agent" : "Neuer Agent";
      // TTS-Panel wird aus dem Server-Katalog gerendert — ein siebter Provider ist
      // damit ein Katalogeintrag, kein neuer Zweig hier.
      const pathProviders = providersForPath(ttsProviders, f.voiceProvider);
      const ttsProvider = providerById(ttsProviders, f.speakProvider);
      const residencyBadge =
        (ttsProvider && RESIDENCY_LABELS[ttsProvider.residency]) || { text: "", variant: "" };
      // Leeres Modellfeld heißt beim Anlegen „noch nichts gewählt" — dann zeigt das
      // Select den Provider-Default, damit nicht versehentlich ohne Modell gespeichert wird.
      const activeModel = f.modelBy[f.speakProvider] || (ttsProvider && !ttsProvider.modelFreeText ? ttsProvider.defaultModel : "");
      const activeVoice = f.voiceBy[f.speakProvider] || "";
      const modelVoices = voicesForModel(ttsProvider, activeModel || (ttsProvider && ttsProvider.defaultModel));
      return html`
        <div class="head">
          <glk-button size="sm" variant="tertiary" onclick="${(host) => navigate(host, "agents")}">
            ← Zurück
          </glk-button>
          <glk-title style="font-size:20px">${title}</glk-title>
          ${agentId &&
          html`
            <glk-button
              class="head-action"
              size="sm"
              variant="tertiary"
              disabled="${busy}"
              title="Als neuen Agenten duplizieren"
              aria-label="Agent duplizieren"
              onclick="${(host) => cloneAgent(host)}"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                style="width:18px;height:18px;display:block"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </glk-button>
          `}
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
                  onglk-change="${(host, e) => selectVoiceProvider(host, e.detail.value)}"
                >
                  <option value="deepgram">Deepgram Voice Agent</option>
                  <option value="native">Native (STT→LLM→TTS-Kaskade, Flux + Aura)</option>
                  <option value="duplex">Duplex — experimentell (Native + Gesprächsführung)</option>
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
                  label="${f.greetingPrompt.trim() ? "Begrüßung (Rückfall)" : "Begrüßung"}"
                  value="${f.greeting}"
                  onglk-input="${(host, e) => setField(host, "greeting", e.detail.value)}"
                ></glk-input>
                ${f.greetingPrompt.trim()
                  ? html`<div class="empty-hint">
                      Wird nur gesprochen, wenn die Erzeugung unten scheitert oder zu lange
                      braucht.
                    </div>`
                  : ""}

                <glk-textarea
                  label="Begrüßungs-Prompt (optional)"
                  rows="2"
                  value="${f.greetingPrompt}"
                  onglk-input="${(host, e) => setField(host, "greetingPrompt", e.detail.value)}"
                ></glk-textarea>
                <div class="empty-hint">
                  Anweisung statt festem Text — für Eröffnungen, die nicht konstant sind
                  (Tageszeit, wechselnde Angaben). Der Satz entsteht je Anruf, in der Sprache
                  des Anrufers, noch während es klingelt. Leer lassen = feste Begrüßung oben.
                </div>

                <glk-select
                  id="contentLanguageSelect"
                  label="Sprache der Ansagen"
                  onglk-change="${(host, e) => setField(host, "contentLanguage", e.detail.value)}"
                >
                  <option value="">Automatisch erkennen</option>
                  ${CONTENT_LANGUAGES.map(
                    (l) => html`<option value="${l.code}">${l.label} (${l.code})</option>`,
                  )}
                </glk-select>
                <div class="empty-hint">
                  In welcher Sprache Begrüßung und Ansagen oben geschrieben sind — die
                  Ausgangssprache jeder Übersetzung. „Automatisch erkennen" ermittelt sie beim
                  Speichern aus Begrüßung und System-Prompt und trägt sie hier ein.
                </div>

                <glk-textarea
                  label="System-Prompt"
                  rows="4"
                  value="${f.prompt}"
                  onglk-input="${(host, e) => setField(host, "prompt", e.detail.value)}"
                ></glk-textarea>

                <glk-select
                  id="speakProviderSelect"
                  label="TTS-Provider (speak.provider)"
                  onglk-change="${(host, e) => selectProvider(host, host.ttsProviders, e.detail.value)}"
                >
                  ${pathProviders.map((p) => html`<option value="${p.id}">${p.label}</option>`)}
                </glk-select>

                ${ttsProvider &&
                html`
                  <div class="empty-hint">
                    <strong>${residencyBadge.text}</strong> — ${ttsProvider.residencyNote}
                    ${ttsProvider.costNote ? html` ${ttsProvider.costNote}` : ""}
                  </div>
                `}
                ${ttsProvider && !ttsProvider.configured
                  ? html`
                      <div class="empty-hint">
                        Achtung: <code>${ttsProvider.envKey}</code> ist auf dem Server nicht
                        gesetzt — Anrufe fallen mit Warnung auf die Deepgram-Stimme zurück.
                      </div>
                    `
                  : ""}
                ${f.voiceProvider !== "native"
                  ? html`
                      <div class="empty-hint">
                        Der Deepgram-Voice-Agent reicht nur eigene Stimmen und ElevenLabs durch.
                        Für Mistral Voxtral und die übrigen Engines den Voice-Provider auf
                        „Native" stellen.
                      </div>
                    `
                  : ""}

                ${ttsProvider &&
                html`
                  <glk-select
                    id="speakModelSelect"
                    label="Modell (speak.model)"
                    onglk-change="${(host, e) => setByProvider(host, "modelBy", e.detail.value)}"
                  >
                    ${ttsProvider.modelFreeText ? html`<option value="">— eigenes Modell —</option>` : ""}
                    ${ttsProvider.models.map(
                      (m) => html`<option value="${m.id}">${m.label}</option>`,
                    )}
                  </glk-select>
                `}
                ${ttsProvider && ttsProvider.modelFreeText
                  ? html`
                      <glk-input
                        label="Eigene Modell-ID (optional)"
                        value="${activeModel}"
                        placeholder="${ttsProvider.defaultModel}"
                        hint="Überschreibt die Auswahl oben — der Katalog listet nur eine Auswahl."
                        onglk-input="${(host, e) => setByProvider(host, "modelBy", e.detail.value)}"
                      ></glk-input>
                    `
                  : ""}

                ${modelVoices.length
                  ? html`
                      <glk-select
                        id="speakVoiceSelect"
                        label="Stimme (speak.voice)"
                        onglk-change="${(host, e) => setByProvider(host, "voiceBy", e.detail.value)}"
                      >
                        <option value="">— eigene Stimm-ID unten —</option>
                        ${modelVoices.map(
                          (v) => html`<option value="${v.id}">${v.label} · ${v.id}</option>`,
                        )}
                      </glk-select>
                    `
                  : ""}
                ${ttsProvider && ttsProvider.voiceFreeText
                  ? html`
                      <glk-input
                        label="${modelVoices.length ? "Eigene/geklonte Stimm-ID" : "Stimm-ID (speak.voice)"}"
                        value="${activeVoice}"
                        placeholder="${f.speakProvider === "eleven_labs"
                          ? "z. B. 21m00Tcm4TlvDq8ikWAM"
                          : "ID einer eigenen oder geklonten Stimme"}"
                        hint="API-Key kommt aus dem Server-Env — nie aus der Datenbank."
                        onglk-input="${(host, e) => setByProvider(host, "voiceBy", e.detail.value)}"
                      ></glk-input>
                    `
                  : ""}

                ${knobActive(ttsProvider, "stability") || knobActive(ttsProvider, "speed")
                  ? html`
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
                  : ""}

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

                <glk-input
                  label="Ansage bei fehlgeschlagener Weiterleitung"
                  value="${f.transferFailedAnnouncement}"
                  placeholder="Ich konnte leider niemanden erreichen. Wir machen zusammen weiter."
                  onglk-input="${(host, e) => setField(host, "transferFailedAnnouncement", e.detail.value)}"
                ></glk-input>
                <div class="empty-hint">
                  Wird gesprochen, wenn eine Weiterleitung niemanden erreicht. Leer = Standardtext. Bei
                  mehrsprachigen Agenten (STT „multi") automatisch in die Anrufersprache übersetzt.
                </div>

                <glk-toggle
                  label="Filler-Ansagen bei Tool-Wartezeiten (nur native)"
                  checked="${f.fillersEnabled}"
                  onglk-change="${(host, e) => setField(host, "fillersEnabled", e.detail.checked)}"
                ></glk-toggle>
                ${f.fillersEnabled &&
                html`
                  <glk-input
                    label="Verzögerung bis zur Ansage (ms)"
                    type="number"
                    value="${f.fillersDelayMs}"
                    onglk-input="${(host, e) => setField(host, "fillersDelayMs", e.detail.value)}"
                  ></glk-input>
                  <glk-textarea
                    label="Filler-Ansagen (eine pro Zeile)"
                    rows="3"
                    value="${f.fillersPhrases}"
                    placeholder="Einen Moment bitte."
                    onglk-input="${(host, e) => setField(host, "fillersPhrases", e.detail.value)}"
                  ></glk-textarea>
                  <div class="empty-hint">
                    Kurze Ansage, wenn ein langsames Tool (z. B. CRM-Abfrage) sonst zu Stille führt —
                    rotierend aus dem Pool, nicht bei Auflegen/Weiterleitung. Nur in der Standardsprache
                    pflegen; die Übersetzung in die Anrufersprache passiert automatisch zur Laufzeit.
                  </div>
                `}

                <glk-toggle
                  label="Nachfassen, wenn der Anrufer schweigt"
                  checked="${f.idleEnabled}"
                  onglk-change="${(host, e) => setField(host, "idleEnabled", e.detail.checked)}"
                ></glk-toggle>
                ${f.idleEnabled &&
                html`
                  <glk-input
                    label="Stille bis zur ersten Ansage (ms)"
                    type="number"
                    value="${f.idleTimeoutMs}"
                    hint="3000–60000; spätere Stufen warten automatisch länger"
                    onglk-input="${(host, e) => setField(host, "idleTimeoutMs", e.detail.value)}"
                  ></glk-input>
                  <glk-input
                    label="Ansagen pro Stille-Phase"
                    type="number"
                    value="${f.idleMaxPrompts}"
                    hint="1–5; spricht der Anrufer, beginnt die Leiter wieder von vorn"
                    onglk-input="${(host, e) => setField(host, "idleMaxPrompts", e.detail.value)}"
                  ></glk-input>
                  <glk-textarea
                    label="Stille-Ansagen (eine pro Zeile = Eskalationsstufe)"
                    rows="3"
                    value="${f.idlePhrases}"
                    placeholder="Sind Sie noch da?"
                    onglk-input="${(host, e) => setField(host, "idlePhrases", e.detail.value)}"
                  ></glk-textarea>
                  <div class="empty-hint">
                    Zeile 1 ist die erste, sanfte Nachfrage, Zeile 2 die nächste Stufe usw. Die Abstände
                    wachsen dabei automatisch. Schweigt während einer Tool-Wartezeit oder Weiterleitung.
                    Nur in der Standardsprache pflegen; die Übersetzung in die Anrufersprache passiert
                    automatisch zur Laufzeit.
                  </div>
                  <glk-toggle
                    label="Nach der letzten Ansage auflegen"
                    checked="${f.idleHangupAfter}"
                    onglk-change="${(host, e) => setField(host, "idleHangupAfter", e.detail.checked)}"
                  ></glk-toggle>
                  ${f.idleHangupAfter &&
                  html`
                    <glk-input
                      label="Abschiedsansage vor dem Auflegen"
                      value="${f.idleHangupAnnouncement}"
                      placeholder="Ich melde mich dann ab. Rufen Sie gern noch einmal an."
                      hint="Leer = Standardtext; wird zu Ende gesprochen, bevor die Leitung fällt"
                      onglk-input="${(host, e) =>
                        setField(host, "idleHangupAnnouncement", e.detail.value)}"
                    ></glk-input>
                    <div class="empty-hint">
                      Beendet liegengelassene Anrufe (stummes Headset, Handy in der Tasche) statt sie
                      bis zum Auflegen der Gegenseite laufen zu lassen.
                    </div>
                  `}
                `}

                <glk-toggle
                  label="Sprache des Anrufers merken"
                  checked="${f.callerMemoryLanguage}"
                  onglk-change="${(host, e) =>
                    setField(host, "callerMemoryLanguage", e.detail.checked)}"
                ></glk-toggle>
                <div class="empty-hint">
                  Hält nach dem Gespräch fest, welche Sprache der Anrufer gesprochen hat — beim
                  nächsten Anruf derselben Nummer beginnt der Agent direkt in dieser Sprache. Die
                  Rufnummer wird dabei nur pseudonymisiert abgelegt (Hash) und verfällt automatisch.
                  Spricht der Anrufer wieder anders, gilt sofort die neue Sprache.
                </div>

                <div class="group-head">
                  <glk-button
                    size="sm"
                    variant="secondary"
                    disabled="${!agentId}"
                    onclick="${(host) => openTranslations(host)}"
                  >
                    Übersetzte Ansagen ansehen…
                  </glk-button>
                  <span class="empty-hint">${translationSummary(agentId, translations)}</span>
                </div>

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
                    Nur diese Websites dürfen das Widget einbetten und eine Session holen
                    (CSP frame-ancestors + Origin-Prüfung). Die Appliance-Domain selbst ist
                    immer erlaubt (Demo-Seite). <code>https://*.kunde.de</code> deckt
                    Unterdomänen ab, nicht die Domäne selbst.
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
                  label="Gespräch aufzeichnen"
                  checked="${f.recordingEnabled}"
                  onglk-change="${(host, e) => setField(host, "recordingEnabled", e.detail.checked)}"
                ></glk-toggle>
                ${!f.recordingEnabled
                  ? html`<div class="empty-hint">
                      Ohne Aufnahme entsteht kein Mitschnitt in der Anrufliste. Im
                      Passthrough-Modus entfällt damit auch das Transkript — es wird dort aus
                      der Aufnahme erzeugt.
                    </div>`
                  : ""}

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
                title="Übersetzte Ansagen"
                open="${translationsOpen}"
                onglk-close="${(host) => {
                  host.translationsOpen = false;
                }}"
              >
                <div class="tool-form">
                  ${renderTranslations(translations, translationLang, f)}
                </div>
                <div slot="actions">
                  <button
                    class="glass-modal__action"
                    disabled="${translationsBusy || !translationLang}"
                    onclick="${(host) => regenerateTranslation(host)}"
                  >${translationsBusy ? "Erzeuge…" : "Neu erzeugen"}</button>
                  <button
                    class="glass-modal__action"
                    onclick="${(host) => {
                      host.translationsOpen = false;
                    }}"
                  >Schließen</button>
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

                    <glk-input
                      label="Filler-Ansage (optional, nur native)"
                      value="${toolDraft.fillerPhrase}"
                      placeholder="Ich werfe einen Blick in den Kalender…"
                      hint="Wird gesprochen, wenn dieses Tool länger braucht; zur Laufzeit übersetzt. Leer = allgemeiner Filler-Pool."
                      onglk-input="${(host, e) => setDraft(host, "fillerPhrase", e.detail.value)}"
                    ></glk-input>

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
        /* Duplizieren sitzt rechts außen; der Titel dazwischen darf umbrechen statt zu drücken. */
        .head glk-title { flex: 1 1 auto; min-width: 0; }
        .head-action { flex: 0 0 auto; margin-left: auto; }
        .form { display: flex; flex-direction: column; gap: 14px; }
        .group-label { font-size: 13px; opacity: 0.75; }
        .group-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .empty-hint { font-size: 13px; opacity: 0.55; }
        .tool-form { display: flex; flex-direction: column; gap: 10px; max-height: 60vh; overflow-y: auto; padding-right: 4px; }
        .hdr-row { display: grid; grid-template-columns: 1fr 1.4fr auto; gap: 8px; align-items: center; }
        .tr-entry { display: flex; flex-direction: column; gap: 4px; padding: 10px 0; border-top: 1px solid rgba(128,128,128,.22); }
        .tr-head { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; }
        .tr-stale { font-size: 12px; opacity: .85; white-space: nowrap; }
        .tr-line { display: flex; gap: 8px; align-items: baseline; line-height: 1.45; }
        .tr-lang { flex: 0 0 auto; font-size: 11px; letter-spacing: .06em; opacity: .6; min-width: 2.2em; }
        .tr-missing { opacity: .6; }
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
        ["speakModelSelect", host.form.modelBy[host.form.speakProvider]],
        ["ambiencePresetSelect", host.form.ambiencePreset],
        ["toolMethodSelect", host.toolDraft && host.toolDraft.method],
        ["translationLangSelect", host.translationLang],
      ];
      for (const [id, value] of selects) {
        const sel = host.shadowRoot && host.shadowRoot.getElementById(id);
        // Attribut → glk-select.onAttributeChanged('value') wendet es an;
        // wird auch von der initialen rAF-Option-Übernahme gelesen.
        if (sel && value) sel.setAttribute("value", value);
      }
      // Sonderfall: Bei „Sprache der Ansagen" ist der LEERE Wert eine gültige Auswahl
      // („Automatisch erkennen"). Ohne dieses Setzen bliebe beim Agentenwechsel der Code
      // des vorherigen Agenten stehen und würde ungewollt mitgespeichert.
      const langSel = host.shadowRoot && host.shadowRoot.getElementById("contentLanguageSelect");
      if (langSel) langSel.setAttribute("value", host.form.contentLanguage || "");
      // Dito bei der Stimmauswahl: leer heißt hier „eigene Stimm-ID im Feld darunter".
      // (glk-select ab 1.12.0 zieht die Optionsliste selbst nach und stellt den Wert
      // danach wieder her — hier genügt das value-Attribut wie bei jedem Select.)
      const voiceSel = host.shadowRoot && host.shadowRoot.getElementById("speakVoiceSelect");
      if (voiceSel) voiceSel.setAttribute("value", host.form.voiceBy[host.form.speakProvider] || "");
    },
    connect: (host) => {
      load(host);
    },
  },
});
