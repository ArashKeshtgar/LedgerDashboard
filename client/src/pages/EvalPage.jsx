import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchEvalItems, fetchEvalReport, saveEvalLabel } from "../api.js";
import { TrackBadge } from "../components/TrackBadge.jsx";

// How good is the model's match score? Arash labels each saved posting
// "apply" or "skip" from the posting alone — the score is never shown while
// labeling, so the label can't lean on it — and the Report tab measures the
// model against those labels.

const MIN_RELIABLE = 30;
const SOURCE_LABELS = {
  engine: "Analyze (dashboard)",
  "nightly-estimate": "🌙 Nightly estimate",
  legacy: "Older rows (ledger score)",
};

function LabelTab({ onLabeled }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [onlyUnlabeled, setOnlyUnlabeled] = useState(true);
  const [track, setTrack] = useState("all");
  const [index, setIndex] = useState(0);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchEvalItems().then(setItems).catch((e) => setError(e.message));
  }, []);

  // The queue is fixed when the filter changes, not on every label, so a
  // posting labeled a moment ago stays reachable with ← Prev.
  const [queue, setQueue] = useState([]);
  useEffect(() => {
    if (!items) return;
    setQueue(
      items
        .filter((i) => track === "all" || i.track === track)
        .filter((i) => !onlyUnlabeled || !i.label)
        .map((i) => i.folder)
    );
    setIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items === null, onlyUnlabeled, track]);

  const byFolder = useMemo(() => Object.fromEntries((items || []).map((i) => [i.folder, i])), [items]);
  const current = byFolder[queue[index]];
  useEffect(() => setNote(current?.note || ""), [current?.folder]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = useCallback(
    async (value) => {
      if (!current || saving) return;
      setSaving(true);
      try {
        const saved = await saveEvalLabel(current.folder, value, note);
        setItems((list) => list.map((i) => (i.folder === current.folder ? { ...i, ...saved } : i)));
        onLabeled?.();
        if (value !== null) setIndex((n) => Math.min(n + 1, queue.length));
      } catch (e) {
        setError(e.message);
      } finally {
        setSaving(false);
      }
    },
    [current, note, saving, queue.length, onLabeled]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest("input, textarea")) return;
      if (e.key === "a") label("apply");
      else if (e.key === "s") label("skip");
      else if (e.key === "ArrowLeft") setIndex((n) => Math.max(0, n - 1));
      else if (e.key === "ArrowRight") setIndex((n) => Math.min(queue.length, n + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [label, queue.length]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!items) return <div className="text-muted">Loading…</div>;

  const done = items.filter((i) => i.label).length;

  return (
    <>
      <div className="d-flex flex-wrap gap-3 align-items-center mb-3">
        <div className="flex-grow-1" style={{ minWidth: 200 }}>
          <div className="small text-muted mb-1">
            {done} of {items.length} postings labeled
            {done < MIN_RELIABLE && ` · ${MIN_RELIABLE - done} more before the numbers mean much`}
          </div>
          <div className="progress" style={{ height: 8 }}>
            <div className="progress-bar" style={{ width: `${(done / Math.max(1, items.length)) * 100}%` }} />
          </div>
        </div>
        <select className="form-select form-select-sm w-auto" value={track} onChange={(e) => setTrack(e.target.value)}>
          <option value="all">All tracks</option>
          <option value="dev">💻 Developer</option>
          <option value="it">🛠️ IT Support</option>
        </select>
        <div className="form-check form-switch mb-0">
          <input
            id="only-unlabeled"
            className="form-check-input"
            type="checkbox"
            checked={onlyUnlabeled}
            onChange={(e) => setOnlyUnlabeled(e.target.checked)}
          />
          <label className="form-check-label small" htmlFor="only-unlabeled">Unlabeled only</label>
        </div>
      </div>

      {!current ? (
        <div className="card card-body text-center text-muted">
          {queue.length ? "End of this list. 🎉" : "Nothing to label with these filters."}
          {index > 0 && (
            <button type="button" className="btn btn-sm btn-link" onClick={() => setIndex((n) => n - 1)}>← Back</button>
          )}
        </div>
      ) : (
        <div className="card">
          <div className="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
            <div>
              <span className="fw-semibold">{current.company}</span> — {current.role}
              <TrackBadge track={current.track} className="ms-2" />
              <div className="small text-muted">
                {[current.location, current.date].filter(Boolean).join(" · ")}
              </div>
            </div>
            <div className="small text-muted">
              {index + 1} / {queue.length}
              {current.label && (
                <span className={`badge ms-2 ${current.label === "apply" ? "text-bg-success" : "text-bg-secondary"}`}>
                  labeled: {current.label}
                </span>
              )}
            </div>
          </div>
          <div className="card-body">
            <div
              className="border rounded p-3 mb-3 small"
              style={{ whiteSpace: "pre-wrap", maxHeight: "50vh", overflowY: "auto" }}
            >
              {current.posting}
            </div>
            <p className="small text-muted mb-2">
              Knowing your real experience, would this posting have been worth applying to? Judge
              from the posting only — the model's score stays hidden here.
            </p>
            <input
              className="form-control form-control-sm mb-3"
              placeholder="Why (optional) — e.g. needs Java, too senior, perfect C#/SQL fit"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="d-flex flex-wrap gap-2 align-items-center">
              <button type="button" className="btn btn-success" disabled={saving} onClick={() => label("apply")}>
                ✅ Apply <kbd className="ms-1">A</kbd>
              </button>
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => label("skip")}>
                ⛔ Skip <kbd className="ms-1">S</kbd>
              </button>
              {current.label && (
                <button type="button" className="btn btn-sm btn-link text-danger" disabled={saving} onClick={() => label(null)}>
                  Remove label
                </button>
              )}
              <div className="ms-auto btn-group btn-group-sm">
                <button type="button" className="btn btn-outline-secondary" disabled={index === 0} onClick={() => setIndex((n) => n - 1)}>
                  ← Prev
                </button>
                <button type="button" className="btn btn-outline-secondary" onClick={() => setIndex((n) => n + 1)}>
                  Next →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ title, value, hint }) {
  return (
    <div className="col-6 col-md-3">
      <div className="text-muted small" title={hint}>{title}</div>
      <div className="fs-4 fw-semibold">{value ?? "—"}</div>
    </div>
  );
}

const pctText = (v) => (v === null || v === undefined ? "—" : `${v}%`);

function ReportTab() {
  const [threshold, setThreshold] = useState(70);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchEvalReport(threshold).then(setReport).catch((e) => setError(e.message));
  }, [threshold]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!report) return <div className="text-muted">Loading…</div>;
  const o = report.overall;

  return (
    <>
      {report.labeled < MIN_RELIABLE && (
        <div className="alert alert-warning small">
          Only {report.labeled} labeled postings — at least {MIN_RELIABLE} are needed before these
          percentages say much. One label more or less still moves them a lot.
        </div>
      )}

      <div className="card mb-4">
        <div className="card-body">
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
            <div className="small text-muted">
              {report.labeled} labeled ({report.apply} apply · {report.skip} skip) · {report.unlabeled} not yet
              {report.noScore > 0 && ` · ${report.noScore} labeled without a model score`}
            </div>
            <label className="small d-flex align-items-center gap-2 mb-0">
              Model says "apply" at score ≥
              <input
                type="number"
                className="form-control form-control-sm"
                style={{ width: 80 }}
                min={0}
                max={100}
                step={5}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="row g-3">
            <Stat title="Accuracy" value={pctText(o.accuracy)} hint="Share of labeled postings where the model and you agree" />
            <Stat title="Precision" value={pctText(o.precision)} hint="Of the postings the model would apply to, how many you would too" />
            <Stat title="Recall" value={pctText(o.recall)} hint="Of the postings you'd apply to, how many the model caught" />
            <Stat
              title="Mean score: apply / skip"
              value={o.meanApply === null && o.meanSkip === null ? "—" : `${o.meanApply ?? "—"} / ${o.meanSkip ?? "—"}`}
              hint="A model that separates well scores your 'apply' postings clearly higher"
            />
          </div>
          {o.n > 0 && (
            <div className="small text-muted mt-3">
              Confusion at {threshold}: {o.tp} agreed apply · {o.tn} agreed skip · {o.fp} false alarms
              (model apply, you skip) · {o.fn} missed (you apply, model skip).
              {o.best && o.best.threshold !== threshold && (
                <> Best threshold on these labels: <strong>{o.best.threshold}</strong> ({o.best.accuracy}%).</>
              )}
              {report.recommendation && (
                <> The model's own apply/skip recommendation agrees {report.recommendation.accuracy}% of the time ({report.recommendation.n} postings).</>
              )}
            </div>
          )}
        </div>
      </div>

      {Object.keys(report.bySource).length > 0 && (
        <div className="card mb-4">
          <div className="card-header">By who scored it</div>
          <div className="table-responsive">
            <table className="table table-sm mb-0 align-middle">
              <thead>
                <tr>
                  <th>Scorer</th>
                  <th className="text-end">Postings</th>
                  <th className="text-end">Accuracy</th>
                  <th className="text-end">Precision</th>
                  <th className="text-end">Recall</th>
                  <th className="text-end">Mean apply / skip</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(report.bySource).map(([s, r]) => (
                  <tr key={s}>
                    <td>{SOURCE_LABELS[s] || s}</td>
                    <td className="text-end">{r.n}</td>
                    <td className="text-end fw-semibold">{pctText(r.accuracy)}</td>
                    <td className="text-end">{pctText(r.precision)}</td>
                    <td className="text-end">{pctText(r.recall)}</td>
                    <td className="text-end">{r.meanApply ?? "—"} / {r.meanSkip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {o.n > 0 && (
        <details className="card mb-4">
          <summary className="card-header" style={{ cursor: "pointer" }}>Accuracy at each threshold</summary>
          <div className="table-responsive">
            <table className="table table-sm mb-0 text-center">
              <thead>
                <tr>
                  <th className="text-start">Threshold</th>
                  {o.sweep.map((s) => <th key={s.threshold} className={s.threshold === threshold ? "text-primary" : ""}>{s.threshold}</th>)}
                </tr>
              </thead>
              <tbody>
                {["accuracy", "precision", "recall"].map((k) => (
                  <tr key={k}>
                    <td className="text-start text-capitalize small">{k}</td>
                    {o.sweep.map((s) => <td key={s.threshold} className="small">{pctText(s[k])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="card">
        <div className="card-header">
          Where the model disagrees with you <span className="small text-muted">— biggest miss first; this is where to look for the cause</span>
        </div>
        {report.mistakes.length === 0 ? (
          <div className="card-body text-muted">{o.n ? "No disagreements at this threshold." : "Label some postings first."}</div>
        ) : (
          <ul className="list-group list-group-flush">
            {report.mistakes.map((m) => (
              <li key={m.folder} className="list-group-item">
                <div className="d-flex flex-wrap justify-content-between gap-2">
                  <div>
                    <Link to={`/applications/${encodeURIComponent(m.folder)}`}>{m.company}</Link>
                    <span className="text-muted"> — {m.role}</span>
                  </div>
                  <div className="small">
                    <span className={`badge ${m.kind === "missed" ? "text-bg-warning" : "text-bg-danger"}`}>
                      {m.kind === "missed" ? "Missed: you'd apply" : "False alarm: you'd skip"}
                    </span>
                    <span className="ms-2">score {m.score}</span>
                    <span className="text-muted ms-1">({SOURCE_LABELS[m.source] || m.source})</span>
                  </div>
                </div>
                {m.note && <div className="small mt-1">📝 You: {m.note}</div>}
                {m.reasoning && <div className="small text-muted mt-1">🤖 Model: {m.reasoning}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export default function EvalPage() {
  const [tab, setTab] = useState("label");
  return (
    <div>
      <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
        <h2 className="h4 mb-0">🎯 Evaluation — is the match score right?</h2>
        <div className="btn-group btn-group-sm">
          <button type="button" className={`btn ${tab === "label" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setTab("label")}>
            Label postings
          </button>
          <button type="button" className={`btn ${tab === "report" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setTab("report")}>
            Report
          </button>
        </div>
      </div>
      {tab === "label" ? <LabelTab /> : <ReportTab />}
    </div>
  );
}
