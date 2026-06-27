/*
 * Bootstrap der Admin-SPA:
 *  - Auth-Check (/api/me) → Login-Gate oder App.
 *  - Eigener, synchroner View-Router mit Container-Swap im
 *    document.startViewTransition()-Callback (Progressive Enhancement).
 *  - Hash-basiertes Routing (#/dashboard, #/agents, #/agents/new, #/agents/:id,
 *    #/requests, #/requests/:id) inkl. Deep-Links, Vor/Zurück (hashchange) und
 *    Post-Login-Redirect zur ursprünglich angefragten URL.
 *  - Persistentes Chrome: Header (Brand + Theme-Toggle + Logout) + Floating Tab-Bar.
 *  - Theme-Persistenz in localStorage. App-Shell-Cache via Service Worker.
 *
 * Routing-Variante: HASH. Der statische Server (@fastify/static) liefert keinen
 * SPA-Fallback für Tiefen-Pfade (/requests/123 → 404), daher ist Hash-Routing
 * die ohne Backend-Änderung zuverlässige, sofort teilbare/deeplinkbare Wahl.
 *
 * Bewusst KEIN async Hybrids-Router: Der Top-Level-Swap muss synchron im
 * View-Transition-Callback passieren. Die einzelnen Views sind Hybrids-Komponenten
 * (Reaktivität/Rendering) und werden per document.createElement eingesetzt.
 */
import { api, UnauthorizedError } from "./api.js";

// View-Definitionen registrieren (Seiteneffekt: define()).
import "./app-tabbar.js";
import "./views/login-view.js";
import "./views/dashboard-view.js";
import "./views/agents-view.js";
import "./views/agent-form-view.js";
import "./views/requests-view.js";
import "./views/request-detail-view.js";

// ---- Theme ----------------------------------------------------------------

const THEME_KEY = "vh_theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

function initTheme() {
  let theme = "dark";
  try {
    theme = localStorage.getItem(THEME_KEY) || "dark";
  } catch {
    /* ignore */
  }
  document.documentElement.setAttribute("data-theme", theme);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "dark" ? "light" : "dark");
}

// ---- Routing (hash-basiert) -----------------------------------------------

// Bereiche, die in der Tab-Bar einen aktiven Reiter haben.
const TAB_FOR_VIEW = {
  dashboard: "dashboard",
  agents: "agents",
  agent: "agents",
  "agent-new": "agents",
  requests: "requests",
  request: "requests",
};

// Route ({view,id}) → Hash-Pfad (ohne führendes "#").
function routeToPath({ view, id }) {
  switch (view) {
    case "dashboard":
      return "/dashboard";
    case "agents":
      return "/agents";
    case "agent-new":
      return "/agents/new";
    case "agent":
      return `/agents/${id || ""}`;
    case "requests":
      return "/requests";
    case "request":
      return `/requests/${id || ""}`;
    default:
      return "/dashboard";
  }
}

// Hash → Route ({view,id}). Unbekannt → Dashboard.
function parseHash(hash) {
  // "#/requests/123" → ["requests","123"]
  const raw = (hash || "").replace(/^#/, "").replace(/^\//, "");
  const parts = raw.split("/").filter(Boolean);
  const [seg, sub] = parts;
  switch (seg) {
    case undefined:
    case "":
    case "dashboard":
      return { view: "dashboard", id: null };
    case "agents":
      if (sub === "new") return { view: "agent-new", id: null };
      if (sub) return { view: "agent", id: sub };
      return { view: "agents", id: null };
    case "requests":
      if (sub) return { view: "request", id: sub };
      return { view: "requests", id: null };
    default:
      return { view: "dashboard", id: null };
  }
}

// Aktuelle Route aus der URL lesen.
function currentRoute() {
  return parseHash(window.location.hash);
}

// Erzeugt das passende View-Element für eine Route.
function createView(view, id) {
  switch (view) {
    case "dashboard":
      return document.createElement("dashboard-view");
    case "agents":
      return document.createElement("agents-view");
    case "agent": {
      const el = document.createElement("agent-form-view");
      el.agentId = id || "";
      return el;
    }
    case "agent-new":
      return document.createElement("agent-form-view");
    case "requests":
      return document.createElement("requests-view");
    case "request": {
      const el = document.createElement("request-detail-view");
      el.requestId = id || "";
      return el;
    }
    default:
      return document.createElement("dashboard-view");
  }
}

// ---- App-Shell ------------------------------------------------------------

const root = document.getElementById("app");
let current = { view: "dashboard", id: null };
let authed = false;
// Ziel, das vor dem Login angefragt wurde (Deep-Link), für Redirect nach Login.
let pendingRoute = null;
// Verhindert, dass programmatische Hash-Änderungen den hashchange-Handler doppelt feuern.
let suppressHashChange = false;

// SVG-Helfer für die Header-Pills.
function svg(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px">${paths}</svg>`;
}

function renderShell() {
  root.innerHTML = "";

  // Header (Light DOM, GlassKit-Klassen).
  const head = document.createElement("div");
  head.className = "app-head";
  head.innerHTML = `
    <a class="app-head__brand" href="#/dashboard"><span class="glass-avatar glass-avatar--sm">EV</span> Voice Hub</a>
    <span class="app-head__actions">
      <button class="glass-theme-toggle" id="themeToggle" aria-label="Theme wechseln">
        <svg class="icon-moon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        <svg class="icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
      </button>
      <button class="glass-pill" id="logoutBtn" aria-label="Abmelden">
        ${svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>')}
      </button>
    </span>
  `;
  head.querySelector("#themeToggle").addEventListener("click", toggleTheme);
  head.querySelector("#logoutBtn").addEventListener("click", logout);
  root.appendChild(head);

  // Inhalts-Spalte.
  const col = document.createElement("div");
  col.className = "app-col";
  root.appendChild(col);

  // Floating Tab-Bar.
  const tabbar = document.createElement("app-tabbar");
  tabbar.active = TAB_FOR_VIEW[current.view] || "dashboard";
  root.appendChild(tabbar);

  return { col, tabbar };
}

let shell = null;

// Rendert die aktuelle Route in die App-Spalte (mit View Transition, falls verfügbar).
function renderRoute(view, id) {
  current = { view, id: id || null };
  const el = createView(view, id);
  const doSwap = () => {
    if (!shell) shell = renderShell();
    shell.col.replaceChildren(el);
    shell.tabbar.active = TAB_FOR_VIEW[view] || "dashboard";
  };
  if (document.startViewTransition) {
    document.startViewTransition(doSwap);
  } else {
    doSwap();
  }
}

// Setzt den Hash (erzeugt einen History-Eintrag). Der hashchange-Handler
// rendert anschließend; daher wird hier NICHT direkt gerendert.
function setHash(route, { replace = false } = {}) {
  const path = "#" + routeToPath(route);
  if (window.location.hash === path) {
    // Hash identisch → kein hashchange. Direkt rendern (z. B. erneuter Klick).
    renderRoute(route.view, route.id);
    return;
  }
  if (replace) {
    suppressHashChange = true;
    const url = window.location.pathname + window.location.search + path;
    window.history.replaceState(null, "", url);
    suppressHashChange = false;
    renderRoute(route.view, route.id);
  } else {
    window.location.hash = path; // → hashchange → renderRoute
  }
}

// Zentrale Navigation (von Views via "navigate"-Event aufgerufen).
function navigate(view, id) {
  if (!authed) return;
  setHash({ view, id });
}

// ---- Auth-Flows -----------------------------------------------------------

async function logout() {
  try {
    await api.logout();
  } catch {
    /* ignore */
  }
  authed = false;
  showLogin();
}

function showLogin() {
  shell = null;
  const swap = () => {
    root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "app-col";
    wrap.appendChild(document.createElement("login-view"));
    root.appendChild(wrap);
  };
  if (document.startViewTransition) document.startViewTransition(swap);
  else swap();
}

// Zeigt die App und rendert die angefragte (oder aktuelle) Route.
function showApp(route) {
  authed = true;
  shell = null;
  const target = route || currentRoute();
  // URL mit der Zielroute synchronisieren (ohne zusätzlichen History-Eintrag).
  setHash(target, { replace: true });
}

// ---- Event-Bus ------------------------------------------------------------

// Views feuern "navigate" (Ziel-View) und "auth-changed" (nach Login).
root.addEventListener("navigate", (e) => {
  const { view, id } = e.detail || {};
  if (view) navigate(view, id);
});
root.addEventListener("auth-changed", () => {
  // Nach Login zur ursprünglich angefragten URL zurück (Deep-Link merken).
  const target = pendingRoute || currentRoute();
  pendingRoute = null;
  showApp(target);
});

// Vor/Zurück-Buttons (und programmatische Hash-Änderungen).
window.addEventListener("hashchange", () => {
  if (suppressHashChange) return;
  if (!authed) return; // im Login-Gate ignorieren
  const route = currentRoute();
  renderRoute(route.view, route.id);
});

// ---- Start ----------------------------------------------------------------

async function start() {
  initTheme();
  registerServiceWorker();
  // Angefragte Route (Deep-Link) merken, bevor evtl. das Login-Gate greift.
  const requested = currentRoute();
  try {
    await api.me();
    showApp(requested);
  } catch (e) {
    void e; // egal welcher Fehler → Login-Gate
    pendingRoute = requested;
    showLogin();
  }
}

// ---- Service Worker -------------------------------------------------------

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* SW ist Progressive Enhancement — Fehler ignorieren */
    });
  });
}

start();
