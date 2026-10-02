import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { commitOutsideEdits, dismissHealthIssue, fetchHealth, reanalyzePackage, restoreHealthIssues } from "../api.js";
import { SEVERITY, issueLink } from "../components/TruthBits.jsx";

// Notifies the navbar badge that the counts may have changed.
export const healthChanged = () => window.dispatchEvent(new Event("health-changed"));

export default function HealthPage() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState({});
  const [results, setResults] = useState({});
  const [bulk, setBulk] = useState(null);

  const load = () =>
    fetchHealth()
      .then((h) => {
        setHealth(h);
        healthChanged();
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function run(issue, fn) {
    setBusy((b) => ({ ...b, [issue.key]: true }));
    try {
      const message = await fn();
      setResults((r) => ({ ...r, [issue.key]: { ok: true, message } }));
      await load();
    } catch (e) {
      setResults((r) => ({ ...r, [issue.key]: { ok: false, message: e.message } }));
    } finally {
      setBusy((b) => ({ ...b, [issue.key]: false }));
    }
  }

  const reanalyze = async (folder) => {
    const r = await reanalyzePackage(folder);
    return `Re-analyzed: ${r.previous.gap_tags || "none"} → ${r.gap_tags.join(",") || "none"} (match ${r.previous.match_score} → ${r.match_score})`;
  };

  // One at a time: each is a paid model call, and a failure shouldn't stop the rest.
  async function reanalyzeAll(folders) {
    const done = [];
    for (const [i, folder] of folders.entries()) {
      setBulk(`Re-analyzing ${i + 1} of ${folders.length}…`);
      try {
        done.push(`${folder}: ${await reanalyze(folder)}`);
      } catch (e) {
        done.push(`${folder}: failed — ${e.message}`);
      }
    }
    setBulk(done.join("\n"));
    await load();
  }

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!health) return <div className="text-muted">Checking the truth bank, gaps, templates and drafts…</div>;

  const staleFolders = [
    ...new Set(health.issues.filter((i) => i.action?.type === "reanalyze").map((i) => i.action.folder)),
  ];

  return (
    <div>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div>
          <h4 className="mb-0">🩺 Health</h4>
          <div className="text-muted small">
            Where the truth bank, the gap dictionary, the résumé templates and your drafts disagree with each other.
            Re-checked every time this page loads.
          </div>
        </div>
        <div className="d-flex gap-2 align-items-center">
          {Object.entries(SEVERITY).map(([k, s]) => (
            <span key={k} className={`badge rounded-pill bg-${s.cls}-subtle text-${s.cls}-emphasis border`}>
              {s.icon} {health.counts[k]} {s.label.toLowerCase()}
            </span>
          ))}
        </div>
      </div>

      {health.templatesError && (
        <div className="alert alert-secondary py-2 small">Template checks skipped: {health.templatesError}</div>
      )}

      {staleFolders.length > 1 && (
        <div className="alert alert-light border py-2 d-flex flex-wrap justify-content-between align-items-center gap-2">
          <span className="small">
            {staleFolders.length} drafts need re-analyzing against today's truth bank (one model call each).
          </span>
          <button
            type="button"
            className="btn btn-sm btn-outline-primary rounded-pill"
            disabled={!!bulk && bulk.startsWith("Re-analyzing")}
            onClick={() => reanalyzeAll(staleFolders)}
          >
            🔄 Re-analyze all {staleFolders.length}
          </button>
        </div>
      )}
      {bulk && <pre className="alert alert-info small py-2" style={{ whiteSpace: "pre-wrap" }}>{bulk}</pre>}

      {health.issues.length === 0 && (
        <div className="alert alert-success">✅ Everything agrees — no open checks.</div>
      )}

      {Object.entries(SEVERITY).map(([sev, s]) => {
        const list = health.issues.filter((i) => i.severity === sev);
        if (!list.length) return null;
        return (
          <div key={sev} className="card mb-3">
            <div className={`card-header bg-${s.cls}-subtle`}>
              {s.icon} {s.label} <span className="text-muted">({list.length})</span>
            </div>
            <ul className="list-group list-group-flush">
              {list.map((i) => {
                const link = issueLink(i);
                const result = results[i.key];
                return (
                  <li key={i.key} className="list-group-item">
                    <div className="d-flex flex-wrap justify-content-between gap-2">
                      <div className="flex-grow-1" style={{ minWidth: 260 }}>
                        <div className="fw-semibold small">{i.title}</div>
                        <div className="small text-muted">{i.detail}</div>
                        {result && <div className={`small mt-1 ${result.ok ? "text-success" : "text-danger"}`}>{result.message}</div>}
                      </div>
                      <div className="d-flex gap-1 align-items-start flex-wrap">
                        {i.action?.type === "reanalyze" && (
                          <button type="button" className="btn btn-sm btn-outline-primary py-0" disabled={busy[i.key]} onClick={() => run(i, () => reanalyze(i.action.folder))}>
                            {busy[i.key] ? "Re-analyzing…" : "🔄 Re-analyze"}
                          </button>
                        )}
                        {i.action?.type === "commit" && (
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-primary py-0"
                            disabled={busy[i.key]}
                            onClick={() => run(i, async () => {
                              const r = await commitOutsideEdits();
                              return r.commit ? `Committed ${r.files.join(", ")} (${r.commit})` : "Nothing to commit";
                            })}
                          >
                            💾 Commit
                          </button>
                        )}
                        {link && (
                          <Link to={link} className={`btn btn-sm py-0 ${i.action?.type === "open" ? "btn-outline-primary" : "btn-outline-secondary"}`}>
                            {i.action?.type === "open" ? "Open to rebuild" : "Open"}
                          </Link>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary py-0"
                          title="Hide this check (recorded in the truth bank's history; can be restored)"
                          disabled={busy[i.key]}
                          onClick={() => run(i, async () => {
                            await dismissHealthIssue(i.key);
                            return "Dismissed";
                          })}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      {health.dismissedCount > 0 && (
        <div className="text-muted small">
          {health.dismissedCount} dismissed check(s) hidden.{" "}
          <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={() => restoreHealthIssues().then(load)}>
            Show them again
          </button>
        </div>
      )}
    </div>
  );
}
