import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchSimilar } from "../api.js";

// The saved postings most like this one (same stack, role, industry) and how
// each went — computed on the server from the saved posting texts, no model
// call. Very close matches are flagged: often the same job via an agency.
const DUPLICATE_AT = 0.85;

export default function SimilarPostingsCard({ folder, stageLabels }) {
  const [list, setList] = useState(null);

  useEffect(() => {
    setList(null);
    fetchSimilar(folder).then(setList).catch(() => setList([]));
  }, [folder]);

  if (!list || list.length === 0) return null;

  const badge = (r) => {
    const meta = stageLabels.get(r.stage);
    const tone = r.stage === "rejected" ? "text-bg-danger"
      : r.isTerminal ? "text-bg-secondary"
      : r.stage === "draft" ? "text-bg-light border"
      : /interview|offer/.test(r.stage) ? "text-bg-success"
      : "text-bg-primary";
    return <span className={`badge rounded-pill ${tone}`}>{meta ? `${meta.icon} ${meta.label}` : r.stage}</span>;
  };

  return (
    <div className="card mb-4">
      <div className="card-header">🔎 Similar postings you saved</div>
      <ul className="list-group list-group-flush">
        {list.map((r) => (
          <li key={r.folder} className="list-group-item">
            <div className="d-flex flex-wrap align-items-center gap-2">
              <span className="fw-semibold" style={{ minWidth: "3.2em" }}>{Math.round(r.similarity * 100)}%</span>
              <Link to={`/applications/${encodeURIComponent(r.folder)}`}>{r.company} — {r.role}</Link>
              {badge(r)}
              <span className="small text-muted ms-auto">
                {r.date}{r.match_score ? ` · score ${r.match_score}` : ""}
              </span>
            </div>
            {r.similarity >= DUPLICATE_AT && (
              <div className="small text-warning-emphasis mt-1">
                ⚠️ Nearly the same stack and role — possibly the same job posted by another company or agency.
              </div>
            )}
            {r.shared.length > 0 && (
              <div className="small text-muted mt-1">In common: {r.shared.join(", ")}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
