/*
 * Bootstrap der Admin-SPA:
 *  - Auth-Check (/api/me) → Login-Gate oder App.
 *  - Eigener, synchroner View-Router mit Container-Swap im
 *    document.startViewTransition()-Callback (Progressive Enhancement).
 *  - Persistentes Chrome: Header (Brand + Theme-Toggle + Logout) + Floating Tab-Bar.
 *  - Theme-Persistenz in localStorage.
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

// ---- View-Erzeugung -------------------------------------------------------

// Bereiche, die in der Tab-Bar einen aktiven Reiter haben.
const TAB_FOR_VIEW = {
  dashboard: "dashboard",
  agents: "agents",
  "agent": "agents",
  "agent-new": "agents",
  requests: "requests",
  request: "requests",
};

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
    <span class="app-head__brand"><span class="glass-avatar glass-avatar--sm">EV</span> Voice Hub</span>
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

// Wechselt den Inhalt der App-Spalte (mit View Transition, falls verfügbar).
function swapContent(col, tabbar, view, id) {
  const el = createView(view, id);
  const doSwap = () => {
    col.replaceChildren(el);
    tabbar.active = TAB_FOR_VIEW[view] || "dashboard";
  };
  if (document.startViewTransition) {
    document.startViewTransition(doSwap);
  } else {
    doSwap();
  }
  current = { view, id: id || null };
}

// Zentrale Navigation.
function navigate(view, id) {
  if (!shell) return;
  swapContent(shell.col, shell.tabbar, view, id);
}

// ---- Auth-Flows -----------------------------------------------------------

async function logout() {
  try {
    await api.logout();
  } catch {
    /* ignore */
  }
  showLogin();
}

function showLogin() {
  shell = null;
  current = { view: "dashboard", id: null };
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

function showApp() {
  const swap = () => {
    shell = renderShell();
    const el = createView(current.view, current.id);
    shell.col.replaceChildren(el);
    shell.tabbar.active = TAB_FOR_VIEW[current.view] || "dashboard";
  };
  if (document.startViewTransition) document.startViewTransition(swap);
  else swap();
}

// ---- Event-Bus ------------------------------------------------------------

// Views feuern "navigate" (Ziel-View) und "auth-changed" (nach Login).
root.addEventListener("navigate", (e) => {
  const { view, id } = e.detail || {};
  if (view) navigate(view, id);
});
root.addEventListener("auth-changed", () => {
  showApp();
});

// ---- Start ----------------------------------------------------------------

async function start() {
  initTheme();
  try {
    await api.me();
    showApp();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      showLogin();
    } else {
      // Im Zweifel Login zeigen.
      showLogin();
    }
  }
}

start();
