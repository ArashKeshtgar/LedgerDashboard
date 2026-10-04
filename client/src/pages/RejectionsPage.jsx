import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchRejections, reviewRejections } from "../api.js";

// Postings the nightly job-search run turned down, and why — read from its
// daily reports (last 90). One row per posting however many nights it came
// back. By default only postings not yet reviewed are shown; a posting the
// run turns down again after it was reviewed shows up as new. "Add anyway"
// opens the Add form pre-filled, to overrule a rule one posting at a time.

const BUCKET_LABELS = {
  "other stack": "Other main stack (Java, Python, MERN…)",
  seniority: "Seniority (8+ yrs, Lead…)",
  "low score": "Scored below the bar",
  duplicate: "Duplicate / already applied",
  "different job": "Different kind of job",
  clearance: "Security clearance",
  language: "Language (French, Mandarin…)",
  location: "Location",
  other: "Other",
};
const label = (b) => BUCKET_LABELS[b] || b;

const STAGE_LABELS = { prescreen: "pre-screen", scored: "after scoring" };
const PAGE = 30;

function searchUrl(g) {
  return g.url || `https://www.google.com/search?q=${encodeURIComponent(`${g.company} ${g.role} job`)}`;
}

function addUrl(g) {
  const q = new URLSearchParams({
    company: g.company,
    role: g.role,
    notes: `Added anyway — the nightly run rejected it on ${g.lastSeen} (${STAGE_LABELS[g.stage]}): ${g.reason || g.score || ""}`,
  });
  if (g.url) q.set("posting_url", g.url);
  return `/applications/new?${q}`;
}

// Weeks x reasons, counting NEW postings rejected each week. The last column
// compares the latest week with the average of the weeks before it.
function TrendCard({ trend }) {
  if (!trend.length) return null;
  const total = (b) => trend.reduce((s, w) => s + (w.counts[b] || 0), 0);
  const buckets = [...new Set(trend.flatMap((w) => Object.keys(w.counts)))].sort((a, b) => total(b) - total(a));
  const max = Math.max(1, ...trend.flatMap((w) => Object.values(w.counts)));
  const direction = (b) => {
    if (trend.length < 2) return "";
    const last = trend[trend.length - 1].counts[b] || 0;
    const before = trend.slice(0, -1);
    const avg = before.reduce((s, w) => s + (w.counts[b] || 0), 0) / before.length;
    if (last > avg + 0.5) return "↑";
    if (last < avg - 0.5) return "↓";
    return "→";
  };
  const shortWeek = (w) => w.slice(5).replace("-", "/");

  return (
    <details className="card mb-4">
      <summary className="card-header" style={{ cursor: "pointer" }}>
        📊 Reasons by week <span className="small text-muted">— a reason that keeps rising may be a gap worth a project</span>
      </summary>
      <div className="table-responsive">
        <table className="table table-sm mb-0 align-middle text-center">
          <thead>
            <tr>
              <th className="text-start">New postings rejected, by reason</th>
              {trend.map((w) => (
                <th key={w.week} className="small fw-normal text-muted" title={`Week of ${w.week}`}>{shortWeek(w.week)}</th>
              ))}
              <th className="small fw-normal text-muted" title="Latest week vs the average before it">Trend</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b}>
                <td className="text-start small">{label(b)}</td>
                {trend.map((w) => {
                  const n = w.counts[b] || 0;
                  return (
                    <td
                      key={w.week}
                      className="small"
                      style={n ? { background: `color-mix(in srgb, var(--bs-primary) ${Math.round(12 + (n / max) * 50)}%, transparent)` } : undefined}
                    >
                      {n || ""}
                    </td>
                  );
                })}
                <td>{direction(b)}</td>
              </tr>
            ))}
            <tr className="fw-semibold">
              <td className="text-start small">All</td>
              {trend.map((w) => <td key={w.week} className="small">{w.total}</td>)}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default function RejectionsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState("new");
  const [track, setTrack] = useState("all");
  const [bucket, setBucket] = useState("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  // Reviewed on this visit: stays on screen (faded) until the next load, so
  // a row doesn't jump away under the mouse.
  const [justReviewed, setJustReviewed] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchRejections().then(setData).catch((e) => setError(e.message));
  }, []);

  // Everything but the reason filter, so the chips can count within it.
  const scoped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.groups || []).filter(
      (g) =>
        (view === "all" || !g.reviewed || justReviewed.has(g.key)) &&
        (track === "all" || g.track === track) &&
        (!q || `${g.company} ${g.companyNote} ${g.role} ${g.reason}`.toLowerCase().includes(q))
    );
  }, [data, view, track, query, justReviewed]);

  const counts = useMemo(() => {
    const c = {};
    scoped.forEach((g) => (c[g.bucket] = (c[g.bucket] || 0) + 1));
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  }, [scoped]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <div className="text-muted">Loading…</div>;

  const filtered = scoped.filter((g) => bucket === "all" || g.bucket === bucket);
  const shown = filtered.slice(0, limit);
  const days = [];
  shown.forEach((g) => {
    const last = days[days.length - 1];
    if (last && last.date === g.lastSeen) last.items.push(g);
    else days.push({ date: g.lastSeen, items: [g] });
  });

  async function mark(keys, reviewed) {
    if (!keys.length) return;
    setBusy(true);
    try {
      const res = await reviewRejections(keys, reviewed);
      const set = new Set(keys);
      setData((d) => ({
        ...d,
        unreviewed: res.unreviewed,
        groups: d.groups.map((g) => (set.has(g.key) ? { ...g, reviewed } : g)),
      }));
      setJustReviewed((prev) => {
        const next = new Set(prev);
        keys.forEach((k) => next.add(k));
        return next;
      });
      window.dispatchEvent(new Event("rejections-changed"));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Any filter change starts the list from the top again.
  const refilter = (setter) => (value) => {
    setter(value);
    setLimit(PAGE);
  };

  return (
    <div>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h2 className="h4 mb-0">
          🚫 Rejected by the nightly run{" "}
          {data.unreviewed > 0 && (
            <span className="badge rounded-pill bg-warning text-dark fs-6 align-middle">{data.unreviewed} new</span>
          )}
        </h2>
        <div className="d-flex flex-wrap gap-2">
          <input
            type="search"
            className="form-control form-control-sm"
            style={{ width: 210 }}
            placeholder="Search company, role, reason…"
            value={query}
            onChange={(e) => refilter(setQuery)(e.target.value)}
          />
          <select className="form-select form-select-sm w-auto" value={view} onChange={(e) => refilter(setView)(e.target.value)}>
            <option value="new">Not reviewed</option>
            <option value="all">All (last 90 reports)</option>
          </select>
          <select className="form-select form-select-sm w-auto" value={track} onChange={(e) => refilter(setTrack)(e.target.value)}>
            <option value="all">All tracks</option>
            <option value="dev">💻 Developer</option>
            <option value="it">🛠️ IT</option>
          </select>
        </div>
      </div>

      <TrendCard trend={data.trend} />

      {scoped.length > 0 && (
        <div className="card mb-4">
          <div className="card-body">
            <div className="small text-muted mb-2">
              Why these {scoped.length} postings were dropped — click one to filter. Grouped from the report's own
              wording, so approximate.
            </div>
            <div className="d-flex flex-wrap gap-2">
              <button
                type="button"
                className={`btn btn-sm rounded-pill ${bucket === "all" ? "btn-dark" : "btn-outline-secondary"}`}
                onClick={() => refilter(setBucket)("all")}
              >
                All · {scoped.length}
              </button>
              {counts.map(([b, n]) => (
                <button
                  key={b}
                  type="button"
                  className={`btn btn-sm rounded-pill ${bucket === b ? "btn-dark" : "btn-outline-secondary"}`}
                  onClick={() => refilter(setBucket)(b)}
                >
                  {label(b)} · {n} ({Math.round((n / scoped.length) * 100)}%)
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="card">
          <div className="card-body text-muted">
            {view === "new" && !query && track === "all"
              ? "✅ Nothing new to review. Switch to “All” to see earlier ones."
              : "No postings match these filters."}
          </div>
        </div>
      ) : (
        days.map((day, i) => {
          const pending = day.items.filter((g) => !g.reviewed).map((g) => g.key);
          return (
            <details key={day.date} className="card mb-3" open={i === 0}>
              <summary
                className="card-header d-flex flex-wrap justify-content-between align-items-center gap-2"
                style={{ cursor: "pointer" }}
              >
                <span>
                  <strong>{day.date}</strong>{" "}
                  <span className="text-muted small">· {day.items.length} posting{day.items.length > 1 ? "s" : ""}</span>
                </span>
                {pending.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-success rounded-pill"
                    disabled={busy}
                    onClick={(e) => {
                      e.preventDefault();
                      mark(pending, true);
                    }}
                  >
                    ✓ Mark {pending.length} reviewed
                  </button>
                )}
              </summary>
              <div className="table-responsive">
                <table className="table table-sm mb-0 align-middle">
                  <tbody>
                    {day.items.map((g) => (
                      <tr key={g.key} style={g.reviewed ? { opacity: 0.55 } : undefined}>
                        <td style={{ width: 44 }}>
                          <button
                            type="button"
                            className={`btn btn-sm rounded-circle ${g.reviewed ? "btn-success" : "btn-outline-secondary"}`}
                            title={g.reviewed ? "Reviewed — click to undo" : "Mark reviewed"}
                            disabled={busy}
                            onClick={() => mark([g.key], !g.reviewed)}
                          >
                            ✓
                          </button>
                        </td>
                        <td>
                          <div className="fw-semibold">
                            {g.track === "it" && <span title="IT track">🛠️ </span>}
                            {g.company}
                            {g.companyNote && <span className="small text-muted fw-normal" dir="auto"> · {g.companyNote}</span>}
                          </div>
                          <div className="small text-muted">
                            {g.role}
                            {g.nights.length > 1 && (
                              <span
                                className="badge rounded-pill text-bg-light border ms-2"
                                title={`Seen ${g.nights.join(", ")} — keeps coming back, so they're still hiring`}
                              >
                                seen {g.nights.length} nights
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="small text-nowrap">{STAGE_LABELS[g.stage]}</td>
                        <td className="text-end">{g.score ?? "—"}</td>
                        <td className="small" dir="auto">
                          {g.reason}
                          <div className="text-muted">{label(g.bucket)}</div>
                        </td>
                        <td className="text-end text-nowrap">
                          <a className="btn btn-sm btn-outline-secondary rounded-pill me-1" href={searchUrl(g)} target="_blank" rel="noreferrer">
                            {g.url ? "Posting" : "Find"} ↗
                          </a>
                          {g.trackedFolder ? (
                            <Link className="btn btn-sm btn-outline-success rounded-pill" to={`/applications/${encodeURIComponent(g.trackedFolder)}`}>
                              In ledger
                            </Link>
                          ) : (
                            <Link className="btn btn-sm btn-outline-primary rounded-pill" to={addUrl(g)}>
                              Add anyway
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          );
        })
      )}

      {filtered.length > shown.length && (
        <div className="text-center my-3">
          <button type="button" className="btn btn-outline-secondary rounded-pill" onClick={() => setLimit(limit + PAGE)}>
            Show more ({filtered.length - shown.length} left)
          </button>
        </div>
      )}
    </div>
  );
}
