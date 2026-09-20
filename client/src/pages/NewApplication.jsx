import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { createApplication } from "../api.js";

const SOURCES = ["linkedin", "indeed", "ziprecruiter", "company_site", "referral", "agency", "other"];

export default function NewApplication() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    company: "",
    role: "",
    location: "",
    branch: "",
    source: "linkedin",
    posting_url: "",
    match_score: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.company.trim() || !form.role.trim()) {
      setError("Company and role are required.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const created = await createApplication(form);
      navigate(`/applications/${created.id}`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <Link to="/" className="btn btn-sm btn-outline-secondary rounded-pill mb-3">
        ← Back to list
      </Link>

      <div className="card">
        <div className="card-header">Add application</div>
        <div className="card-body">
          {error && (
            <div className="alert alert-danger py-2 px-3" role="alert">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="mb-3">
              <label className="form-label">Company *</label>
              <input
                className="form-control"
                value={form.company}
                onChange={set("company")}
                required
              />
            </div>

            <div className="mb-3">
              <label className="form-label">Role *</label>
              <input className="form-control" value={form.role} onChange={set("role")} required />
            </div>

            <div className="row">
              <div className="col-sm-6 mb-3">
                <label className="form-label">Location</label>
                <input className="form-control" value={form.location} onChange={set("location")} />
              </div>
              <div className="col-sm-6 mb-3">
                <label className="form-label">Branch</label>
                <input className="form-control" value={form.branch} onChange={set("branch")} />
              </div>
            </div>

            <div className="row">
              <div className="col-sm-6 mb-3">
                <label className="form-label">Source</label>
                <select className="form-select" value={form.source} onChange={set("source")}>
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-sm-6 mb-3">
                <label className="form-label">Match score</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  className="form-control"
                  value={form.match_score}
                  onChange={set("match_score")}
                />
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
              />
            </div>

            <div className="mb-3">
              <label className="form-label">Notes</label>
              <textarea
                className="form-control"
                rows={3}
                value={form.notes}
                onChange={set("notes")}
              />
            </div>

            <div className="small text-muted mb-3">
              Starts in <strong>📝 Draft</strong> — use Approve &amp; Apply once it's actually
              sent, so it doesn't show up on the Pipeline or count in Stats until then.
            </div>

            <button type="submit" className="btn btn-primary rounded-pill" disabled={saving}>
              {saving ? "Saving…" : "Add application"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
