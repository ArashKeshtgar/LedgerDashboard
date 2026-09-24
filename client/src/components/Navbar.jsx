import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { checkSession, logout } from "../api.js";

export default function Navbar() {
  const { pathname } = useLocation();
  const [passwordRequired, setPasswordRequired] = useState(false);
  const linkClass = (path) =>
    "nav-link" + (pathname === path ? " active fw-semibold text-white" : " text-white-50");

  useEffect(() => {
    checkSession().then((s) => setPasswordRequired(!!s.passwordRequired)).catch(() => {});
  }, []);

  return (
    <nav className="navbar navbar-dark bg-dark mb-4 app-navbar">
      <div className="container">
        <Link className="navbar-brand" to="/">
          📋 Job Application Ledger
        </Link>
        <div className="d-flex gap-2 align-items-center">
          <Link className={linkClass("/")} to="/">Applications</Link>
          <Link className={linkClass("/pipeline")} to="/pipeline">Pipeline</Link>
          <Link className={linkClass("/stats")} to="/stats">Stats</Link>
          <Link className={linkClass("/recruiters")} to="/recruiters">Recruiters</Link>
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
