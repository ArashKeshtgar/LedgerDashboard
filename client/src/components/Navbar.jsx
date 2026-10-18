import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { checkSession, fetchHealth, fetchRejectionCount, fetchUsage, logout } from "../api.js";
import { usd } from "../costs.js";

export default function Navbar() {
  const { pathname } = useLocation();
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [health, setHealth] = useState(null);
  const linkClass = (path) =>
    "nav-link" +
    (pathname === path || pathname.startsWith(`${path}/`) ? " active fw-semibold text-white" : " text-white-50");

  useEffect(() => {
    checkSession().then((s) => setPasswordRequired(!!s.passwordRequired)).catch(() => {});
  }, []);

  // Errors + warnings across the truth bank, gaps, templates and drafts —
  // refreshed on every page change and whenever the Health page re-checks.
  useEffect(() => {
    const refresh = () => fetchHealth().then((h) => setHealth(h.counts)).catch(() => {});
    refresh();
    window.addEventListener("health-changed", refresh);
    return () => window.removeEventListener("health-changed", refresh);
  }, [pathname]);
  const alerts = health ? health.error + health.warn : 0;

  // This month's Claude spend next to the Costs link, coloured as it nears
  // the budget; refreshed on every page change (builds happen on other pages).
  const [spend, setSpend] = useState(null);
  useEffect(() => {
    fetchUsage().then((u) => setSpend(u)).catch(() => {});
  }, [pathname]);
  const spendPct = spend ? spend.usd / spend.budget : 0;

  // Postings the nightly run turned down that haven't been reviewed yet.
  const [rejected, setRejected] = useState(0);
  useEffect(() => {
    const refresh = () => fetchRejectionCount().then((r) => setRejected(r.unreviewed)).catch(() => {});
    refresh();
    window.addEventListener("rejections-changed", refresh);
    return () => window.removeEventListener("rejections-changed", refresh);
  }, [pathname]);

  // Below the xxl breakpoint (1400px) the links fold into a menu behind the ☰ button,
  // so on a phone the navbar is one row instead of half the screen. Bootstrap's
  // JS isn't loaded; React toggles the `show` class itself, and picking a link
  // closes the menu again.
  const [menuOpen, setMenuOpen] = useState(false);
  const closeOnLink = (e) => {
    if (e.target.closest("a")) setMenuOpen(false);
  };

  return (
    <nav className="navbar navbar-expand-xxl navbar-dark bg-dark mb-4 app-navbar">
      <div className="container">
        <Link className="navbar-brand d-flex align-items-center gap-2" to="/" onClick={() => setMenuOpen(false)}>
          <img src="/favicon.svg" alt="" width="30" height="30" className="app-logo" />
          <span className="d-none d-sm-inline">Job Application Ledger</span>
          <span className="d-sm-none">Ledger</span>
        </Link>
        <div className="d-flex align-items-center gap-2 order-xxl-last">
          <button
            type="button"
            className="btn btn-sm btn-light rounded-pill text-nowrap assistant-launch"
            title="AI assistant: today's briefing, or ask about your applications"
            onClick={() => window.dispatchEvent(new Event("assistant-open"))}
          >
            ✨ Ask AI
          </button>
          <button
            type="button"
            className="navbar-toggler position-relative"
            aria-controls="app-nav-links"
            aria-expanded={menuOpen}
            aria-label="Menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className="navbar-toggler-icon" />
            {alerts > 0 && !menuOpen && (
              <span
                className={`position-absolute top-0 start-100 translate-middle p-1 rounded-circle ${health.error ? "bg-danger" : "bg-warning"}`}
              />
            )}
          </button>
        </div>
        <div className={`collapse navbar-collapse${menuOpen ? " show" : ""}`} id="app-nav-links" onClick={closeOnLink}>
          <div className="navbar-nav app-nav-links ms-xxl-auto">
            <Link className={linkClass("/")} to="/">Applications</Link>
            <Link className={linkClass("/pipeline")} to="/pipeline">Pipeline</Link>
            <Link className={linkClass("/stats")} to="/stats">Stats</Link>
            <Link className={linkClass("/funnel")} to="/funnel">Funnel</Link>
            <Link className={linkClass("/rejections")} to="/rejections">
              Rejected
              {rejected > 0 && <span className="badge rounded-pill ms-1 bg-secondary">{rejected}</span>}
            </Link>
            <Link className={linkClass("/recruiters")} to="/recruiters">Recruiters</Link>
            <span className="navbar-divider" aria-hidden="true" />
            <Link className={linkClass("/truth")} to="/truth">Truth Bank</Link>
            <Link className={linkClass("/gaps")} to="/gaps">Gaps</Link>
            <Link className={linkClass("/resume")} to="/resume">Résumé</Link>
            <Link className={linkClass("/eval")} to="/eval">Evaluation</Link>
            <Link className={linkClass("/costs")} to="/costs">
              Costs
              {spend && (
                <span className={`badge rounded-pill ms-1 ${spendPct >= 1 ? "bg-danger" : spendPct >= 0.8 ? "bg-warning text-dark" : "bg-secondary"}`}>
                  {usd(spend.usd)}
                </span>
              )}
            </Link>
            <Link className={linkClass("/health")} to="/health">
              Health
              {alerts > 0 && (
                <span className={`badge rounded-pill ms-1 ${health.error ? "bg-danger" : "bg-warning text-dark"}`}>{alerts}</span>
              )}
            </Link>
            {passwordRequired && (
              <button
                type="button"
                className="btn btn-sm btn-outline-light rounded-pill ms-xxl-2 app-nav-logout"
                onClick={() => logout().then(() => window.location.reload())}
              >
                Log out
              </button>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
