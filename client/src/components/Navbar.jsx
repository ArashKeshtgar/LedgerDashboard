import { Link, useLocation } from "react-router-dom";

export default function Navbar() {
  const { pathname } = useLocation();
  const linkClass = (path) =>
    "nav-link" + (pathname === path ? " active fw-semibold text-white" : " text-white-50");

  return (
    <nav className="navbar navbar-dark bg-dark mb-4 app-navbar">
      <div className="container">
        <Link className="navbar-brand" to="/">
          📋 Job Application Ledger
        </Link>
        <div className="d-flex gap-2">
          <Link className={linkClass("/")} to="/">Applications</Link>
          <Link className={linkClass("/pipeline")} to="/pipeline">Pipeline</Link>
          <Link className={linkClass("/stats")} to="/stats">Stats</Link>
          <Link className={linkClass("/recruiters")} to="/recruiters">Recruiters</Link>
        </div>
      </div>
    </nav>
  );
}
