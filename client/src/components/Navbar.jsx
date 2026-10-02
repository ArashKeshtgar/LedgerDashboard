import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { checkSession, fetchHealth, logout } from "../api.js";

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

  return (
    <nav className="navbar navbar-dark bg-dark mb-4 app-navbar">
      <div className="container">
        <Link className="navbar-brand" to="/">
          📋 Job Application Ledger
        </Link>
        <div className="d-flex flex-wrap gap-2 align-items-center">
          <Link className={linkClass("/")} to="/">Applications</Link>
          <Link className={linkClass("/pipeline")} to="/pipeline">Pipeline</Link>
          <Link className={linkClass("/stats")} to="/stats">Stats</Link>
          <Link className={linkClass("/recruiters")} to="/recruiters">Recruiters</Link>
          <span className="navbar-divider" aria-hidden="true" />
          <Link className={linkClass("/truth")} to="/truth">Truth Bank</Link>
          <Link className={linkClass("/gaps")} to="/gaps">Gaps</Link>
          <Link className={linkClass("/resume")} to="/resume">Résumé</Link>
          <Link className={linkClass("/health")} to="/health">
            Health
            {alerts > 0 && (
              <span className={`badge rounded-pill ms-1 ${health.error ? "bg-danger" : "bg-warning text-dark"}`}>{alerts}</span>
            )}
          </Link>
          {passwordRequired && (
            <button
              type="button"
              className="btn btn-sm btn-outline-light rounded-pill ms-2"
              onClick={() => logout().then(() => window.location.reload())}
            >
              Log out
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
