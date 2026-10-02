// Small pieces shared by the Truth Bank, Gaps, Résumé and Health pages.
import { Link } from "react-router-dom";

export const GAP_STATUS = {
  closed: { label: "closed", cls: "bg-success" },
  partial: { label: "partial", cls: "bg-warning text-dark" },
  open: { label: "open", cls: "bg-danger" },
  undefined: { label: "not in dictionary", cls: "bg-secondary" },
};

export function GapStatusBadge({ status }) {
  const s = GAP_STATUS[status] || GAP_STATUS.open;
  return <span className={`badge rounded-pill ${s.cls}`}>{s.label}</span>;
}

export const STRENGTH_CLASS = {
  strong: "bg-success-subtle text-success-emphasis",
  medium: "bg-info-subtle text-info-emphasis",
  soft: "bg-warning-subtle text-warning-emphasis",
};

export function FactLink({ id, className = "" }) {
  return (
    <Link to={`/truth?id=${encodeURIComponent(id)}`} className={`badge rounded-pill text-bg-light border fact-link ${className}`}>
      {id}
    </Link>
  );
}

export function GapLink({ slug, status }) {
  return (
    <Link to={`/gaps?slug=${encodeURIComponent(slug)}`} className="text-decoration-none">
      <span className="font-monospace small">{slug}</span> {status && <GapStatusBadge status={status} />}
    </Link>
  );
}

export const SEVERITY = {
  error: { icon: "⛔", cls: "danger", label: "Errors" },
  warn: { icon: "⚠️", cls: "warning", label: "Warnings" },
  info: { icon: "ℹ️", cls: "info", label: "Info" },
};

// Where an issue's subject lives in the dashboard.
export function issueLink(issue) {
  const { type, id } = issue.target;
  if (type === "fact") return `/truth?id=${encodeURIComponent(id)}`;
  if (type === "gap") return `/gaps?slug=${encodeURIComponent(id)}`;
  if (type === "application") return `/applications/${encodeURIComponent(id)}`;
  if (type === "section") return `/truth?section=${encodeURIComponent(id)}`;
  if (type === "template") return `/resume?variant=${encodeURIComponent(id.split(":")[0])}`;
  return null;
}

// Compact inline list of the health issues about one fact or gap.
export function InlineIssues({ issues }) {
  if (!issues?.length) return null;
  return (
    <ul className="list-unstyled mb-0 mt-2">
      {issues.map((i) => (
        <li key={i.key} className={`small text-${SEVERITY[i.severity].cls}-emphasis`}>
          {SEVERITY[i.severity].icon} {i.title}
          <div className="text-muted ms-4">{i.detail}</div>
        </li>
      ))}
    </ul>
  );
}

export const splitList = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// A git diff with added/removed lines coloured.
export function DiffView({ diff }) {
  return (
    <pre className="diff-view small mb-0">
      {diff.split("\n").map((line, i) => {
        const cls = line.startsWith("+") && !line.startsWith("+++")
          ? "diff-add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "diff-del"
            : line.startsWith("@@") ? "diff-hunk" : "";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
