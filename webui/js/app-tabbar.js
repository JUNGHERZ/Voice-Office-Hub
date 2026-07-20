/*
 * Floating Tab-Bar (iOS-Stil) als persistentes Chrome. Bewusst im Light DOM
 * gerendert (shadow:false), damit die globalen GlassKit-Klassen (glass-tab-bar*)
 * greifen und der Host global per app.css positioniert + mit view-transition-name
 * versehen werden kann.
 *
 * Property "active" = aktueller Bereich ("dashboard" | "agents" | "requests").
 * Klick feuert "navigate" mit dem Ziel-View.
 */
import { define, html } from "hybrids";

const ICONS = {
  dashboard: html`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>`,
  live: html`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>`,
  agents: html`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  requests: html`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
};

function go(host, view) {
  host.dispatchEvent(
    new CustomEvent("navigate", { detail: { view }, bubbles: true, composed: true }),
  );
}

function item(active, key, label) {
  return html`
    <button
      class="glass-tab-bar__item ${active === key ? "is-active" : ""}"
      onclick="${(host) => go(host, key)}"
    >
      <span class="glass-tab-bar__icon">${ICONS[key]}</span>
      <span class="glass-tab-bar__label">${label}</span>
    </button>
  `;
}

export default define({
  tag: "app-tabbar",
  active: "dashboard",
  render: {
    value: ({ active }) => html`
      <div class="glass-tab-bar-dock" style="position:static; transform:none; left:auto; bottom:auto;">
        <nav class="glass-tab-bar glass-tab-bar--floating">
          ${item(active, "dashboard", "Dashboard")}
          ${item(active, "live", "Live")}
          ${item(active, "agents", "Agents")}
          ${item(active, "requests", "Anrufe")}
        </nav>
      </div>
    `,
    shadow: false,
  },
});
