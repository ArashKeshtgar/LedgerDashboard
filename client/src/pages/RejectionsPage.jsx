import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchRejections } from "../api.js";

// Postings the nightly job-search run turned down, and why — read from its
// daily reports. "Add anyway" opens the Add form pre-filled, so a rule that
// was too strict can be overruled one posting at a time.

const BUCKET_LABELS = {
  "other stack": "Other main stack (Java, Python, MERN…)",
  seniority: "Seniority (8+ yrs, Lead…)",
  "low score": "Scored below the bar",
  duplicate: "Duplicate / already applied",
  "different job": "Different kind of job",
  clearance: "Security clearance",
  language: "Language (French, Mandarin…)",
  location: "Location",
};

const STAGE_LABELS = { prescreen: "pre-screen", scored: "after scoring" };

function searchUrl(r) {
  return r.url || `https://www.google.com/search?q=${encodeURIComponent(`${r.company} ${r.role} job`)}`;
}

function addUrl(r) {
  const q = new URLSearchParams({
    company: r.company,
    role: r.role,
    notes: `Added anyway — the nightly run rejected it on ${r.date} (${STAGE_LABELS[r.stage]}): ${r.reason || r.score || ""}`,
  });
  if (r.url) q.set("posting_url", r.url);
  return `/applications/new?${q}`;
}

export default function RejectionsPage() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [bucket, setBucket] = useState("all");
  const [track, setTrack] = useState("all");

  useEffect(() => {
    fetchRejections(days).then(setData).catch((e) => setError(e.message));
  }, [days]);

  const counts = useMemo(() => {
    const c = {};
    (data?.rows || []).forEach((r) => (c[r.bucket] = (c[r.bucket] || 0) + 1));
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  }, [data]);

  if (error) return <div className="alert alert-danger">{error}</div>;

  const rows = (data?.rows || []).filter(
    (r) => (bucket === "all" || r.bucket === bucket) && (track === "all" || r.track === track)
  );
  const total = data?.rows.length || 0;

  return (
    <div>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h2 className="h4 mb-0">🚫 Rejected by the nightly run</h2>
        <div className="d-flex gap-2">
          <select className="form-select form-select-sm" value={track} onChange={(e) => setTrack(e.target.value)}>
            <option value="all">All tracks</option>
            <option value="dev">💻 Developer</option>
            <option value="it">🛠️ IT</option>
          </select>
          <select className="form-select form-select-sm" value={days} onChange={(e) => {
            setData(null);
            setDays(Number(e.target.value));
          }}>
            <option value={7}>Last 7 reports</option>
            <option value={14}>Last 14 reports</option>
            <option value={30}>Last 30 reports</option>
            <option value={90}>Last 90 reports</option>
          </select>
        </div>
      </div>

      {!data ? (
        <div className="text-muted">Loading…</div>
      ) : (
        <>
          <div className="card mb-4">
            <div className="card-body">
              <div className="small text-muted mb-2">
                Why postings were dropped ({total}) — click one to filter. Reasons are grouped from the
                report's own wording, so the buckets are approximate.
              </div>
              <div className="d-flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`btn btn-sm rounded-pill ${bucket === "all" ? "btn-dark" : "btn-outline-secondary"}`}
                  onClick={() => setBucket("all")}
                >
                  All · {total}
                </button>
                {counts.map(([b, n]) => (
                  <button
                    key={b}
                    type="button"
                    className={`btn btn-sm rounded-pill ${bucket === b ? "btn-dark" : "btn-outline-secondary"}`}
                    onClick={() => setBucket(b)}
                  >
                    {BUCKET_LABELS[b] || b} · {n} ({Math.round((n / total) * 100)}%)
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            {rows.length === 0 ? (
              <div className="card-body text-muted">Nothing rejected in these reports.</div>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm mb-0 align-middle">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Company / role</th>
                      <th>Where</th>
                      <th className="text-end">Score</th>
                      <th>Reason</th>
                      <th className="text-end" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.date}-${i}`}>
                        <td className="small text-nowrap">{r.date}</td>
                        <td>
                          <div className="fw-semibold">
                            {r.track === "it" && <span title="IT track">🛠️ </span>}
                            {r.company}
                            {r.companyNote && <span className="small text-muted fw-normal" dir="auto"> · {r.companyNote}</span>}
                          </div>
                          <div className="small text-muted">{r.role}</div>
                        </td>
                        <td className="small text-nowrap">{STAGE_LABELS[r.stage]}</td>
                        <td className="text-end">{r.score ?? "—"}</td>
                        <td className="small" dir="auto">
                          {r.reason}
                          <div className="text-muted">{BUCKET_LABELS[r.bucket] || r.bucket}</div>
                        </td>
                        <td className="text-end text-nowrap">
                          <a className="btn btn-sm btn-outline-secondary rounded-pill me-1" href={searchUrl(r)} target="_blank" rel="noreferrer">
                            {r.url ? "Posting" : "Find"} ↗
                          </a>
                          {r.trackedFolder ? (
                            <Link className="btn btn-sm btn-outline-success rounded-pill" to={`/applications/${encodeURIComponent(r.trackedFolder)}`}>
                              In ledger
                            </Link>
                          ) : (
                            <Link className="btn btn-sm btn-outline-primary rounded-pill" to={addUrl(r)}>
                              Add anyway
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
