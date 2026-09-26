import { useState } from "react";
import { CONTACT_SOURCES } from "../contact.js";

// Name / email / where-it-came-from form for the hiring contact. Used both
// inline when marking an application as sent and on the Contact card.
// onSave gets the four fields; the server does the real validation and its
// message (e.g. "only published or verified addresses") is shown here.
export default function ContactEditor({ initial = {}, onSave, onCancel, saveLabel = "Save", saving, extraActions }) {
  const [name, setName] = useState(initial.contact_name || "");
  const [email, setEmail] = useState(initial.contact_email || "");
  const [source, setSource] = useState(initial.contact_source || "");
  const [verified, setVerified] = useState(initial.contact_verified === "true");

  const needsVerify = source === "found";

  function submit(e) {
    e.preventDefault();
    onSave({
      contact_name: name,
      contact_email: email,
      contact_source: email ? source : "",
      contact_verified: needsVerify ? verified : undefined,
    });
  }

  return (
    <form className="row g-2 align-items-end" onSubmit={submit}>
      <div className="col-sm-4">
        <label className="form-label small mb-1">Name</label>
        <input className="form-control form-control-sm" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Jane Doe" />
      </div>
      <div className="col-sm-4">
        <label className="form-label small mb-1">Email</label>
        <input type="email" className="form-control form-control-sm" value={email} dir="ltr"
          onChange={(e) => setEmail(e.target.value)} placeholder="jane@company.com" />
      </div>
      <div className="col-sm-4">
        <label className="form-label small mb-1">Where the email came from</label>
        <select className="form-select form-select-sm" value={source} onChange={(e) => setSource(e.target.value)}
          disabled={!email}>
          <option value="">— choose —</option>
          {CONTACT_SOURCES.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </div>

      {needsVerify && (
        <div className="col-12">
          <div className="form-check small">
            <input id="contact-verified" type="checkbox" className="form-check-input" checked={verified}
              onChange={(e) => setVerified(e.target.checked)} />
            <label htmlFor="contact-verified" className="form-check-label">
              I checked this address exists (published on their site, or confirmed with an email verifier) — not a
              guess like careers@ or firstname@.
            </label>
          </div>
        </div>
      )}

      <div className="col-12 d-flex flex-wrap gap-2 mt-2">
        <button type="submit" className="btn btn-sm btn-success rounded-pill" disabled={saving}>
          {saving ? "Saving…" : saveLabel}
        </button>
        {extraActions}
        {onCancel && (
          <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill" disabled={saving}
            onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
