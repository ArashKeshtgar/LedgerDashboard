import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchApplication, fetchPipelineStages, moveApplicationStage } from "../api.js";
import StageTimeline from "../components/StageTimeline.jsx";

function Field({ label, value }) {
  if (!value) return null;
  return (
    <div className="col-sm-6 mb-3">
      <div className="detail-field-label">{label}</div>
      <div>{value}</div>
    </div>
  );
}

export default function ApplicationDetail() {
  const { id } = useParams();
  const [app, setApp] = useState(null);
  const [stages, setStages] = useState({ stages: [], terminal: [] });
  const [error, setError] = useState(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState(null);

  useEffect(() => {
    setApp(null);
    fetchApplication(id).then(setApp).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    fetchPipelineStages().then(setStages).catch(() => {});
  }, []);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!app) return <div className="text-center py-5 text-muted">Loading…</div>;

  async function handleApprove() {
    setApproveError(null);
    setApproving(true);
    try {
      const updated = await moveApplicationStage(app.folder, "applied");
      setApp((a) => ({ ...a, ...updated }));
    } catch (e) {
      setApproveError(e.message);
    } finally {
      setApproving(false);
    }
  }

  return (
    <div>
      <Link to="/" className="btn btn-sm btn-outline-secondary rounded-pill mb-3">
        ← Back to list
      </Link>

      {approveError && (
        <div className="alert alert-danger py-2 px-3 mb-3" role="alert">
          {approveError}
        </div>
      )}

      {app.stage === "draft" && (
        <div className="alert alert-warning d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
          <span>📝 This package hasn't been sent yet — it won't show up on the Pipeline or count in Stats until approved.</span>
          <button
            type="button"
            className="btn btn-sm btn-success rounded-pill"
            disabled={approving}
            onClick={handleApprove}
          >
            {approving ? "Approving…" : "✅ Approve & Apply"}
          </button>
        </div>
      )}

      <div className="card mb-4">
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
            <div>
              <h4 className="mb-0 page-title">{app.company}</h4>
              <div className="text-muted">{app.role}</div>
            </div>
            <span className="badge bg-dark fs-6">{app.match_score}% match</span>
          </div>

          <hr />

          <div className="row">
            <Field label="Location" value={app.location} />
            <Field label="Branch" value={app.branch} />
            <Field label="Source" value={app.source} />
            <Field label="Poster type" value={app.poster_type} />
            <Field label="End client" value={app.end_client} />
            <Field label="Applied via" value={app.applied_via} />
            <Field label="Date seen" value={app.date_seen} />
            <Field label="Date posted" value={app.date_posted} />
            <Field label="Variant" value={app.variant} />
            <Field label="Gap tags" value={app.gap_tags} />
            <Field label="Last contact" value={app.last_contact} />
            <Field label="Next action" value={app.next_action} />
            <Field label="Outcome" value={app.outcome} />
          </div>

          {app.posting_url && (
            <div className="mt-1">
              <a href={app.posting_url} target="_blank" rel="noreferrer">
                View original posting ↗
              </a>
            </div>
          )}

          {app.notes && (
            <div className="mt-3 pt-3 border-top">
              <div className="detail-field-label mb-1">Notes</div>
              <div className="fst-italic text-secondary">{app.notes}</div>
            </div>
          )}
        </div>
      </div>

      {stages.stages && stages.stages.length > 0 && (
        <div className="card mb-4">
          <div className="card-header">Pipeline stage</div>
          <div className="card-body">
            <StageTimeline
              stages={stages.stages}
              terminal={stages.terminal}
              current={app.stage}
              history={app.stageHistory}
            />
            {app.stageHistory && app.stageHistory.length > 0 && (
              <ul className="list-unstyled mt-3 mb-0 small text-muted">
                {app.stageHistory.map((h, i) => (
                  <li key={i}>
                    <span className="fw-semibold">{h.date}</span> — {h.stage}
                    {h.note ? ` · ${h.note}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {app.matchReport && (
        <div className="card mb-4">
          <div className="card-header">Match Report</div>
          <div className="card-body">
            <pre className="mb-0" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
              {app.matchReport}
            </pre>
          </div>
        </div>
      )}

      {app.interviewQuestions && (
        <div className="card mb-4">
          <div className="card-header">Interview Questions</div>
          <div className="card-body">
            <pre className="mb-0" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
              {app.interviewQuestions}
            </pre>
          </div>
        </div>
      )}

      {app.files && app.files.length > 0 && (
        <div className="card mb-4">
          <div className="card-header">Files in application folder</div>
          <ul className="list-group list-group-flush">
            {app.files.map((f) => (
              <li key={f} className="list-group-item">{f}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
