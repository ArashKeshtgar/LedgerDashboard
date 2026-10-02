import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { fetchBuiltResume, fetchResumeBuilds, fetchResumeTemplates, fetchTruthBank } from "../api.js";
import { FactLink, formatDate } from "../components/TruthBits.jsx";

const squash = (s) => String(s || "").replace(/[\s·]+/g, " ").trim().toLowerCase();

// A résumé .docx as the engine sees it (inspect_resume.py reuses build.py's
// own section detection), laid out like the page. `annotate` adds the
// per-paragraph link back to the truth bank.
function ResumeSheet({ paragraphs, annotate }) {
  const out = [];
  let list = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`ul-${out.length}`} className="resume-bullets">{list}</ul>);
    list = [];
  };
  paragraphs.forEach((p, i) => {
    const note = annotate?.(p);
    if (p.kind === "bullet" || p.kind === "skill") {
      list.push(
        <li key={i} className={p.kind === "skill" ? "resume-skill" : ""}>
          {p.text}
          {note}
        </li>
      );
      return;
    }
    flush();
    if (p.kind === "heading") out.push(<h6 key={i} className="resume-heading">{p.text}</h6>);
    else if (p.kind === "section_header") {
      out.push(
        <div key={i} className="resume-section">
          <strong>{p.text}</strong>
          {p.section && (
            <Link to={`/truth?section=${encodeURIComponent(p.section)}`} className="badge rounded-pill text-bg-light border ms-2 fw-normal">
              {p.section}
            </Link>
          )}
          {note}
        </div>
      );
    } else if (p.kind === "section_subheader") out.push(<div key={i} className="resume-subheader">{p.text}</div>);
    else if (p.kind === "summary") out.push(<p key={i} className="resume-summary">{p.text}{note}</p>);
    else out.push(<div key={i} className={i < 3 ? "resume-top" : "resume-other"}>{p.text}</div>);
  });
  flush();
  return <div className="resume-sheet">{out}</div>;
}

function TemplatesView({ variant, setVariant }) {
  const [templates, setTemplates] = useState(null);
  const [bank, setBank] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([fetchResumeTemplates(), fetchTruthBank()])
      .then(([t, b]) => {
        setTemplates(t);
        setBank(b);
      })
      .catch((e) => setError(e.message));
  }, []);

  const skillClaims = useMemo(
    () => new Map((bank?.facts || []).filter((f) => f.id.startsWith("skill.")).map((f) => [squash(f.claim), f.id])),
    [bank]
  );
  const factCount = useMemo(() => {
    const m = new Map();
    for (const f of bank?.facts || []) m.set(f.section, (m.get(f.section) || 0) + 1);
    return m;
  }, [bank]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!templates || !bank) return <div className="text-muted">Reading the templates…</div>;

  const variants = Object.keys(templates.variants);
  const current = variants.includes(variant) ? variant : variants[0];
  const doc = templates.variants[current];
  const bulletSections = [...factCount.keys()].filter((s) => s.startsWith("proj.") || s.startsWith("exp."));
  const anchorFor = new Map(templates.anchors.map((a) => [a.prefix, a]));

  return (
    <div className="row g-3">
      <div className="col-lg-8">
        <ul className="nav nav-tabs mb-0">
          {variants.map((v) => (
            <li key={v} className="nav-item">
              <button type="button" className={`nav-link ${v === current ? "active" : ""}`} onClick={() => setVariant(v)}>
                {v}
              </button>
            </li>
          ))}
        </ul>
        <div className="card border-top-0 rounded-top-0">
          <div className="card-body">
            <div className="small text-muted mb-3">
              <span className="font-monospace">templates/resume_{current}.docx</span> — the base every build starts
              from. The header, headings and section order come from here; summary, skills and bullets are replaced per
              posting from the truth bank. A skills line marked ✗ is text in the file that no skill fact says any more.
            </div>
            <ResumeSheet
              paragraphs={doc.paragraphs}
              annotate={(p) => {
                if (p.kind === "skill") {
                  const id = skillClaims.get(squash(p.text));
                  return id ? <FactLink id={id} className="ms-2" /> : <span className="badge bg-warning text-dark ms-2" title="No skill fact has this exact text — the base file is out of date">✗ not in truth bank</span>;
                }
                if (p.kind === "section_header" && p.section) {
                  return <span className="small text-muted ms-2">{factCount.get(p.section) || 0} facts in the bank</span>;
                }
                return null;
              }}
            />
          </div>
        </div>
      </div>
      <div className="col-lg-4">
        <div className="card">
          <div className="card-header">Sections × templates</div>
          <div className="card-body p-0 table-responsive">
            <table className="table table-sm mb-0 small align-middle">
              <thead>
                <tr>
                  <th>Section</th>
                  {variants.map((v) => (
                    <th key={v} className="text-center" title={v}>{v.split("_")[0]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...new Set([...templates.anchors.map((a) => a.prefix), ...bulletSections])].map((s) => {
                  const a = anchorFor.get(s);
                  return (
                    <tr key={s}>
                      <td>
                        <Link to={`/truth?section=${encodeURIComponent(s)}`} className="font-monospace">{s}</Link>
                        <span className="text-muted ms-1">({factCount.get(s) || 0})</span>
                        {!a && <div className="text-danger">no anchor in build.py</div>}
                      </td>
                      {variants.map((v) => (
                        <td key={v} className="text-center">{a?.in_variants.includes(v) ? "✓" : <span className="text-muted">—</span>}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function BuildsView() {
  const [builds, setBuilds] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    fetchResumeBuilds().then(setBuilds).catch((e) => setError(e.message));
  }, []);
  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!builds) return <div className="text-muted">Loading…</div>;
  return (
    <div className="card">
      <div className="table-responsive">
        <table className="table table-sm align-middle mb-0">
          <thead>
            <tr>
              <th>Application</th>
              <th>Variant</th>
              <th>Stage</th>
              <th>Built</th>
              <th>Linked to facts</th>
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <tr key={b.folder}>
                <td><Link to={`/resume/${encodeURIComponent(b.folder)}`}>{b.company} — {b.role}</Link></td>
                <td className="font-monospace small">{b.variant}</td>
                <td className="small">{b.stage}</td>
                <td className="small">{formatDate(b.builtAt)}</td>
                <td className="small">{b.tracked ? `✓ ${b.bullets} bullets` : <span className="text-muted">built before linking — rebuild to link</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BuiltResumePage() {
  const { folder } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    fetchBuiltResume(folder).then(setData).catch((e) => setError(e.message));
  }, [folder]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <div className="text-muted">Reading the résumé…</div>;
  const linked = data.document.paragraphs.filter((p) => p.fact_id);
  const changed = linked.filter((p) => p.fact_changed);
  return (
    <div>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div>
          <Link to={`/applications/${encodeURIComponent(folder)}`} className="btn btn-sm btn-outline-secondary rounded-pill mb-2">
            ← Back to application
          </Link>
          <h4 className="mb-0">📄 {data.file}</h4>
          <div className="text-muted small">
            Built {formatDate(data.builtAt)}
            {data.plan ? ` · ${data.plan.base_variant} · ${linked.length} lines linked to facts` : ""}
          </div>
        </div>
      </div>
      {!data.plan && (
        <div className="alert alert-info py-2">
          This résumé was built before builds recorded which fact each bullet came from. Rebuild it from the application
          page to link every bullet back to the truth bank.
        </div>
      )}
      {changed.length > 0 && (
        <div className="alert alert-warning py-2">
          {changed.length} line(s) came from facts that changed since this was built — rebuild before sending.
        </div>
      )}
      <div className="card">
        <div className="card-body">
          <ResumeSheet
            paragraphs={data.document.paragraphs}
            annotate={(p) =>
              p.fact_id ? (
                <span className="ms-2">
                  <FactLink id={p.fact_id} />
                  {p.fact_changed && <span className="badge bg-warning text-dark ms-1" title={`Now: ${p.fact_claim}`}>changed since build</span>}
                </span>
              ) : null
            }
          />
        </div>
      </div>
    </div>
  );
}

export default function ResumePage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "templates";
  const variant = params.get("variant") || "";
  return (
    <div>
      <div className="mb-3">
        <h4 className="mb-0">📄 Résumé</h4>
        <div className="text-muted small">
          The base templates every build starts from, and every built résumé with each bullet traced to its fact.
        </div>
      </div>
      <ul className="nav nav-pills mb-3">
        {[["templates", "Base templates"], ["builds", "Built résumés"]].map(([k, label]) => (
          <li key={k} className="nav-item">
            <button type="button" className={`nav-link ${tab === k ? "active" : ""}`} onClick={() => setParams({ tab: k })}>
              {label}
            </button>
          </li>
        ))}
      </ul>
      {tab === "templates" ? (
        <TemplatesView variant={variant} setVariant={(v) => setParams({ tab: "templates", variant: v })} />
      ) : (
        <BuildsView />
      )}
    </div>
  );
}
