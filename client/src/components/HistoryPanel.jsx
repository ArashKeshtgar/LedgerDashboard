import { useEffect, useState } from "react";
import { fetchCommit, fetchHistory } from "../api.js";
import { DiffView, formatDate } from "./TruthBits.jsx";

// The engine's git history, optionally narrowed to one fact id or gap slug
// (every dashboard commit names what it changed in its message).
export default function HistoryPanel({ q, onClose }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setOpen(null);
    fetchHistory(q).then(setData).catch((e) => setError(e.message));
  }, [q]);

  async function toggle(hash) {
    if (open?.hash === hash) return setOpen(null);
    try {
      setOpen(await fetchCommit(hash));
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="card mb-3 border-primary-subtle">
      <div className="card-header d-flex justify-content-between align-items-center">
        <span>
          🕘 History {q ? <span className="font-monospace small">— {q}</span> : "— whole truth bank"}
        </span>
        <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
      </div>
      <div className="card-body">
        {error && <div className="alert alert-danger py-2">{error}</div>}
        {!data && !error && <div className="text-muted small">Loading…</div>}
        {data && !data.enabled && (
          <div className="text-muted small">The engine folder isn't a git repository, so there's no history.</div>
        )}
        {data?.enabled && data.commits.length === 0 && (
          <div className="text-muted small">
            No commits mention {q ? "this" : "the truth bank"} yet — the history starts with the first save from
            this page.
          </div>
        )}
        <ul className="list-group list-group-flush">
          {data?.commits.map((c) => (
            <li key={c.hash} className="list-group-item px-0">
              <button type="button" className="btn btn-link p-0 text-start text-decoration-none" onClick={() => toggle(c.hash)}>
                <span className="font-monospace small text-muted me-2">{c.hash}</span>
                {c.subject}
              </button>
              <span className="small text-muted ms-2">{formatDate(c.date)}</span>
              {open?.hash === c.hash && (
                <div className="mt-2">
                  <DiffView diff={open.diff} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
