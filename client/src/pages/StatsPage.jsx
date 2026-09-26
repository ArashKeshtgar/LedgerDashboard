import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchApplications, fetchGapTags, fetchPipelineStages } from "../api.js";
import BarChart from "../components/BarChart.jsx";

const SCORE_BUCKETS = [
  { label: "< 40%", test: (n) => n < 40, color: "#86b6ef" },
  { label: "40–54%", test: (n) => n >= 40 && n < 55, color: "#5598e7" },
  { label: "55–69%", test: (n) => n >= 55 && n < 70, color: "#2a78d6" },
  { label: "70%+", test: (n) => n >= 70, color: "#1c5cab" },
];

// Colour by what a stage means (waiting on the employer, an interview
// round, a win, a loss) rather than by a hardcoded list of keys.
function stageColor(stage, kind) {
  if (stage.key === "rejected") return "#d03b3b";
  if (kind === "terminal") return "#898781";
  if (stage.key === "offer" || stage.key === "contract_signed") return "#0ca30c";
  if (stage.key === "applied") return "#2a78d6";
  return "#fab219";
}

// One bar per real pipeline stage (from the server's stage definitions),
// counted by each application's CURRENT stage — the one computed from its
// pipeline events. The ledger's own `status` column is only set when a row
// is created and is never updated, so counting it showed moved-on
// applications as still "Draft".
function stageBreakdown(rows, defs) {
  const ordered = [
    ...defs.stages.filter((s) => s.key !== "draft").map((s) => ({ s, kind: "stage" })),
    ...defs.terminal.map((s) => ({ s, kind: "terminal" })),
  ];
  const known = new Set(ordered.map(({ s }) => s.key));
  const items = ordered.map(({ s, kind }) => ({
    label: s.label || s.key,
    icon: s.icon,
    value: rows.filter((r) => r.stage === s.key).length,
    color: stageColor(s, kind),
  }));
  const other = rows.filter((r) => !known.has(r.stage)).length;
  if (other) items.push({ label: "Other", icon: "❔", value: other, color: "#898781" });
  return items;
}

export default function StatsPage() {
  const [rows, setRows] = useState(null);
  const [gapDict, setGapDict] = useState({});
  const [stageDefs, setStageDefs] = useState({ stages: [], terminal: [] });
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      fetchApplications(),
      fetchGapTags().catch(() => ({})),
      fetchPipelineStages().catch(() => ({ stages: [], terminal: [] })),
    ])
      .then(([apps, gaps, defs]) => {
        setRows(apps);
        setGapDict(gaps);
        setStageDefs(defs);
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

  const statusCounts = stageBreakdown(counted, stageDefs);

  const sourceMap = {};
  counted.forEach((r) => {
    const key = r.source || "unknown";
    sourceMap[key] = (sourceMap[key] || 0) + 1;
  });
  const sourceItems = Object.entries(sourceMap)
    .map(([label, value]) => ({ label, value, color: "#2a78d6" }))
    .sort((a, b) => b.value - a.value);

  // --- Gap analysis: split gap_tags per row, count + average match_score per tag ---
  // Unlike the tiles above, this pulls from EVERY scored posting, including
  // ones still in draft — the gap signal comes from the posting's own
  // requirements vs. the fact bank at analyze time, not from whether the
  // application actually got sent. A draft that never got approved still
  // tells you a skill is in demand. Rejections are weighted even more:
  // they're the clearest real-world confirmation a gap actually cost you
  // something, not just a posting that happened to ask for it.
  const gapStats = {};
  rows.forEach((r) => {
    const tags = (r.gap_tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const isRejected = r.stage === "rejected";
    tags.forEach((tag) => {
      if (!gapStats[tag]) gapStats[tag] = { count: 0, scoreSum: 0, rejectedCount: 0 };
      gapStats[tag].count += 1;
      gapStats[tag].scoreSum += Number(r.match_score || 0);
      if (isRejected) gapStats[tag].rejectedCount += 1;
    });
  });
  const gapPoolTotal = rows.length;
  const gapRows = Object.entries(gapStats)
    .map(([tag, s]) => ({
      tag,
      label: gapDict[tag] || tag,
      count: s.count,
      avgScore: Math.round(s.scoreSum / s.count),
      rejectedCount: s.rejectedCount,
    }))
    .sort((a, b) => b.rejectedCount - a.rejectedCount || b.count - a.count || a.avgScore - b.avgScore);

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
          <Link to="/pipeline">Pipeline</Link> — not counted in the totals above yet, but
          already included in the gap analysis below.
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
            <div className="card-header">Current stage</div>
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
          <div className="text-muted small mb-3">
            Includes every scored posting — drafts too, not just sent applications — since
            the gap shows up the moment a posting is analyzed, whether or not it went
            further.
          </div>
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
                        <th className="text-end">Rejected</th>
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
                            {g.count} / {gapPoolTotal}
                          </td>
                          <td className="text-end">
                            {g.rejectedCount > 0 ? (
                              <span className="badge bg-danger">{g.rejectedCount}</span>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                          <td className="text-end">{g.avgScore}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-muted small mt-2">
                  Sorted by how often a gap shows up in an actual rejection first, then by
                  how often it appears overall — a gap tied to real rejections is worth
                  closing before one that's merely common. A gap that appears only once
                  with no rejections attached is usually cheaper to handle in the cover
                  letter than to train for.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
