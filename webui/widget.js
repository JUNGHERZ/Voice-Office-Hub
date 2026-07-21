/**
 * Voice-Office-Hub — einbettbarer Widget-Loader (keine Dependencies, ~120 Zeilen).
 *
 * Einbindung auf einer Kunden-Website:
 *   <script src="https://<appliance-domain>/widget.js" data-widget-key="<KEY>" async></script>
 *   Optional: data-position="bottom-left" (Default: bottom-right)
 *
 * Der Loader legt nur einen schwebenden Anruf-Button + ein iframe an. Alles
 * Sicherheitsrelevante (SIP-Credentials, Audio) lebt IM iframe auf der
 * Appliance-Origin; die Einbett-Erlaubnis erzwingt der frame-ancestors-Header
 * der Widget-Route. Das iframe meldet gedrosselt seinen Zustand (idle/connecting/
 * in-call/agent-speaking) per postMessage — rein kosmetisch für den Button-Puls.
 */
(() => {
  const script = document.currentScript;
  const key = script && script.dataset ? script.dataset.widgetKey : "";
  if (!key) {
    console.warn("[voh-widget] data-widget-key fehlt — Widget wird nicht geladen.");
    return;
  }
  let origin;
  try {
    origin = new URL(script.src).origin;
  } catch {
    console.warn("[voh-widget] Ungültige Script-URL.");
    return;
  }
  const left = script.dataset.position === "bottom-left";

  const style = document.createElement("style");
  style.textContent = `
    .voh-w-btn {
      position: fixed; bottom: 20px; ${left ? "left" : "right"}: 20px; z-index: 2147483000;
      width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
      background: #0f766e; color: #fff; font-size: 24px; line-height: 1;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25); transition: transform 150ms;
    }
    .voh-w-btn:hover { transform: scale(1.06); }
    .voh-w-btn[data-voh-state="in-call"] { background: #b42318; }
    .voh-w-btn[data-voh-state="agent-speaking"] { background: #b42318; animation: voh-pulse 1.1s ease-in-out infinite; }
    .voh-w-btn[data-voh-state="connecting"] { animation: voh-pulse 1.1s ease-in-out infinite; }
    @keyframes voh-pulse {
      0%, 100% { box-shadow: 0 4px 16px rgba(0,0,0,0.25), 0 0 0 0 rgba(180,35,24,0.45); }
      50% { box-shadow: 0 4px 16px rgba(0,0,0,0.25), 0 0 0 12px rgba(180,35,24,0); }
    }
    @media (prefers-reduced-motion: reduce) { .voh-w-btn { animation: none !important; transition: none; } }
    .voh-w-frame {
      position: fixed; bottom: 88px; ${left ? "left" : "right"}: 20px; z-index: 2147483000;
      width: 340px; height: 480px; max-height: calc(100vh - 110px);
      border: none; border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.3);
      background: transparent; display: none;
    }
    .voh-w-frame.open { display: block; }
  `;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.className = "voh-w-btn";
  btn.type = "button";
  btn.title = "Sprach-Assistent";
  btn.textContent = "🎙";
  btn.setAttribute("aria-label", "Sprach-Assistent öffnen");

  let frame = null;
  let open = false;

  function ensureFrame() {
    if (frame) return frame;
    frame = document.createElement("iframe");
    frame.className = "voh-w-frame";
    frame.src = origin + "/widget/" + encodeURIComponent(key);
    frame.allow = "microphone; autoplay";
    frame.title = "Sprach-Assistent";
    document.body.appendChild(frame);
    return frame;
  }

  btn.addEventListener("click", () => {
    // Wichtig: Schließen versteckt nur — ein laufender Anruf lebt im iframe weiter
    // (Button pulsiert dann weiter als Erinnerung).
    open = !open;
    ensureFrame().classList.toggle("open", open);
    btn.setAttribute("aria-label", open ? "Sprach-Assistent minimieren" : "Sprach-Assistent öffnen");
  });

  window.addEventListener("message", (e) => {
    if (e.origin !== origin) return; // nur unser eigenes iframe
    const data = e.data;
    if (data && data.voh === "state" && typeof data.state === "string") {
      btn.dataset.vohState = data.state;
    }
  });

  document.body.appendChild(btn);
})();
