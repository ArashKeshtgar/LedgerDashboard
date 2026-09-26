import { useState } from "react";
import ContactEditor from "./ContactEditor.jsx";
import { sourceLabel } from "../contact.js";

// The hiring contact for this application: who a follow-up email goes to.
export default function ContactCard({ app, onSave }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function save(fields) {
    setSaving(true);
    setError(null);
    try {
      await onSave(fields);
      setEditing(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card mb-4">
      <div className="card-header d-flex justify-content-between align-items-center">
        <span>Hiring contact</span>
        {!editing && (
          <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setEditing(true)}>
            ✏️ {app.contact_email || app.contact_name ? "Edit" : "Add"}
          </button>
        )}
      </div>
      <div className="card-body">
        {editing ? (
          <ContactEditor initial={app} onSave={save} onCancel={() => { setEditing(false); setError(null); }}
            saving={saving} />
        ) : app.contact_email || app.contact_name ? (
          <div className="small">
            <div className="fw-semibold">{app.contact_name || "—"}</div>
            {app.contact_email && (
              <div>
                <a href={`mailto:${app.contact_email}`} dir="ltr">{app.contact_email}</a>
                <span className="text-muted"> · {sourceLabel(app.contact_source)}</span>
                {app.contact_verified === "true" && <span className="badge bg-success-subtle text-success ms-2">verified</span>}
              </div>
            )}
          </div>
        ) : (
          <div className="small text-muted">
            No contact yet. Best time to add one is when you apply: the posting itself, the ATS confirmation
            email, or the hiring team listed on the posting.
          </div>
        )}
        {error && (
          <div className="alert alert-danger py-2 px-3 mt-2 mb-0" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
