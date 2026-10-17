import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchApplications, fetchPipelineStages, moveApplicationStage } from "../api.js";
import { TrackBadge, TrackTabs } from "../components/TrackBadge.jsx";
import { trackOf } from "../track.js";
import ActivityForecast from "../components/ActivityForecast.jsx";
import { rejectedDay, sentDay } from "../dailyActivity.js";
import { getScrollPanel } from "../scrollPanel.js";

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
  const [trackFilter, setTrackFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // A day picked on the activity panel: rows sent, found or rejected that day.
  const [dayFilter, setDayFilter] = useState(null);
  const [approvingFolder, setApprovingFolder] = useState(null);
  const [approveError, setApproveError] = useState(null);
  const [scrollIndex, setScrollIndex] = useState(1);
  const tableCardRef = useRef(null);
  const scrollAreaRef = useRef(null);
  // A table wider than the page doesn't scroll in its own box (that would
  // unstick its header): the sideways scrollbar sits in the sticky bar above
  // it, with the track tabs, and slides the table along under the clip.
  const sectionRef = useRef(null);
  const stickyBarRef = useRef(null);
  const hScrollRef = useRef(null);
  const [tableWidth, setTableWidth] = useState(0);
  const [tableWide, setTableWide] = useState(false);
  const navigate = useNavigate();
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

  // Filtering to a different set makes the old position meaningless (row 12
  // of "all" isn't row 12 of "≥55% match"): if the table's top has scrolled
  // out of view, bring it back so the new result starts at row 1.
  useEffect(() => {
    const panel = getScrollPanel();
    const card = tableCardRef.current;
    if (panel && card && card.getBoundingClientRect().top < panel.getBoundingClientRect().top) {
      card.scrollIntoView({ block: "start" });
    }
    setScrollIndex(1);
  }, [query, stageFilter, sourceFilter, matchFilter, followupOnly, dateFrom, dateTo, trackFilter, dayFilter]);

  const sources = useMemo(
    () => [...new Set(rows.map((r) => r.source).filter(Boolean))].sort(),
    [rows]
  );

  // The table scrolls with the page (one scroll for everything); this tracks
  // which row sits just under the sticky header (by row height, since every
  // row is the same height) so a long list can show "you're at #N of M".
  useEffect(() => {
    const panel = getScrollPanel();
    if (!panel) return undefined;
    let frame = 0;
    function update() {
      frame = 0;
      const rowEl = firstRowRef.current;
      // A header cell, not <thead>: the cells are what stick.
      const head = tableCardRef.current?.querySelector("thead th");
      if (!rowEl || !head) return;
      const rowHeight = rowEl.getBoundingClientRect().height || 1;
      const viewTop = head.getBoundingClientRect().bottom;
      const passed = (viewTop - rowEl.getBoundingClientRect().top) / rowHeight;
      setScrollIndex(Math.max(1, Math.round(passed) + 1)); // capped at the row count when shown
    }
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    panel.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      panel.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [loading]);

  useEffect(() => {
    const area = scrollAreaRef.current;
    const table = area?.querySelector("table");
    if (!area || !table) return undefined;
    const check = () => {
      const wide = table.offsetWidth > area.clientWidth + 1;
      setTableWide(wide);
      setTableWidth(table.offsetWidth);
      if (!wide) table.style.transform = "";
      // The header sticks just below the sticky bar.
      const bar = stickyBarRef.current;
      if (bar) sectionRef.current?.style.setProperty("--sticky-bar-h", `${bar.offsetHeight}px`);
    };
    const ro = new ResizeObserver(check);
    ro.observe(area);
    ro.observe(table);
    if (stickyBarRef.current) ro.observe(stickyBarRef.current);
    check();

    // Sideways wheel/trackpad (or Shift+wheel) and a horizontal swipe over the
    // table move the scrollbar above it; vertical scrolling stays the page's.
    const bar = () => hScrollRef.current;
    function onWheel(e) {
      const h = bar();
      if (!h || h.scrollWidth <= h.clientWidth) return;
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!dx) return;
      e.preventDefault();
      h.scrollLeft += dx;
    }
    let touch = null;
    function onTouchStart(e) {
      const t = e.touches[0];
      touch = { x: t.clientX, y: t.clientY, left: bar()?.scrollLeft || 0, horizontal: null };
    }
    function onTouchMove(e) {
      const h = bar();
      if (!touch || !h) return;
      const t = e.touches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      if (touch.horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) touch.horizontal = Math.abs(dx) > Math.abs(dy);
      if (touch.horizontal) h.scrollLeft = touch.left - dx;
    }
    area.addEventListener("wheel", onWheel, { passive: false });
    area.addEventListener("touchstart", onTouchStart, { passive: true });
    area.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      ro.disconnect();
      area.removeEventListener("wheel", onWheel);
      area.removeEventListener("touchstart", onTouchStart);
      area.removeEventListener("touchmove", onTouchMove);
    };
  }, [loading]);

  function handleHScroll(e) {
    const table = scrollAreaRef.current?.querySelector("table");
    if (table) table.style.transform = `translateX(${-e.currentTarget.scrollLeft}px)`;
  }

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
    if (trackFilter !== "all" && trackOf(r) !== trackFilter) return false;
    if (stageFilter !== "all" && r.stage !== stageFilter) return false;
    if (sourceFilter !== "all" && r.source !== sourceFilter) return false;
    if (followupOnly && !r.needsFollowup) return false;
    if (dateFrom && r.date && r.date < dateFrom) return false;
    if (dateTo && r.date && r.date > dateTo) return false;
    if (dayFilter && r.date?.slice(0, 10) !== dayFilter && sentDay(r) !== dayFilter && rejectedDay(r) !== dayFilter) return false;
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
    setTrackFilter("all");
    setDateFrom("");
    setDateTo("");
    setDayFilter(null);
  };

  const filtersActive =
    query ||
    stageFilter !== "all" ||
    sourceFilter !== "all" ||
    matchFilter !== "all" ||
    followupOnly ||
    trackFilter !== "all" ||
    dateFrom ||
    dateTo ||
    dayFilter;

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

      <ActivityForecast rows={rows} selectedDay={dayFilter} onSelectDay={setDayFilter} />

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

        <div className="date-filter-group">
          <span className="date-filter-icon" aria-hidden="true">📅</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="From date"
            title="From date"
          />
          <span className="date-filter-sep">–</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="To date"
            title="To date"
          />
        </div>

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

        {dayFilter && (
          <button
            type="button"
            className="btn btn-sm btn-warning rounded-pill"
            onClick={() => setDayFilter(null)}
            title="Rows sent, found or rejected on this day"
          >
            📅 {dayFilter} ✕
          </button>
        )}

        {filtersActive && (
          <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill" onClick={resetFilters}>
            Clear filters
          </button>
        )}
      </div>

      <div className="table-section" ref={sectionRef}>
      <div className="table-sticky-bar" ref={stickyBarRef}>
        <TrackTabs value={trackFilter} onChange={setTrackFilter} rows={rows} trackOf={trackOf} />
        <div
          className={`table-hscroll${tableWide ? "" : " d-none"}`}
          ref={hScrollRef}
          onScroll={handleHScroll}
          title="Scroll the table sideways"
        >
          <div style={{ width: tableWidth, height: 1 }} />
        </div>
      </div>
      <div className="table-card" ref={tableCardRef}>
        <div className="table-scroll-area" ref={scrollAreaRef}>
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
                  className={`row-clickable${trackOf(row) === "it" ? " row-track-it" : ""}`}
                  style={{ animationDelay: `${Math.min(i * 20, 260)}ms` }}
                  // A click anywhere on the row opens it, except on its own
                  // buttons/links or while selecting text to copy.
                  onClick={(e) => {
                    if (e.target.closest("a, button, input, select, label")) return;
                    if (window.getSelection()?.toString()) return;
                    navigate(`/applications/${row.id}`);
                  }}
                >
                  <td className="row-index">{i + 1}</td>
                  <td className="text-muted">
                    <span className="cell-truncate">{row.date}</span>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span className="cell-primary cell-truncate" title={row.company}>
                        {row.company} <TrackBadge track={trackOf(row)} className="ms-1" />
                      </span>
                      <span className="cell-secondary cell-truncate" title={row.role}>{row.role}</span>
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span className="cell-truncate" title={row.location}>{row.location || "—"}</span>
                      <span className="cell-secondary text-capitalize cell-truncate">{row.source || "—"}</span>
                    </div>
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
              {Math.min(scrollIndex, filtered.length)} / {filtered.length}
            </span>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
