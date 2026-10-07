import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { createGap, fetchGaps, fetchHealth, fetchTruthBank, mergeGap, updateGap } from "../api.js";
import HistoryPanel from "../components/HistoryPanel.jsx";
import { FactLink, GapStatusBadge, InlineIssues } from "../components/TruthBits.jsx";

const STATUS_FILTERS = ["all", "open", "partial", "closed", "undefined"];

// Status isn't a separate field: it's read from the label's wording, the
// same rule the Context engine (#G: tags) uses, so both always agree.
function LabelEditor({ slug, initial, isNew, factIds, onSave, onCancel }) {
  const [label, setLabel] = useState(initial || "");
  const [newSlug, setNewSlug] = useState(slug || "");
  const [note, setNote] = useState("");
  const [factId, setFactId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const area = useRef(null);

  const insert = (text) => {
    const el = area.current;
    const at = el ? el.selectionEnd : label.length;
    setLabel((l) => l.slice(0, at) + text + l.slice(at));
  };

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(newSlug.trim(), label, note.trim());
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="border rounded-3 p-2 bg-body-tertiary">
      {isNew && (
        <input
          className="form-control form-control-sm font-monospace mb-2"
          placeholder="kebab-case-slug"
          value={newSlug}
          onChange={(e) => setNewSlug(e.target.value)}
          required
        />
      )}
      <textarea ref={area} dir="auto" className="form-control form-control-sm mb-2" rows={3} value={label} onChange={(e) => setLabel(e.target.value)} required />
      <div className="d-flex flex-wrap gap-1 mb-2 align-items-center">
        <span className="small text-muted me-1">Insert:</span>
        <button type="button" className="btn btn-sm btn-outline-success py-0" onClick={() => insert(" — بسته شد")}>بسته شد (closed)</button>
        <button type="button" className="btn btn-sm btn-outline-warning py-0" onClick={() => insert(" — بسته شد، ولی همچنان")}>…همچنان (partial)</button>
        <input
          className="form-control form-control-sm font-monospace"
          style={{ maxWidth: 240 }}
          list="gap-fact-ids"
          placeholder="fact id as evidence"
          value={factId}
          onChange={(e) => setFactId(e.target.value)}
        />
        <datalist id="gap-fact-ids">
          {factIds.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary py-0"
          disabled={!factIds.includes(factId)}
          onClick={() => {
            insert(` (${factId})`);
            setFactId("");
          }}
        >
          + cite
        </button>
      </div>
      <input className="form-control form-control-sm mb-2" placeholder="What changed? (optional, goes into the history)" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <div className="text-danger small mb-2">{error}</div>}
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary rounded-pill" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function GapsPage() {
  const [params] = useSearchParams();
  const [gaps, setGaps] = useState(null);
  const [factIds, setFactIds] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [history, setHistory] = useState(null);
  const [saved, setSaved] = useState(null);
  const focusRef = useRef(null);
  const focus = params.get("slug");

  const load = () =>
    Promise.all([fetchGaps(), fetchTruthBank(), fetchHealth().catch(() => null)])
      .then(([g, bank, h]) => {
        setGaps(g);
        setFactIds(bank.facts.map((f) => f.id));
        setHealth(h);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (focus && gaps) focusRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focus, gaps]);

  const issuesBySlug = useMemo(() => {
    const m = new Map();
    for (const i of health?.issues || []) {
      if (i.target.type === "gap") m.set(i.target.id, [...(m.get(i.target.id) || []), i]);
    }
    return m;
  }, [health]);

  const rows = useMemo(() => {
    if (!gaps) return [];
    const needle = q.trim().toLowerCase();
    return gaps
      .filter((g) => status === "all" || g.status === status)
      .filter((g) => !needle || `${g.slug} ${g.label || ""}`.toLowerCase().includes(needle))
      .sort((a, b) => b.counts.rejected - a.counts.rejected || b.counts.total - a.counts.total || a.slug.localeCompare(b.slug));
  }, [gaps, status, q]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!gaps) return <div className="text-muted">Loading gaps…</div>;

  const counts = Object.fromEntries(STATUS_FILTERS.map((s) => [s, s === "all" ? gaps.length : gaps.filter((g) => g.status === s).length]));

  async function save(slug, label, note, isNew) {
    if (isNew) await createGap(slug, label);
    else await updateGap(slug, label, note);
    setEditing(null);
    setSaved(`Saved ${slug}. Drafts tagged with it can be re-analyzed from Health.`);
    await load();
  }

  // Two slugs for one gap split its count: merging retags every posting
  // with the target and keeps an alias for analyses that still use the old one.
  async function merge(slug) {
    const into = window.prompt(`Merge “${slug}” into which gap? (type its slug)`)?.trim();
    if (!into) return;
    if (!gaps.some((g) => g.slug === into && g.defined)) {
      window.alert(`“${into}” isn't a defined gap.`);
      return;
    }
    try {
      const r = await mergeGap(slug, into);
      setSaved(`Merged ${slug} into ${into} — ${r.updated} posting(s) retagged.`);
      await load();
    } catch (e) {
      window.alert(e.message);
    }
  }

  return (
    <div>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div>
          <h4 className="mb-0">🕳️ Gaps</h4>
          <div className="text-muted small">
            The gap dictionary, each gap's evidence in the truth bank, and the postings tagged with it. Status comes
            from the label's own words: “بسته شد” = closed, with “همچنان / باقی / هنوز” = partial.
          </div>
        </div>
        <div className="d-flex gap-2">
          <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill" onClick={() => setHistory(history === "gap_tags" ? null : "gap_tags")}>
            🕘 History
          </button>
          <button type="button" className="btn btn-sm btn-primary rounded-pill" onClick={() => setEditing({ isNew: true })}>
            + New gap
          </button>
        </div>
      </div>

      {saved && (
        <div className="alert alert-success py-2 d-flex justify-content-between align-items-center">
          <span>{saved}</span>
          <button type="button" className="btn-close" onClick={() => setSaved(null)} aria-label="Close" />
        </div>
      )}
      {history && <HistoryPanel q={history === "gap_tags" ? "gap" : history} onClose={() => setHistory(null)} />}
      {editing?.isNew && (
        <div className="card mb-3">
          <div className="card-header">New gap</div>
          <div className="card-body">
            <LabelEditor
              key={editing.slug || "new"}
              isNew
              slug={editing.slug}
              factIds={factIds}
              onCancel={() => setEditing(null)}
              onSave={(slug, label) => save(slug, label, "", true)}
            />
          </div>
        </div>
      )}

      <div className="card mb-3">
        <div className="card-body py-2 d-flex flex-wrap gap-2 align-items-center">
          <div className="btn-group btn-group-sm" role="group">
            {STATUS_FILTERS.map((s) => (
              <button key={s} type="button" className={`btn ${status === s ? "btn-dark" : "btn-outline-secondary"}`} onClick={() => setStatus(s)}>
                {s === "undefined" ? "not in dictionary" : s} <span className="opacity-75">{counts[s]}</span>
              </button>
            ))}
          </div>
          <input className="form-control form-control-sm" style={{ maxWidth: 260 }} placeholder="Search slug or label…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <div className="card">
        <div className="table-responsive">
          <table className="table table-sm align-middle mb-0 gaps-table">
            <thead>
              <tr>
                <th>Gap</th>
                <th>Label &amp; evidence</th>
                <th className="text-center" title="Postings tagged with this gap: drafts / sent / rejected">Postings</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.slug} ref={g.slug === focus ? focusRef : undefined} className={g.slug === focus ? "fact-highlight" : ""}>
                  <td style={{ minWidth: 170 }}>
                    <div className="font-monospace small fw-semibold">{g.slug}</div>
                    <GapStatusBadge status={g.status} />
                  </td>
                  <td>
                    {editing?.slug === g.slug && !editing.isNew ? (
                      <LabelEditor
                        slug={g.slug}
                        initial={g.label}
                        factIds={factIds}
                        onCancel={() => setEditing(null)}
                        onSave={(slug, label, note) => save(g.slug, label, note, false)}
                      />
                    ) : (
                      <>
                        <div dir="auto" className="small">{g.label ?? <span className="text-muted">No label — Stats shows the raw slug.</span>}</div>
                        {(g.refs.length > 0 || g.danglingRefs.length > 0) && (
                          <div className="d-flex flex-wrap gap-1 mt-1">
                            {g.refs.map((id) => (
                              <FactLink key={id} id={id} />
                            ))}
                            {g.danglingRefs.map((id) => (
                              <span key={id} className="badge rounded-pill bg-danger" title="Not in the truth bank">{id} ✗</span>
                            ))}
                          </div>
                        )}
                        <InlineIssues issues={(issuesBySlug.get(g.slug) || []).filter((i) => i.kind !== "gap-undefined")} />
                      </>
                    )}
                    {expanded === g.slug && (
                      <ul className="small mb-0 mt-2">
                        {g.applications.map((a) => (
                          <li key={a.folder}>
                            <Link to={`/applications/${encodeURIComponent(a.folder)}`}>{a.company} — {a.role}</Link>{" "}
                            <span className="text-muted">({a.stage})</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="text-center text-nowrap">
                    {g.counts.total > 0 ? (
                      <button type="button" className="btn btn-link btn-sm p-0 text-decoration-none" onClick={() => setExpanded(expanded === g.slug ? null : g.slug)}>
                        {g.counts.draft} / {g.counts.sent}
                        {g.counts.rejected > 0 && <span className="badge bg-danger ms-1">{g.counts.rejected} ✗</span>}
                      </button>
                    ) : (
                      <span className="text-muted small">—</span>
                    )}
                  </td>
                  <td className="text-end text-nowrap">
                    {g.defined ? (
                      <>
                        <button type="button" className="btn btn-sm btn-outline-secondary py-0 me-1" onClick={() => setEditing({ slug: g.slug })}>✏️</button>
                        <button type="button" className="btn btn-sm btn-outline-secondary py-0" onClick={() => setHistory(g.slug)}>🕘</button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-sm btn-outline-primary py-0" onClick={() => setEditing({ isNew: true, slug: g.slug })}>
                        Define
                      </button>
                    )}
                    <button type="button" className="btn btn-sm btn-outline-secondary py-0 ms-1" title="Merge into another gap" onClick={() => merge(g.slug)}>⤵</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
