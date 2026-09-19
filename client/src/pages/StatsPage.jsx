import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchApplications, fetchGapTags } from "../api.js";
import BarChart from "../components/BarChart.jsx";

const SCORE_BUCKETS = [
  { label: "< 40%", test: (n) => n < 40, color: "#86b6ef" },
  { label: "40–54%", test: (n) => n >= 40 && n < 55, color: "#5598e7" },
  { label: "55–69%", test: (n) => n >= 55 && n < 70, color: "#2a78d6" },
  { label: "70%+", test: (n) => n >= 70, color: "#1c5cab" },
];

const STATUS_ORDER = [
  { key: "draft", label: "Draft", icon: "📝", color: "#898781" },
  { key: "applied", label: "Applied", icon: "📤", color: "#2a78d6" },
  { key: "interview", label: "Interview", icon: "🎤", color: "#fab219" },
  { key: "offer", label: "Offer", icon: "🎉", color: "#0ca30c" },
  { key: "rejected", label: "Rejected", icon: "❌", color: "#d03b3b" },
];

export default function StatsPage() {
  const [rows, setRows] = useState(null);
  const [gapDict, setGapDict] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([fetchApplications(), fetchGapTags().catch(() => ({}))])
      .then(([apps, gaps]) => {
        setRows(apps);
        setGapDict(gaps);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!rows) return <div className="text-center py-5">Loading…</div>;

  // Drafts are packages that haven't been sent yet — they don't count as a
  // real application until approved on the Pipeline board.
  const pendingCount = rows.filter((r) => r.stage === "draft").length;
  const counted = rows.filter((r) => r.stage !== "draft");

  const total = counted.length;
  const avgMatch = total
    ? Math.round(counted.reduce((s, r) => s + Number(r.match_score || 0), 0) / total)
    : 0;

  const scoreItems = SCORE_BUCKETS.map((b) => ({
    label: b.label,
    value: counted.filter((r) => b.test(Number(r.match_score || 0))).length,
    color: b.color,
  }));

  const statusCounts = STATUS_ORDER.map((s) => ({
    label: s.label,
    icon: s.icon,
    value: counted.filter((r) => (r.status || "").toLowerCase() === s.key).length,
    color: s.color,
  }));

  const sourceMap = {};
  counted.forEach((r) => {
    const key = r.source || "unknown";
    sourceMap[key] = (sourceMap[key] || 0) + 1;
  });
  const sourceItems = Object.entries(sourceMap)
    .map(([label, value]) => ({ label, value, color: "#2a78d6" }))
    .sort((a, b) => b.value - a.value);

  // --- Gap analysis: split gap_tags per row, count + average match_score per tag ---
  const gapStats = {};
  counted.forEach((r) => {
    const tags = (r.gap_tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    tags.forEach((tag) => {
      if (!gapStats[tag]) gapStats[tag] = { count: 0, scoreSum: 0 };
      gapStats[tag].count += 1;
      gapStats[tag].scoreSum += Number(r.match_score || 0);
    });
  });
  const gapRows = Object.entries(gapStats)
    .map(([tag, s]) => ({
      tag,
      label: gapDict[tag] || tag,
      count: s.count,
      avgScore: Math.round(s.scoreSum / s.count),
    }))
    .sort((a, b) => b.count - a.count || a.avgScore - b.avgScore);

  const gapChartItems = gapRows.map((g) => ({
    label: g.tag,
    value: g.count,
    color: "#eb6834",
  }));

  return (
    <div>
      <h4 className={pendingCount > 0 ? "mb-1 page-title" : "mb-4 page-title"}>Stats</h4>
      {pendingCount > 0 && (
        <div className="text-muted small mb-4">
          📝 {pendingCount} more waiting for approval on the{" "}
          <Link to="/pipeline">Pipeline</Link> — not counted here yet.
        </div>
      )}

      <div className="row mb-4 g-3">
        <div className="col-sm-4">
          <div className="stat-card text-center" style={{ "--stat-accent": "#2a78d6" }}>
            <div className="stat-icon mb-1">📨</div>
            <div className="text-muted small">Total applications</div>
            <div className="fs-2 fw-semibold">{total}</div>
          </div>
        </div>
        <div className="col-sm-4">
          <div className="stat-card text-center" style={{ "--stat-accent": "#1baf7a" }}>
            <div className="stat-icon mb-1">🎯</div>
            <div className="text-muted small">Average match score</div>
            <div className="fs-2 fw-semibold">{avgMatch}%</div>
          </div>
        </div>
        <div className="col-sm-4">
          <div className="stat-card text-center" style={{ "--stat-accent": "#eda100" }}>
            <div className="stat-icon mb-1">🌐</div>
            <div className="text-muted small">Sources used</div>
            <div className="fs-2 fw-semibold">{Object.keys(sourceMap).length}</div>
          </div>
        </div>
      </div>

      <div className="row g-4 mb-4">
        <div className="col-lg-4">
          <div className="card h-100">
            <div className="card-header">Match score distribution</div>
            <div className="card-body">
              <BarChart items={scoreItems} valueSuffix=" apps" />
            </div>
          </div>
        </div>

        <div className="col-lg-4">
          <div className="card h-100">
            <div className="card-header">Status breakdown</div>
            <div className="card-body">
              <BarChart items={statusCounts} valueSuffix=" apps" />
            </div>
          </div>
        </div>

        <div className="col-lg-4">
          <div className="card h-100">
            <div className="card-header">Applications by source</div>
            <div className="card-body">
              {sourceItems.length ? (
                <BarChart items={sourceItems} valueSuffix=" apps" />
              ) : (
                <div className="text-muted small">No data yet.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          Gap analysis — which recurring gap to close
        </div>
        <div className="card-body">
          {gapRows.length === 0 ? (
            <div className="text-muted small">No gap tags recorded yet.</div>
          ) : (
            <div className="row">
              <div className="col-lg-5">
                <BarChart items={gapChartItems} />
              </div>
              <div className="col-lg-7">
                <div className="table-responsive">
                  <table className="table table-sm align-middle mb-0">
                    <thead className="table-light">
                      <tr>
                        <th>Gap</th>
                        <th className="text-end">Postings</th>
                        <th className="text-end">Avg match w/o it</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gapRows.map((g) => (
                        <tr key={g.tag}>
                          <td>
                            <code className="me-2">{g.tag}</code>
                            <span className="text-muted small">{g.label}</span>
                          </td>
                          <td className="text-end">
                            {g.count} / {total}
                          </td>
                          <td className="text-end">{g.avgScore}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-muted small mt-2">
                  Top row = the gap worth closing first if you're going to skill up on
                  just one thing. A gap that appears only once is usually cheaper to
                  handle in the cover letter than to train for.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
