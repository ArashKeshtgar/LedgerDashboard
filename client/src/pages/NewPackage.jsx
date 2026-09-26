import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { analyzePosting, buildPackage, deleteApplication } from "../api.js";

const SOURCES = ["linkedin", "indeed", "ziprecruiter", "company_site", "referral", "agency", "other"];

function scoreColor(score) {
  if (score >= 55) return "#0ca30c";
  if (score >= 40) return "#fab219";
  return "#d03b3b";
}

const RECOMMENDATION_LABEL = {
  apply: { text: "✅ Apply", className: "bg-success" },
  apply_with_caveats: { text: "⚠️ Apply with caveats", className: "bg-warning text-dark" },
  skip: { text: "⛔ Skip", className: "bg-secondary" },
};

export default function NewPackage() {
  const navigate = useNavigate();
  const [step, setStep] = useState("form"); // form | analyzing | analyzed | building | error
  const [form, setForm] = useState({
    company: "",
    role: "",
    postingText: "",
    location: "",
    source: "linkedin",
    posting_url: "",
  });
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [errorDetails, setErrorDetails] = useState(null);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleAnalyze(e) {
    e.preventDefault();
    if (!form.company.trim() || !form.role.trim() || !form.postingText.trim()) {
      setError("Company, role and the posting text are all required.");
      return;
    }
    setError(null);
    setStep("analyzing");
    try {
      const result = await analyzePosting(form);
      setAnalysis(result);
      setStep("analyzed");
    } catch (err) {
      setError(err.message);
      setStep("form");
    }
  }

  async function handleDecision(decision) {
    if (decision === "skip") {
      setStep("building"); // reuse as a generic "busy" state to disable the buttons
      try {
        await deleteApplication(analysis.id);
      } catch {
        // Even if cleanup fails, the user asked to leave — don't trap them here.
      }
      navigate("/");
      return;
    }
    setError(null);
    setErrorDetails(null);
    setStep("building");
    try {
      const created = await buildPackage({
        folder: analysis.folder,
        company: form.company,
        role: form.role,
        postingText: form.postingText,
        base_variant: analysis.base_variant,
        match_score: analysis.match_score,
        gap_tags: analysis.gap_tags,
        caveats: decision === "apply_with_caveats",
      });
      navigate(`/applications/${created.id}`);
    } catch (err) {
      setError(err.message);
      setErrorDetails(err.details || null);
      setStep("analyzed");
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <Link to="/" className="btn btn-sm btn-outline-secondary rounded-pill mb-3">
        ← Back to list
      </Link>

      <div className="card">
        <div className="card-header">🤖 Build a package with AI</div>
        <div className="card-body">
          {error && (
            <div className="alert alert-danger py-2 px-3" role="alert">
              {error}
              {errorDetails && (
                <ul className="mb-0 mt-2 small">
                  {errorDetails.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {(step === "form" || step === "analyzing") && (
            <form onSubmit={handleAnalyze}>
              <div className="row">
                <div className="col-sm-6 mb-3">
                  <label className="form-label">Company *</label>
                  <input
                    className="form-control"
                    value={form.company}
                    onChange={set("company")}
                    disabled={step === "analyzing"}
                    required
                  />
                </div>
                <div className="col-sm-6 mb-3">
                  <label className="form-label">Role *</label>
                  <input
                    className="form-control"
                    value={form.role}
                    onChange={set("role")}
                    disabled={step === "analyzing"}
                    required
                  />
                </div>
              </div>

              <div className="row">
                <div className="col-sm-6 mb-3">
                  <label className="form-label">Location</label>
                  <input
                    className="form-control"
                    value={form.location}
                    onChange={set("location")}
                    disabled={step === "analyzing"}
                  />
                </div>
                <div className="col-sm-6 mb-3">
                  <label className="form-label">Source</label>
                  <select
                    className="form-select"
                    value={form.source}
                    onChange={set("source")}
                    disabled={step === "analyzing"}
                  >
                    {SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mb-3">
                <label className="form-label">Posting URL</label>
                <input
                  type="url"
                  className="form-control"
                  placeholder="https://…"
                  value={form.posting_url}
                  onChange={set("posting_url")}
                  disabled={step === "analyzing"}
                />
              </div>

              <div className="mb-3">
                <label className="form-label">Job posting text *</label>
                <textarea
                  className="form-control"
                  rows={10}
                  placeholder="Paste the full job posting here…"
                  value={form.postingText}
                  onChange={set("postingText")}
                  disabled={step === "analyzing"}
                  required
                />
              </div>

              <button type="submit" className="btn btn-primary rounded-pill" disabled={step === "analyzing"}>
                {step === "analyzing" ? "Analyzing…" : "Analyze"}
              </button>
            </form>
          )}

          {(step === "analyzed" || step === "building") && analysis && (
            <div>
              <div className="d-flex align-items-center gap-3 mb-3">
                <span
                  className="badge rounded-pill fs-5"
                  style={{ background: scoreColor(analysis.match_score) }}
                >
                  {analysis.match_score}%
                </span>
                <span className={`badge ${RECOMMENDATION_LABEL[analysis.recommendation].className}`}>
                  {RECOMMENDATION_LABEL[analysis.recommendation].text}
                </span>
                <span className="text-muted small">base template: {analysis.base_variant}</span>
              </div>

              <div className="text-muted small mb-3">
                📝 Already added as a draft — <strong>Skip</strong> removes it, <strong>Apply</strong>{" "}
                fills it in with the real résumé and cover letter.
              </div>

              {analysis.duplicate && (
                <div className="alert alert-warning py-2 px-3" role="alert">
                  ⚠️ You've applied to <strong>{analysis.duplicate.display}</strong> before
                  {analysis.duplicate.applications?.length > 0 &&
                    ` (${analysis.duplicate.applications.length} time${
                      analysis.duplicate.applications.length === 1 ? "" : "s"
                    } on record)`}
                  .
                </div>
              )}

              <p>{analysis.reasoning}</p>

              {analysis.gaps?.length > 0 && (
                <>
                  <div className="detail-field-label mb-1">Gaps</div>
                  <ul>
                    {analysis.gaps.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </>
              )}

              <div className="d-flex flex-wrap gap-2 mt-3 pt-3 border-top">
                <button
                  type="button"
                  className="btn btn-success rounded-pill"
                  disabled={step === "building"}
                  onClick={() => handleDecision("apply")}
                >
                  {step === "building" ? "Building…" : "✅ Apply — build the full package"}
                </button>
                <button
                  type="button"
                  className="btn btn-warning rounded-pill"
                  disabled={step === "building"}
                  onClick={() => handleDecision("apply_with_caveats")}
                >
                  ⚠️ Apply with caveats
                </button>
                <button
                  type="button"
                  className="btn btn-outline-secondary rounded-pill"
                  disabled={step === "building"}
                  onClick={() => handleDecision("skip")}
                >
                  ⛔ Skip
                </button>
              </div>
              {step === "building" && (
                <div className="text-muted small mt-2">
                  Writing the résumé, cover letter, match report and interview questions — this can
                  take a minute…
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
