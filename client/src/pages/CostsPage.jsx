import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchUsage } from "../api.js";
import { KIND_LABELS, usd } from "../costs.js";

// What Claude calls cost this month, against the monthly budget, and which
// packages it went to. Months are UTC, like the stored timestamps.
const thisMonth = () => new Date().toISOString().slice(0, 7);

function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

// Straight-line projection to month end; only for the current month.
function projection(month, spent) {
  if (month !== thisMonth()) return null;
  const now = new Date();
  const day = now.getUTCDate() - 1 + now.getUTCHours() / 24;
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return day < 1 ? null : (spent / day) * days;
}

export default function CostsPage() {
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    fetchUsage(month).then(setData).catch((e) => setError(e.message));
  }, [month]);

  if (error) return <div className="alert alert-danger">{error}</div>;

  const pct = data ? Math.min(100, (data.usd / data.budget) * 100) : 0;
  const barClass = pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-success";
  const projected = data ? projection(month, data.usd) : null;
  const perPackage = data && data.packages.length ? data.usd / data.packages.length : 0;

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="h4 mb-0">💲 Claude costs</h2>
        <div className="btn-group btn-group-sm">
          <button type="button" className="btn btn-outline-secondary" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <span className="btn btn-outline-secondary disabled">{month}</span>
          <button
            type="button"
            className="btn btn-outline-secondary"
            disabled={month >= thisMonth()}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
        </div>
      </div>

      {!data ? (
        <div className="text-muted">Loading…</div>
      ) : (
        <>
          <div className="card mb-4">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-baseline mb-2">
                <span className="fs-3 fw-semibold">{usd(data.usd)}</span>
                <span className="text-muted">of {usd(data.budget)} budget · {Math.round((data.usd / data.budget) * 100)}%</span>
              </div>
              <div className="progress mb-3" style={{ height: 10 }}>
                <div className={`progress-bar ${barClass}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="row g-3 small">
                <div className="col-6 col-md-3">
                  <div className="text-muted">Packages</div>
                  <div className="fw-semibold">{data.packages.length}</div>
                </div>
                <div className="col-6 col-md-3">
                  <div className="text-muted">Claude calls</div>
                  <div className="fw-semibold">{data.calls}</div>
                </div>
                <div className="col-6 col-md-3">
                  <div className="text-muted">Average per package</div>
                  <div className="fw-semibold">{usd(perPackage)}</div>
                </div>
                {projected !== null && (
                  <div className="col-6 col-md-3">
                    <div className="text-muted">Month-end at this pace</div>
                    <div className={`fw-semibold ${projected > data.budget ? "text-danger" : ""}`}>{usd(projected)}</div>
                  </div>
                )}
              </div>
              {Object.keys(data.byKind).length > 0 && (
                <div className="d-flex flex-wrap gap-2 mt-3">
                  {Object.entries(data.byKind).map(([kind, v]) => (
                    <span key={kind} className="badge rounded-pill text-bg-light border">
                      {KIND_LABELS[kind] || kind}: {usd(v)}
                    </span>
                  ))}
                </div>
              )}
              <div className="small text-muted mt-3">
                Counted from each package's own log since 3 Oct 2026; calls before that weren't recorded.
                The hard limit is set in the Anthropic Console, not here.
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">Per package</div>
            {data.packages.length === 0 ? (
              <div className="card-body text-muted">No Claude calls this month.</div>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm mb-0 align-middle">
                  <thead>
                    <tr>
                      <th>Package</th>
                      <th>What ran</th>
                      <th className="text-end">Calls</th>
                      <th className="text-end">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.packages.map((p) => (
                      <tr key={p.folder}>
                        <td>
                          <Link to={`/applications/${encodeURIComponent(p.folder)}`}>
                            {p.company || p.folder}
                          </Link>
                          {p.role && <div className="small text-muted">{p.role}</div>}
                        </td>
                        <td className="small">
                          {Object.entries(p.byKind).map(([k, v]) => `${KIND_LABELS[k] || k} ${usd(v)}`).join(" · ")}
                        </td>
                        <td className="text-end">{p.calls}</td>
                        <td className="text-end fw-semibold">{usd(p.usd)}</td>
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
