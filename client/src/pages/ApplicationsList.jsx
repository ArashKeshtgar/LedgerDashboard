import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchApplications, fetchPipelineStages, moveApplicationStage } from "../api.js";

function matchBadgeClass(score) {
  const n = Number(score);
  if (n >= 55) return "bg-success";
  if (n >= 40) return "bg-warning text-dark";
  return "bg-danger";
}

function stageBadgeClass(stage) {
  switch ((stage || "").toLowerCase()) {
    case "applied": return "bg-primary";
    case "recruiter_screen": return "bg-info text-dark";
    case "technical_interview": return "bg-info text-dark";
    case "final_round": return "bg-warning text-dark";
    case "offer": return "bg-success";
    case "contract_signed": return "bg-success";
    case "rejected": return "bg-secondary";
    case "no_response": return "bg-secondary";
    default: return "bg-light text-dark border";
  }
}

const MATCH_FILTERS = [
  { key: "all", label: "All" },
  { key: "high", label: "≥55%" },
  { key: "mid", label: "40–54%" },
  { key: "low", label: "<40%" },
];

export default function ApplicationsList() {
  const [rows, setRows] = useState([]);
  const [stageLabels, setStageLabels] = useState({});
  const [stageOptions, setStageOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [matchFilter, setMatchFilter] = useState("all");
  const [followupOnly, setFollowupOnly] = useState(false);
  const [approvingFolder, setApprovingFolder] = useState(null);
  const [approveError, setApproveError] = useState(null);

  useEffect(() => {
    fetchApplications()
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchPipelineStages()
      .then((s) => {
        const all = [...(s.stages || []), ...(s.terminal || [])];
        const map = {};
        all.forEach((x) => {
          map[x.key] = `${x.icon} ${x.label}`;
        });
        setStageLabels(map);
        setStageOptions(all);
      })
      .catch(() => {});
  }, []);

  const sources = useMemo(
    () => [...new Set(rows.map((r) => r.source).filter(Boolean))].sort(),
    [rows]
  );

  if (loading) return <div className="text-center py-5 text-muted">Loading…</div>;
  if (error)
    return (
      <div className="alert alert-danger">
        Couldn't load applications: {error}
        <div className="small mt-1">Is the API server running on port 4310?</div>
      </div>
    );

  const matchTest = (score) => {
    const n = Number(score);
    if (matchFilter === "high") return n >= 55;
    if (matchFilter === "mid") return n >= 40 && n < 55;
    if (matchFilter === "low") return n < 40;
    return true;
  };

  const q = query.toLowerCase();
  const filtered = rows.filter((r) => {
    if (stageFilter !== "all" && r.stage !== stageFilter) return false;
    if (sourceFilter !== "all" && r.source !== sourceFilter) return false;
    if (followupOnly && !r.needsFollowup) return false;
    if (!matchTest(r.match_score)) return false;
    return (
      !q ||
      r.company?.toLowerCase().includes(q) ||
      r.role?.toLowerCase().includes(q) ||
      r.stage?.toLowerCase().includes(q)
    );
  });

  const resetFilters = () => {
    setQuery("");
    setStageFilter("all");
    setSourceFilter("all");
    setMatchFilter("all");
    setFollowupOnly(false);
  };

  const filtersActive =
    query || stageFilter !== "all" || sourceFilter !== "all" || matchFilter !== "all" || followupOnly;

  async function handleApprove(folder) {
    setApproveError(null);
    setApprovingFolder(folder);
    const prevRows = rows;
    setRows((rs) => rs.map((r) => (r.folder === folder ? { ...r, stage: "applied" } : r)));
    try {
      const updated = await moveApplicationStage(folder, "applied");
      setRows((rs) => rs.map((r) => (r.folder === folder ? { ...r, ...updated } : r)));
    } catch (e) {
      setRows(prevRows);
      setApproveError(e.message);
    } finally {
      setApprovingFolder(null);
    }
  }

  return (
    <div>
      <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
        <h4 className="mb-0 page-title">
          Applications <span className="text-muted fw-normal">({filtered.length})</span>
        </h4>
        <div className="d-flex flex-wrap align-items-center gap-2">
          <div className="search-input-wrap">
            <span className="search-icon">🔍</span>
            <input
              className="form-control"
              style={{ minWidth: 260 }}
              placeholder="Search company, role, stage…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Link to="/packages/new" className="btn btn-primary rounded-pill">
            🤖 Build with AI
          </Link>
          <Link to="/applications/new" className="btn btn-outline-primary rounded-pill">
            + Add application
          </Link>
        </div>
      </div>

      {approveError && (
        <div className="alert alert-danger py-2 px-3 mb-3" role="alert">
          {approveError}
        </div>
      )}

      <div className="pipeline-toolbar mb-3">
        <select
          className="form-select"
          style={{ width: "auto" }}
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          aria-label="Filter by stage"
        >
          <option value="all">All stages</option>
          {stageOptions.map((s) => (
            <option key={s.key} value={s.key}>
              {s.icon} {s.label}
            </option>
          ))}
        </select>

        <select
          className="form-select"
          style={{ width: "auto" }}
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          aria-label="Filter by source"
        >
          <option value="all">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <div className="pipeline-toolbar-radios" role="radiogroup" aria-label="Filter by match score">
          {MATCH_FILTERS.map((m) => (
            <label key={m.key} className={`radio-pill ${matchFilter === m.key ? "active" : ""}`}>
              <input
                type="radio"
                name="matchFilterList"
                value={m.key}
                checked={matchFilter === m.key}
                onChange={() => setMatchFilter(m.key)}
              />
              {m.label}
            </label>
          ))}
        </div>

        <label className="form-check pipeline-toolbar-check">
          <input
            type="checkbox"
            className="form-check-input"
            checked={followupOnly}
            onChange={(e) => setFollowupOnly(e.target.checked)}
          />
          <span className="form-check-label">⏰ Needs follow-up only</span>
        </label>

        {filtersActive && (
          <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill" onClick={resetFilters}>
            Clear filters
          </button>
        )}
      </div>

      <div className="table-card">
        <div className="table-responsive">
          <table className="table table-hover align-middle">
            <thead>
              <tr>
                <th>Date</th>
                <th>Company</th>
                <th>Role</th>
                <th>Location</th>
                <th>Source</th>
                <th>Match</th>
                <th>Stage</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  <td className="text-muted">{row.date}</td>
                  <td className="fw-semibold">{row.company}</td>
                  <td>{row.role}</td>
                  <td className="text-muted">{row.location}</td>
                  <td className="text-capitalize text-muted">{row.source}</td>
                  <td>
                    <span className={`badge ${matchBadgeClass(row.match_score)}`}>
                      {row.match_score}%
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${stageBadgeClass(row.stage)}`}>
                      {stageLabels[row.stage] || row.stage || "—"}
                    </span>
                  </td>
                  <td className="d-flex gap-2">
                    {row.stage === "draft" && (
                      <button
                        type="button"
                        className="btn btn-sm btn-success rounded-pill"
                        disabled={approvingFolder === row.folder}
                        onClick={() => handleApprove(row.folder)}
                      >
                        {approvingFolder === row.folder ? "Approving…" : "✅ Approve & Apply"}
                      </button>
                    )}
                    <Link to={`/applications/${row.id}`} className="btn btn-sm btn-outline-primary rounded-pill">
                      Details
                    </Link>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-muted py-4">
                    No applications match your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
