import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchApplications, fetchPipelineStages, moveApplicationStage } from "../api.js";

function matchColor(score) {
  const n = Number(score);
  if (n >= 55) return "#0ca30c";
  if (n >= 40) return "#fab219";
  return "#d03b3b";
}

function stageAge(app) {
  if (app.daysUntilStage) return `in ${app.daysUntilStage}d`;
  if (app.daysInStage === 0) return "today";
  if (app.daysInStage) return `${app.daysInStage}d in stage`;
  return "";
}

function Card({ app, dragging, onDragStart, onDragEnd }) {
  const cardClass = [
    "pipeline-card",
    app.needsFollowup ? "pipeline-card-followup" : "",
    dragging ? "pipeline-card-dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Link
      to={`/applications/${app.id}`}
      className={cardClass}
      draggable
      onDragStart={(e) => onDragStart(e, app)}
      onDragEnd={onDragEnd}
      title={
        app.needsFollowup
          ? `${app.role} — ${app.daysInStage}d with no update, follow-up due`
          : app.role
      }
    >
      {app.needsFollowup && (
        <div className="pipeline-card-flag">
          <span aria-hidden="true">⏰</span> Follow up
        </div>
      )}
      <div className="pipeline-card-company">{app.company}</div>
      <div className="pipeline-card-role">{app.role}</div>
      <div className="pipeline-card-foot">
        <span
          className="pipeline-card-score"
          style={{ background: matchColor(app.match_score) }}
        >
          {app.match_score}%
        </span>
        <span className="pipeline-card-meta">{stageAge(app)}</span>
      </div>
    </Link>
  );
}

function PendingCard({ app, onApprove, approving }) {
  return (
    <div className="pipeline-card pipeline-pending-card">
      <Link to={`/applications/${app.id}`} className="pipeline-pending-link">
        <div className="pipeline-card-company">{app.company}</div>
        <div className="pipeline-card-role">{app.role}</div>
      </Link>
      <div className="pipeline-card-foot">
        <span
          className="pipeline-card-score"
          style={{ background: matchColor(app.match_score) }}
        >
          {app.match_score}%
        </span>
        <button
          type="button"
          className="btn btn-sm btn-success rounded-pill"
          disabled={approving}
          onClick={() => onApprove(app.folder)}
        >
          {approving ? "Approving…" : "✅ Approve & Apply"}
        </button>
      </div>
    </div>
  );
}

const MATCH_FILTERS = [
  { key: "all", label: "All" },
  { key: "high", label: "≥55%" },
  { key: "mid", label: "40–54%" },
  { key: "low", label: "<40%" },
];

export default function PipelineBoard() {
  const [rows, setRows] = useState(null);
  const [stages, setStages] = useState([]);
  const [terminal, setTerminal] = useState([]);
  const [error, setError] = useState(null);
  const [moveError, setMoveError] = useState(null);

  // Filters — the board was view-only before, these make it something you
  // can actually narrow down and act on.
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [matchFilter, setMatchFilter] = useState("all");
  const [followupOnly, setFollowupOnly] = useState(false);

  // Drag & drop state
  const [draggedFolder, setDraggedFolder] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);

  // Approval state — a draft is a package that hasn't been sent yet, so it
  // stays out of the pipeline columns and out of stats until approved.
  const [approvingFolder, setApprovingFolder] = useState(null);

  useEffect(() => {
    Promise.all([fetchApplications(), fetchPipelineStages()])
      .then(([apps, s]) => {
        setRows(apps);
        setStages(s.stages || []);
        setTerminal(s.terminal || []);
      })
      .catch((e) => setError(e.message));
  }, []);

  const sources = useMemo(() => {
    if (!rows) return [];
    return [...new Set(rows.map((r) => r.source).filter(Boolean))].sort();
  }, [rows]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!rows) return <div className="text-center py-5 text-muted">Loading…</div>;

  const matchTest = (score) => {
    const n = Number(score);
    if (matchFilter === "high") return n >= 55;
    if (matchFilter === "mid") return n >= 40 && n < 55;
    if (matchFilter === "low") return n < 40;
    return true;
  };

  const q = query.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (followupOnly && !r.needsFollowup) return false;
    if (sourceFilter !== "all" && r.source !== sourceFilter) return false;
    if (!matchTest(r.match_score)) return false;
    if (q && !`${r.company} ${r.role}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const inStage = (key) => visible.filter((r) => r.stage === key);
  const boardStages = stages.filter((s) => s.key !== "draft");
  const pending = visible.filter((r) => r.stage === "draft");
  const active = visible.filter((r) => !r.isTerminal && r.stage !== "draft");
  const followupCount = rows.filter((r) => r.needsFollowup).length;

  async function handleApprove(folder) {
    setMoveError(null);
    setApprovingFolder(folder);
    const prevRows = rows;
    setRows((rs) => rs.map((r) => (r.folder === folder ? { ...r, stage: "applied" } : r)));
    try {
      const updated = await moveApplicationStage(folder, "applied");
      setRows((rs) => rs.map((r) => (r.folder === folder ? { ...r, ...updated } : r)));
    } catch (e) {
      setRows(prevRows);
      setMoveError(e.message);
    } finally {
      setApprovingFolder(null);
    }
  }

  async function handleDrop(e, stageKey) {
    setDragOverKey(null);
    // Read the payload straight from the drag event rather than component
    // state — state set in onDragStart isn't guaranteed to have re-rendered
    // by the time drop fires, but dataTransfer always has it.
    const folder = e.dataTransfer.getData("text/plain") || draggedFolder;
    setDraggedFolder(null);
    if (!folder) return;
    const row = rows.find((r) => r.folder === folder);
    if (!row || row.stage === stageKey) return;

    const prevRows = rows;
    // Optimistic update so the card jumps immediately instead of waiting on the request.
    setRows((rs) => rs.map((r) => (r.folder === folder ? { ...r, stage: stageKey } : r)));
    setMoveError(null);
    try {
      const updated = await moveApplicationStage(folder, stageKey);
      setRows((rs) => rs.map((r) => (r.folder === folder ? { ...r, ...updated } : r)));
    } catch (e) {
      setRows(prevRows);
      setMoveError(e.message);
    }
  }

  function handleDragStart(e, app) {
    setDraggedFolder(app.folder);
    e.dataTransfer.setData("text/plain", app.folder);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragEnd() {
    setDraggedFolder(null);
    setDragOverKey(null);
  }

  return (
    <div>
      <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
        <h4 className="mb-0 page-title">
          Pipeline <span className="text-muted fw-normal">({active.length} active)</span>
        </h4>
        {followupCount > 0 && (
          <span className="followup-summary">
            ⏰ {followupCount} need{followupCount === 1 ? "s" : ""} a follow-up
          </span>
        )}
      </div>

      {moveError && (
        <div className="alert alert-danger py-2 px-3 mb-3" role="alert">
          {moveError}
        </div>
      )}

      <div className="pipeline-toolbar">
        <div className="search-input-wrap">
          <span className="search-icon">🔍</span>
          <input
            className="form-control"
            style={{ minWidth: 220 }}
            placeholder="Search company, role…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

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
                name="matchFilter"
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
      </div>

      {pending.length > 0 && (
        <div className="mb-4">
          <h6 className="text-muted mb-2">
            📝 Pending approval <span className="pipeline-col-count">{pending.length}</span> — approve to send and add to the pipeline
          </h6>
          <div className="pipeline-pending-row">
            {pending.map((a) => (
              <PendingCard
                key={a.id}
                app={a}
                onApprove={handleApprove}
                approving={approvingFolder === a.folder}
              />
            ))}
          </div>
        </div>
      )}

      <div className="pipeline-board">
        {boardStages.map((s) => {
          const cards = inStage(s.key);
          const isOver = dragOverKey === s.key;
          return (
            <div
              key={s.key}
              className={`pipeline-col ${isOver ? "pipeline-col-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverKey !== s.key) setDragOverKey(s.key);
              }}
              onDragLeave={() => setDragOverKey((k) => (k === s.key ? null : k))}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(e, s.key);
              }}
            >
              <div className="pipeline-col-head">
                <span>
                  {s.icon} {s.label}
                </span>
                <span className="pipeline-col-count">{cards.length}</span>
              </div>
              <div className="pipeline-col-body">
                {cards.map((a) => (
                  <Card
                    key={a.id}
                    app={a}
                    dragging={draggedFolder === a.folder}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                  />
                ))}
                {cards.length === 0 && (
                  <div className="pipeline-empty">{isOver ? "Drop here" : "—"}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {(terminal.length > 0) && (
        <div className="mt-4">
          <h6 className="text-muted mb-2">Closed — drag a card here to close it out</h6>
          <div className="pipeline-terminal-row">
            {terminal.map((t) => {
              const cards = inStage(t.key);
              const isOver = dragOverKey === t.key;
              return (
                <div
                  key={t.key}
                  className={`pipeline-terminal-zone ${isOver ? "pipeline-col-over" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverKey !== t.key) setDragOverKey(t.key);
                  }}
                  onDragLeave={() => setDragOverKey((k) => (k === t.key ? null : k))}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(e, t.key);
                  }}
                >
                  <div className="pipeline-terminal-head">
                    {t.icon} {t.label} <span className="pipeline-col-count">{cards.length}</span>
                  </div>
                  <div className="d-flex flex-wrap gap-2">
                    {cards.map((a) => (
                      <Link
                        key={a.id}
                        to={`/applications/${a.id}`}
                        className="badge bg-light text-dark border text-decoration-none py-2 px-3"
                        draggable
                        onDragStart={(e) => handleDragStart(e, a)}
                        onDragEnd={handleDragEnd}
                      >
                        {t.icon} {a.company}
                      </Link>
                    ))}
                    {cards.length === 0 && <span className="pipeline-empty">—</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
