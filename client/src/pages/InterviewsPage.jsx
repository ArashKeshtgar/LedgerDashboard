import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchInterviews } from "../api.js";

// Past interviews and the practice question bank, from
// engine/interviews/question_bank.json. Edited as a file (see the README
// there); this page reads it and is where you practise.
const SOURCES = [
  { key: "asked", label: "Asked", badge: "bg-danger" },
  { key: "prepared", label: "Prepared", badge: "bg-primary" },
  { key: "practice", label: "Practice", badge: "bg-secondary" },
];
const SOURCE = Object.fromEntries(SOURCES.map((s) => [s.key, s]));

// Marks the [...] blanks that still need a real number or detail.
function WithBlanks({ text }) {
  return text.split(/(\[[^\]]+\])/).map((part, i) =>
    /^\[[^\]]+\]$/.test(part) ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>
  );
}

const anchor = (id) => `q-${id}`;

function QuestionCard({ q, interviews, titles, practice, onJump }) {
  const [shown, setShown] = useState(false);
  const hidden = practice && !shown;
  return (
    <div className="card mb-3" id={anchor(q.id)}>
      <div className="card-body">
        <div className="d-flex flex-wrap gap-1 mb-2 small">
          <span className={`badge ${SOURCE[q.source]?.badge || "bg-light text-dark"}`}>{SOURCE[q.source]?.label || q.source}</span>
          {q.category && <span className="badge bg-light text-dark border">{q.category}</span>}
          {q.has_placeholders && <span className="badge bg-warning text-dark">has blanks</span>}
          {(q.asked_in || []).map((id) => (
            <span key={id} className="badge bg-light text-danger border border-danger-subtle">
              {interviews[id] ? `${interviews[id].company} · ${interviews[id].date}` : id}
            </span>
          ))}
        </div>
        <h3 className="h6 mb-3">{q.question}</h3>
        {hidden ? (
          <button type="button" className="btn btn-sm btn-outline-primary rounded-pill" onClick={() => setShown(true)}>
            Show answer
          </button>
        ) : (
          <>
            {q.answer_en && (
              <blockquote className="border-start border-3 ps-3 mb-3">
                <WithBlanks text={q.answer_en} />
              </blockquote>
            )}
            {q.notes_fa && (
              <div className="small text-body-secondary mb-2" dir="rtl">
                <WithBlanks text={q.notes_fa} />
              </div>
            )}
            {practice && (
              <button type="button" className="btn btn-sm btn-link px-0" onClick={() => setShown(false)}>
                Hide answer
              </button>
            )}
          </>
        )}
        {q.follow_ups?.length > 0 && (
          <div className="small mt-2">
            <span className="text-muted">Follow-ups: </span>
            {q.follow_ups.map((id, i) => (
              <Fragment key={id}>
                {i > 0 && " · "}
                <a href={`#${anchor(id)}`} onClick={(e) => { e.preventDefault(); onJump(id); }}>
                  {titles[id] || id}
                </a>
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function InterviewsPage() {
  const [bank, setBank] = useState(null);
  const [error, setError] = useState(null);
  const [source, setSource] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [blanksOnly, setBlanksOnly] = useState(false);
  const [practice, setPractice] = useState(false);
  const [openRecord, setOpenRecord] = useState(null);

  useEffect(() => {
    fetchInterviews().then(setBank).catch((e) => setError(e.message));
  }, []);

  const interviews = useMemo(() => Object.fromEntries((bank?.interviews || []).map((i) => [i.id, i])), [bank]);
  const titles = useMemo(() => Object.fromEntries((bank?.questions || []).map((q) => [q.id, q.question])), [bank]);
  const categories = useMemo(() => [...new Set((bank?.questions || []).map((q) => q.category).filter(Boolean))].sort(), [bank]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!bank) return <div className="text-muted">Loading…</div>;

  const needle = search.trim().toLowerCase();
  const questions = bank.questions.filter(
    (q) =>
      (!source || q.source === source) &&
      (!category || q.category === category) &&
      (!blanksOnly || q.has_placeholders) &&
      (!needle || [q.question, q.answer_en, q.notes_fa, q.id].some((t) => t?.toLowerCase().includes(needle)))
  );
  const count = (key) => bank.questions.filter((q) => q.source === key).length;

  // A follow-up may be filtered out: clear the filters, then scroll to it.
  const jump = (id) => {
    setSource("");
    setCategory("");
    setSearch("");
    setBlanksOnly(false);
    setTimeout(() => document.getElementById(anchor(id))?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-baseline mb-3">
        <h2 className="h4 mb-0">🎤 Interviews</h2>
        {bank.updated && <span className="small text-muted">bank updated {bank.updated}</span>}
      </div>

      {bank.interviews.length === 0 && bank.questions.length === 0 && (
        <div className="alert alert-light border">
          No interviews yet. Add them to <code>JobSearch/engine/interviews/question_bank.json</code>.
        </div>
      )}

      {bank.interviews.length > 0 && (
        <div className="card mb-4">
          <div className="card-header">Interviews ({bank.interviews.length})</div>
          <ul className="list-group list-group-flush">
            {bank.interviews.map((i) => {
              const asked = bank.questions.filter((q) => q.asked_in?.includes(i.id)).length;
              return (
                <li key={i.id} className="list-group-item">
                  <div className="d-flex flex-wrap justify-content-between align-items-baseline gap-2">
                    <div>
                      <span className="fw-semibold">{i.company}</span> — {i.role}
                      <div className="small text-muted">
                        {i.date}
                        {i.format && ` · ${i.format}`} · {asked} question{asked === 1 ? "" : "s"} asked
                      </div>
                    </div>
                    <div className="d-flex align-items-center gap-2 small">
                      <span className={`badge ${i.outcome ? "bg-info text-dark" : "bg-light text-dark border"}`}>
                        {i.outcome || "outcome pending"}
                      </span>
                      {i.tracked ? (
                        <Link to={`/applications/${encodeURIComponent(i.application_folder)}`}>Application →</Link>
                      ) : (
                        <span className="text-muted" title={i.application_folder}>not in the ledger</span>
                      )}
                      {i.recordText && (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary rounded-pill"
                          onClick={() => setOpenRecord(openRecord === i.id ? null : i.id)}
                        >
                          {openRecord === i.id ? "Hide notes" : "Notes"}
                        </button>
                      )}
                    </div>
                  </div>
                  {openRecord === i.id && (
                    <pre className="mt-3 mb-0 small" dir="auto" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
                      {i.recordText}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {bank.questions.length > 0 && (
        <>
          <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
            <div className="btn-group btn-group-sm" role="group" aria-label="Source">
              <button type="button" className={`btn btn-outline-secondary${!source ? " active" : ""}`} onClick={() => setSource("")}>
                All {bank.questions.length}
              </button>
              {SOURCES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`btn btn-outline-secondary${source === s.key ? " active" : ""}`}
                  onClick={() => setSource(source === s.key ? "" : s.key)}
                >
                  {s.label} {count(s.key)}
                </button>
              ))}
            </div>
            <select
              className="form-select form-select-sm w-auto"
              aria-label="Category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input
              type="search"
              className="form-control form-control-sm w-auto flex-grow-1"
              style={{ minWidth: 160 }}
              placeholder="Search questions and answers"
              dir="auto"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="form-check form-switch mb-0">
              <input id="iv-blanks" className="form-check-input" type="checkbox" checked={blanksOnly} onChange={(e) => setBlanksOnly(e.target.checked)} />
              <label className="form-check-label small" htmlFor="iv-blanks">Has blanks</label>
            </div>
            <div className="form-check form-switch mb-0">
              <input id="iv-practice" className="form-check-input" type="checkbox" checked={practice} onChange={(e) => setPractice(e.target.checked)} />
              <label className="form-check-label small" htmlFor="iv-practice" title="Hide the answers: say yours out loud first">
                Practice mode
              </label>
            </div>
          </div>

          {questions.length === 0 ? (
            <div className="text-muted">No question matches these filters.</div>
          ) : (
            questions.map((q) => (
              // Keyed by practice mode too, so switching it resets every "Show answer".
              <QuestionCard key={`${q.id}-${practice}`} q={q} interviews={interviews} titles={titles} practice={practice} onJump={jump} />
            ))
          )}
        </>
      )}
    </div>
  );
}
