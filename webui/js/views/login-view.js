/*
 * Login-Gate: Passwort → POST /api/login. Bei Erfolg feuert "auth-changed",
 * worauf app.js die App lädt. Eigenständiger Screen ohne Tab-Bar/Header.
 */
import { define, html } from "hybrids";

import { api } from "../api.js";

function onInput(host, e) {
  host.password = e.detail?.value ?? "";
}

async function submit(host) {
  if (host.busy) return;
  host.error = "";
  host.busy = true;
  try {
    await api.login(host.password);
    host.dispatchEvent(new CustomEvent("auth-changed", { bubbles: true, composed: true }));
  } catch (e) {
    host.error = e && e.status === 401 ? "Falsches Passwort." : "Anmeldung fehlgeschlagen.";
  } finally {
    host.busy = false;
  }
}

function onKeydown(host, e) {
  if (e.key === "Enter") submit(host);
}

export default define({
  tag: "login-view",
  password: "",
  busy: false,
  error: "",
  render: ({ busy, error }) => html`
    <div class="wrap">
      <div class="stack">
        <glk-avatar size="lg" style="margin:8px auto 0">VOH</glk-avatar>
        <glk-title style="font-size:20px">Voice-Office-Hub</glk-title>
        <p class="muted">Admin-Anmeldung</p>
        <div style="text-align:left">
          <glk-input
            type="password"
            label="Passwort"
            placeholder="••••••••"
            onglk-input="${onInput}"
            onkeydown="${onKeydown}"
          ></glk-input>
        </div>
        ${error && html`<glk-status message="${error}"></glk-status>`}
        <glk-button variant="primary" onclick="${submit}">
          ${busy ? "Anmelden …" : "Anmelden"}
        </glk-button>
      </div>
    </div>
  `.css`
    .wrap { padding-top: 8vh; }
    .stack { display: flex; flex-direction: column; gap: 16px; text-align: center; }
    .muted { color: var(--gl-color-text-muted); margin: 0; }
  `,
});
