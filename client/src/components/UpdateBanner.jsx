import { useEffect, useState } from "react";

// A tab keeps running the JavaScript it loaded when it opened: moving between
// pages (#/...) never downloads it again. After `npm run build`, an open tab
// would silently keep the old code — which once made a fixed bug look
// unfixed. This checks whether the server now serves a different bundle and,
// if so, offers a reload.
const CHECK_EVERY_MS = 60_000;

function bundleOf(html) {
  return html.match(/assets\/index-[^"']+\.js/)?.[0] ?? null;
}

export default function UpdateBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (import.meta.env.DEV) return undefined; // Vite reloads by itself in dev
    const running = [...document.scripts].map((s) => s.getAttribute("src") || "").find((src) => bundleOf(src));
    if (!running) return undefined;
    const current = bundleOf(running);

    async function check() {
      try {
        const html = await fetch("/", { cache: "no-store" }).then((r) => r.text());
        const served = bundleOf(html);
        if (served && served !== current) setStale(true);
      } catch {
        // offline or server restarting — try again next time
      }
    }

    const timer = setInterval(check, CHECK_EVERY_MS);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="alert alert-primary d-flex flex-wrap align-items-center justify-content-between gap-2 py-2 mb-3">
      <span className="small">A newer version of the dashboard is available.</span>
      <button type="button" className="btn btn-sm btn-primary rounded-pill" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
