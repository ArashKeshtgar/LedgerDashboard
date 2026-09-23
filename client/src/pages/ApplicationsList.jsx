import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fetchApplications, fetchPipelineStages, moveApplicationStage } from "../api.js";

function matchChipClass(score) {
  const n = Number(score);
  if (n >= 55) return "chip-success";
  if (n >= 40) return "chip-warning";
  return "chip-danger";
}

function stageChipClass(stage) {
  switch ((stage || "").toLowerCase()) {
    case "applied":
    case "recruiter_screen":
    case "technical_interview":
      return "chip-info";
    case "final_round":
      return "chip-warning";
    case "offer":
    case "contract_signed":
      return "chip-success";
    default:
      return "chip-neutral";
  }
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}
function SpinnerIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 2a6 6 0 1 1-6 6" opacity="0.7" />
    </svg>
  );
}
function UpArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10l4-4 4 4" />
    </svg>
  );
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
  const [scrollPos, setScrollPos] = useState({ index: 1, showTop: false });
  const scrollAreaRef = useRef(null);
  const firstRowRef = useRef(null);

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

  // Filtering to a different set makes the old scroll position/row-count
  // meaningless (row 12 of "all" isn't row 12 of "≥55% match") — snap back
  // to the top and reset the position readout whenever a filter changes.
  useEffect(() => {
    if (scrollAreaRef.current) scrollAreaRef.current.scrollTop = 0;
    setScrollPos({ index: 1, showTop: false });
  }, [query, stageFilter, sourceFilter, matchFilter, followupOnly]);

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

  async function handleReject(folder) {
    setApproveError(null);
    setApprovingFolder(folder);
    const prevRows = rows;
    setRows((rs) => rs.map((r) => (r.folder === folder ? { ...r, stage: "rejected" } : r)));
    try {
      const updated = await moveApplicationStage(folder, "rejected");
      setRows((rs) => rs.map((r) => (r.folder === folder ? { ...r, ...updated } : r)));
    } catch (e) {
      setRows(prevRows);
      setApproveError(e.message);
    } finally {
      setApprovingFolder(null);
    }
  }

  // Tracks roughly which row is at the top of the scrolled table (by row
  // height, since every row is now the same height) so a long list can show
  // "you're at #N of M" instead of losing all sense of position once the
  // header scrolls out of view.
  function handleTableScroll() {
    const el = scrollAreaRef.current;
    const rowEl = firstRowRef.current;
    if (!el || !rowEl || filtered.length === 0) return;
    const rowHeight = rowEl.getBoundingClientRect().height || 1;
    const index = Math.min(filtered.length, Math.max(1, Math.round(el.scrollTop / rowHeight) + 1));
    setScrollPos({ index, showTop: el.scrollTop > 240 });
  }

  function scrollToTop() {
    scrollAreaRef.current?.scrollTo({ top: 0, behavior: "smooth" });
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
        <div className="table-scroll-area" ref={scrollAreaRef} onScroll={handleTableScroll}>
          <table className="table table-hover align-middle">
            <thead>
              <tr>
                <th style={{ width: 40 }} className="text-end">#</th>
                <th style={{ width: 92 }}>Date</th>
                <th>Company</th>
                <th>Location</th>
                <th style={{ width: 84 }}>Match</th>
                <th style={{ width: 150 }}>Stage</th>
                <th className="text-end" style={{ width: 120 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => (
                <tr
                  key={row.id}
                  ref={i === 0 ? firstRowRef : undefined}
                  style={{ animationDelay: `${Math.min(i * 20, 260)}ms` }}
                >
                  <td className="row-index">{i + 1}</td>
                  <td className="text-muted cell-truncate">{row.date}</td>
                  <td className="cell-stack">
                    <span className="cell-primary cell-truncate" title={row.company}>{row.company}</span>
                    <span className="cell-secondary cell-truncate" title={row.role}>{row.role}</span>
                  </td>
                  <td className="cell-stack">
                    <span className="cell-truncate" title={row.location}>{row.location || "—"}</span>
                    <span className="cell-secondary text-capitalize cell-truncate">{row.source || "—"}</span>
                  </td>
                  <td>
                    <span className={`chip ${matchChipClass(row.match_score)}`}>{row.match_score}%</span>
                  </td>
                  <td>
                    <span className={`chip ${stageChipClass(row.stage)}`}>
                      {stageLabels[row.stage] || row.stage || "—"}
                    </span>
                  </td>
                  <td>
                    <div className="d-flex gap-1 justify-content-end">
                      {row.stage === "draft" && (
                        <button
                          type="button"
                          className={`icon-btn icon-btn-approve${approvingFolder === row.folder ? " icon-btn-spin" : ""}`}
                          disabled={approvingFolder === row.folder}
                          title="Approve & Apply"
                          aria-label="Approve & Apply"
                          onClick={() => handleApprove(row.folder)}
                        >
                          {approvingFolder === row.folder ? <SpinnerIcon /> : <CheckIcon />}
                        </button>
                      )}
                      {row.stage !== "draft" && !row.isTerminal && (
                        <button
                          type="button"
                          className={`icon-btn icon-btn-reject${approvingFolder === row.folder ? " icon-btn-spin" : ""}`}
                          disabled={approvingFolder === row.folder}
                          title="Mark as rejected"
                          aria-label="Mark as rejected"
                          onClick={() => {
                            if (window.confirm(`Mark ${row.company} as rejected?`)) {
                              handleReject(row.folder);
                            }
                          }}
                        >
                          {approvingFolder === row.folder ? <SpinnerIcon /> : <XIcon />}
                        </button>
                      )}
                      <Link
                        to={`/applications/${row.id}`}
                        className="icon-btn icon-btn-details"
                        title="View details"
                        aria-label="View details"
                      >
                        <ArrowIcon />
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-4">
                    No applications match your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {filtered.length > 8 && (
          <div className="table-scroll-hud">
            <span className="table-scroll-hud-pos">
              {Math.min(scrollPos.index, filtered.length)} / {filtered.length}
            </span>
            {scrollPos.showTop && (
              <button
                type="button"
                className="icon-btn table-scroll-top"
                title="Back to top"
                aria-label="Back to top"
                onClick={scrollToTop}
              >
                <UpArrowIcon />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
