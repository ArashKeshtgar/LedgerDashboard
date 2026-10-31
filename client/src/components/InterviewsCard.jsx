import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchInterviews } from "../api.js";

// The interviews held for this application and the questions asked in each,
// from the question bank (Interviews page). Nothing shows until there's one.
export default function InterviewsCard({ folder }) {
  const [bank, setBank] = useState(null);

  useEffect(() => {
    fetchInterviews().then(setBank).catch(() => setBank(null));
  }, [folder]);

  const held = (bank?.interviews || []).filter((i) => i.application_folder === folder);
  if (held.length === 0) return null;

  return (
    <div className="card mb-4">
      <div className="card-header d-flex justify-content-between align-items-center">
        <span>🎤 Interviews</span>
        <Link to="/interviews" className="small">Question bank →</Link>
      </div>
      <ul className="list-group list-group-flush">
        {held.map((i) => {
          const asked = bank.questions.filter((q) => q.asked_in?.includes(i.id));
          return (
            <li key={i.id} className="list-group-item">
              <div className="d-flex flex-wrap gap-2 align-items-baseline">
                <span className="fw-semibold">{i.date}</span>
                {i.format && <span className="small text-muted">{i.format}</span>}
                <span className={`badge ms-auto ${i.outcome ? "bg-info text-dark" : "bg-light text-dark border"}`}>
                  {i.outcome || "outcome pending"}
                </span>
              </div>
              {asked.length > 0 && (
                <ul className="small mt-2 mb-0">
                  {asked.map((q) => <li key={q.id}>{q.question}</li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
