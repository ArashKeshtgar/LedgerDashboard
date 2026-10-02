import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { createFact, deleteFact, fetchHealth, fetchTruthBank, updateFact } from "../api.js";
import HistoryPanel from "../components/HistoryPanel.jsx";
import { GapLink, InlineIssues, STRENGTH_CLASS, splitList } from "../components/TruthBits.jsx";

const STRENGTHS = ["strong", "medium", "soft"];
const SECTION_TITLES = { skill: "Technical skills", identity: "Identity / header", edu: "Education" };
const EMPTY = { id: "", claim: "", evidence: "", tags: "", allowed_numbers: "", forbidden: "", strength: "strong" };

const toForm = (f) => ({
  ...f,
  tags: f.tags.join(", "),
  allowed_numbers: f.allowed_numbers.join(", "),
  forbidden: f.forbidden.join(", "),
});
const fromForm = (f) => ({
  id: f.id.trim(),
  claim: f.claim,
  evidence: f.evidence,
  tags: splitList(f.tags),
  allowed_numbers: splitList(f.allowed_numbers),
  forbidden: splitList(f.forbidden),
  strength: f.strength,
});

function FactForm({ initial, isNew, sections, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(fromForm(form), note.trim());
    } catch (err) {
      setError({ message: err.message, details: err.details });
      setSaving(false);
    }
  }

  return (
    <form className="fact-form border rounded-3 p-3 bg-body-tertiary" onSubmit={submit}>
      {isNew && (
        <div className="mb-2">
          <label className="form-label small fw-semibold">id</label>
          <input
            className="form-control form-control-sm font-monospace"
            list="fact-sections"
            placeholder="proj.rebiomed.something"
            value={form.id}
            onChange={set("id")}
            required
          />
          <datalist id="fact-sections">
            {sections.map((s) => (
              <option key={s} value={`${s}.`} />
            ))}
          </datalist>
          <div className="form-text">
            proj.&lt;project&gt;.&lt;name&gt;, exp.&lt;role&gt;.&lt;name&gt;, skill.&lt;name&gt; … — it can't be
            renamed later.
          </div>
        </div>
      )}
      <div className="mb-2">
        <label className="form-label small fw-semibold">Claim — the only text Analyze and Build ever read</label>
        <textarea className="form-control form-control-sm" rows={3} value={form.claim} onChange={set("claim")} required />
        <div className="form-text">
          Name every technology this fact is evidence for (e.g. “MongoDB”) — a tag alone isn't seen by the model.
        </div>
      </div>
      <div className="mb-2">
        <label className="form-label small fw-semibold">Evidence — where this is proven (repo, commit, document)</label>
        <textarea className="form-control form-control-sm" rows={2} value={form.evidence} onChange={set("evidence")} required />
      </div>
      <div className="row g-2 mb-2">
        <div className="col-md-6">
          <label className="form-label small fw-semibold">Tags (comma-separated)</label>
          <input className="form-control form-control-sm font-monospace" value={form.tags} onChange={set("tags")} />
        </div>
        <div className="col-md-3">
          <label className="form-label small fw-semibold">Allowed numbers</label>
          <input className="form-control form-control-sm" value={form.allowed_numbers} onChange={set("allowed_numbers")} placeholder="600, 600+" />
        </div>
        <div className="col-md-3">
          <label className="form-label small fw-semibold">Strength</label>
          <select className="form-select form-select-sm" value={form.strength} onChange={set("strength")}>
            {STRENGTHS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="mb-2">
        <label className="form-label small fw-semibold">Forbidden words/phrases (comma-separated)</label>
        <input className="form-control form-control-sm" value={form.forbidden} onChange={set("forbidden")} placeholder="full-time, led" />
      </div>
      <div className="mb-2">
        <label className="form-label small fw-semibold">What changed? (goes into the history)</label>
        <input className="form-control form-control-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
      </div>
      {error && (
        <div className="alert alert-danger py-2 small">
          {error.message}
          {error.details && (
            <ul className="mb-0">
              {error.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary rounded-pill" disabled={saving}>
          {saving ? "Saving…" : isNew ? "Add fact" : "Save"}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function FactCard({ fact, issues, highlighted, editing, sections, onEdit, onCancel, onSave, onHistory, onDelete, cardRef }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  if (editing) {
    return (
      <div ref={cardRef} className="list-group-item">
        <div className="font-monospace small fw-semibold mb-2">{fact.id}</div>
        <FactForm initial={toForm(fact)} sections={sections} onSave={onSave} onCancel={onCancel} />
      </div>
    );
  }

  const worst = issues.some((i) => i.severity === "error") ? "error" : issues.some((i) => i.severity === "warn") ? "warn" : null;
  return (
    <div ref={cardRef} className={`list-group-item fact-card ${highlighted ? "fact-highlight" : ""} ${worst ? `fact-${worst}` : ""}`}>
      <div className="d-flex flex-wrap justify-content-between gap-2 align-items-start">
        <div className="d-flex flex-wrap gap-2 align-items-center">
          <span className="font-monospace small fw-semibold">{fact.id}</span>
          <span className={`badge rounded-pill ${STRENGTH_CLASS[fact.strength] || "bg-secondary"}`}>{fact.strength}</span>
          {fact.tags.includes("excluded") && <span className="badge rounded-pill bg-dark">excluded</span>}
          {fact.usedIn.length > 0 && (
            <span className="badge rounded-pill bg-primary-subtle text-primary-emphasis" title={fact.usedIn.map((u) => `${u.company} — ${u.role}`).join("\n")}>
              used in {fact.usedIn.length} résumé{fact.usedIn.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="d-flex gap-1">
          <button type="button" className="btn btn-sm btn-outline-secondary py-0" onClick={onEdit}>✏️ Edit</button>
          <button type="button" className="btn btn-sm btn-outline-secondary py-0" onClick={onHistory}>🕘</button>
          <button type="button" className="btn btn-sm btn-outline-danger py-0" onClick={() => setConfirmDelete((v) => !v)}>🗑️</button>
        </div>
      </div>
      <div className="mt-1">{fact.claim}</div>
      <div className="d-flex flex-wrap gap-1 mt-2">
        {fact.tags.map((t) => (
          <span key={t} className="badge rounded-pill text-bg-light border fw-normal">{t}</span>
        ))}
        {fact.allowed_numbers.length > 0 && (
          <span className="badge rounded-pill bg-success-subtle text-success-emphasis fw-normal">
            numbers: {fact.allowed_numbers.join(", ")}
          </span>
        )}
        {fact.forbidden.length > 0 && (
          <span className="badge rounded-pill bg-danger-subtle text-danger-emphasis fw-normal">
            never: {fact.forbidden.join(", ")}
          </span>
        )}
      </div>
      {fact.gaps.length > 0 && (
        <div className="small mt-2">
          <span className="text-muted">Evidence for gap{fact.gaps.length > 1 ? "s" : ""}: </span>
          {fact.gaps.map((g) => (
            <span key={g.slug} className="me-2">
              <GapLink slug={g.slug} status={g.status} />
            </span>
          ))}
        </div>
      )}
      <button type="button" className="btn btn-link btn-sm p-0 mt-1 text-decoration-none" onClick={() => setShowEvidence((v) => !v)}>
        {showEvidence ? "▾" : "▸"} Evidence
      </button>
      {showEvidence && <div className="small text-muted">{fact.evidence}</div>}
      {showEvidence && fact.usedIn.length > 0 && (
        <div className="small mt-1">
          Used in:{" "}
          {fact.usedIn.map((u) => (
            <Link key={u.folder} to={`/resume/${encodeURIComponent(u.folder)}`} className="me-2">
              {u.company} — {u.role}
            </Link>
          ))}
        </div>
      )}
      <InlineIssues issues={issues} />
      {confirmDelete && (
        <div className="d-flex flex-wrap gap-2 align-items-center mt-2 pt-2 border-top">
          <span className="small">Remove {fact.id} from the truth bank? (It stays in the history.)</span>
          <button
            type="button"
            className="btn btn-sm btn-danger rounded-pill"
            onClick={() => onDelete().catch((e) => setDeleteError(e.message))}
          >
            Remove
          </button>
          <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
          {deleteError && <div className="text-danger small w-100">{deleteError}</div>}
        </div>
      )}
    </div>
  );
}

export default function TruthBankPage() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [strength, setStrength] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState(null);
  const [saved, setSaved] = useState(null);
  const highlightRef = useRef(null);
  const focusId = params.get("id");
  const section = params.get("section") || "";

  const load = () =>
    Promise.all([fetchTruthBank(), fetchHealth().catch(() => null)])
      .then(([bank, h]) => {
        setData(bank);
        setHealth(h);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (focusId && data) highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, data]);

  const issuesById = useMemo(() => {
    const m = new Map();
    for (const i of health?.issues || []) {
      if (i.target.type === "fact") m.set(i.target.id, [...(m.get(i.target.id) || []), i]);
    }
    return m;
  }, [health]);

  const sections = useMemo(() => [...new Set((data?.facts || []).map((f) => f.section))], [data]);

  const groups = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const shown = data.facts.filter(
      (f) =>
        (!section || f.section === section) &&
        (!strength || f.strength === strength) &&
        (!onlyIssues || issuesById.has(f.id)) &&
        (!needle || [f.id, f.claim, f.evidence, ...f.tags].join(" ").toLowerCase().includes(needle))
    );
    const bySection = new Map();
    for (const f of shown) bySection.set(f.section, [...(bySection.get(f.section) || []), f]);
    return [...bySection.entries()];
  }, [data, q, section, strength, onlyIssues, issuesById]);

  async function afterSave(message) {
    setEditing(null);
    setAdding(false);
    setSaved(message);
    await load();
  }

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <div className="text-muted">Loading the truth bank…</div>;

  const factIssues = [...issuesById.values()].flat();
  return (
    <div>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div>
          <h4 className="mb-0">🧱 Truth Bank</h4>
          <div className="text-muted small">
            {data.facts.length} facts · {sections.length} sections · {data.trackedBuilds} résumé(s) linked to facts
            {!data.history && " · no git history (engine isn't a repo)"}
          </div>
        </div>
        <div className="d-flex gap-2">
          <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill" onClick={() => setHistory(history === "" ? null : "")}>
            🕘 History
          </button>
          <button type="button" className="btn btn-sm btn-primary rounded-pill" onClick={() => { setAdding(true); setEditing(null); }}>
            + New fact
          </button>
        </div>
      </div>

      {saved && (
        <div className="alert alert-success py-2 d-flex justify-content-between align-items-center">
          <span>{saved}</span>
          <button type="button" className="btn-close" onClick={() => setSaved(null)} aria-label="Close" />
        </div>
      )}
      {data.duplicates.length > 0 && (
        <div className="alert alert-danger py-2">
          Duplicate ids: {data.duplicates.map((d) => `${d.id} (${d.files.join(", ")})`).join("; ")}
        </div>
      )}
      {factIssues.length > 0 && (
        <div className="alert alert-warning py-2 small d-flex flex-wrap justify-content-between align-items-center gap-2">
          <span>
            {factIssues.length} health check{factIssues.length > 1 ? "s" : ""} on facts — the claim text is all the model
            ever reads, so these are the places a posting can be told something you actually have is missing.
          </span>
          <Link to="/health" className="btn btn-sm btn-outline-dark rounded-pill">Open Health</Link>
        </div>
      )}

      {history !== null && <HistoryPanel q={history || undefined} onClose={() => setHistory(null)} />}

      {adding && (
        <div className="card mb-3">
          <div className="card-header">New fact</div>
          <div className="card-body">
            <FactForm
              initial={{ ...EMPTY, id: section ? `${section}.` : "" }}
              isNew
              sections={sections}
              onCancel={() => setAdding(false)}
              onSave={async (fact, note) => {
                const r = await createFact(fact, note);
                await afterSave(`Added ${r.fact.id} to ${r.file}${r.commit ? ` (commit ${r.commit})` : ""}.`);
              }}
            />
          </div>
        </div>
      )}

      <div className="card mb-3">
        <div className="card-body py-2 d-flex flex-wrap gap-2 align-items-center">
          <input
            className="form-control form-control-sm"
            style={{ maxWidth: 260 }}
            placeholder="Search id, claim, evidence, tag…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="form-select form-select-sm"
            style={{ maxWidth: 220 }}
            value={section}
            onChange={(e) => setParams(e.target.value ? { section: e.target.value } : {})}
          >
            <option value="">All sections</option>
            {sections.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select className="form-select form-select-sm" style={{ maxWidth: 140 }} value={strength} onChange={(e) => setStrength(e.target.value)}>
            <option value="">Any strength</option>
            {STRENGTHS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <div className="form-check form-switch mb-0">
            <input className="form-check-input" type="checkbox" id="only-issues" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
            <label className="form-check-label small" htmlFor="only-issues">Only facts with health checks</label>
          </div>
        </div>
      </div>

      {groups.length === 0 && <div className="text-muted">No facts match.</div>}
      {groups.map(([sec, facts]) => {
        const variants = data.sectionVariants[sec];
        const isBulletSection = sec.startsWith("proj.") || sec.startsWith("exp.");
        return (
          <div key={sec} className="card mb-3">
            <div className="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
              <span>
                <span className="font-monospace fw-semibold">{sec}</span>
                {SECTION_TITLES[sec] && <span className="text-muted ms-2">{SECTION_TITLES[sec]}</span>}
                <span className="text-muted small ms-2">{facts.length} fact{facts.length > 1 ? "s" : ""}</span>
              </span>
              {isBulletSection && (
                <span className="small">
                  {variants === undefined ? (
                    <span className="badge bg-danger">no template section — build.py can't place these</span>
                  ) : (
                    <>
                      <span className="text-muted">in templates: </span>
                      {variants.map((v) => (
                        <Link key={v} to={`/resume?variant=${v}`} className="badge rounded-pill text-bg-light border me-1">
                          {v}
                        </Link>
                      ))}
                    </>
                  )}
                </span>
              )}
            </div>
            <div className="list-group list-group-flush">
              {facts.map((f) => (
                <FactCard
                  key={f.id}
                  fact={f}
                  issues={issuesById.get(f.id) || []}
                  highlighted={f.id === focusId}
                  cardRef={f.id === focusId ? highlightRef : undefined}
                  editing={editing === f.id}
                  sections={sections}
                  onEdit={() => { setEditing(f.id); setAdding(false); }}
                  onCancel={() => setEditing(null)}
                  onHistory={() => setHistory(f.id)}
                  onSave={async (fact, note) => {
                    const r = await updateFact(f.id, fact, note);
                    await afterSave(`Saved ${f.id}${r.commit ? ` (commit ${r.commit})` : ""}. Drafts analyzed before this change are listed on Health.`);
                  }}
                  onDelete={async () => {
                    const r = await deleteFact(f.id);
                    await afterSave(`Removed ${f.id}${r.commit ? ` (commit ${r.commit})` : ""}.`);
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
