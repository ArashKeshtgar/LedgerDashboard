import { useEffect, useState } from "react";
import { fetchRecruiters, updateRecruiterStatus } from "../api.js";

const STAGES = [
  { key: "added", label: "Added", icon: "📇", color: "#898781" },
  { key: "connect_sent", label: "Connect sent", icon: "📨", color: "#2a78d6" },
  { key: "connect_accepted", label: "Accepted", icon: "🤝", color: "#5598e7" },
  { key: "followup_sent", label: "Follow-up sent", icon: "💬", color: "#fab219" },
  { key: "replied", label: "Replied", icon: "✅", color: "#0ca30c" },
];

function Gauge({ label, sent, cap, hardCap }) {
  const pct = Math.min(100, Math.round((sent / cap) * 100));
  const over = sent > cap;
  const barColor = over ? "#d03b3b" : pct >= 80 ? "#fab219" : "#0ca30c";
  return (
    <div className="mb-2">
      <div className="d-flex justify-content-between small text-muted mb-1">
        <span>{label}</span>
        <span>
          {sent} / {cap}
          {hardCap ? <span className="ms-1">(hard cap {hardCap})</span> : null}
        </span>
      </div>
      <div className="progress" style={{ height: 8 }}>
        <div
          className="progress-bar"
          role="progressbar"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
          aria-valuenow={sent}
          aria-valuemin={0}
          aria-valuemax={cap}
        />
      </div>
      {over && (
        <div className="text-danger small mt-1">
          ⚠️ از سقفِ خودت رد شدی — امروز/این‌هفته بیشتر Connect نفرست.
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  if (!text) return <span className="text-muted small">—</span>;
  return (
    <button
      type="button"
      className="btn btn-sm btn-outline-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard may be unavailable — the text is still shown below */
        }
      }}
      title={text}
    >
      {copied ? "✅ Copied" : `📋 ${label}`}
    </button>
  );
}

function StageBadge({ stage }) {
  const s = STAGES.find((x) => x.key === stage) || STAGES[0];
  return (
    <span
      className="badge rounded-pill"
      style={{ background: s.color, color: "#fff" }}
    >
      {s.icon} {s.label}
    </span>
  );
}

export default function RecruitersBoard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [warning, setWarning] = useState(null);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState(null);

  function load() {
    fetchRecruiters()
      .then(setData)
      .catch((e) => setError(e.message));
  }

  useEffect(load, []);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <div className="text-center py-5 text-muted">Loading…</div>;

  const { rows, funnel, daily, weekly } = data;

  async function handleMark(row, field) {
    setBusyId(row.id);
    setWarning(null);
    const nextValue = row[field] ? "" : true; // toggle: set today, or clear
    try {
      const updated = await updateRecruiterStatus(row.id, field, nextValue);
      if (updated.warning) setWarning(updated.warning);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  const q = query.trim().toLowerCase();
  const visible = rows.filter(
    (r) => !q || `${r.name} ${r.company} ${r.title}`.toLowerCase().includes(q)
  );

  const acceptRate = funnel.connect_sent
    ? Math.round((funnel.connect_accepted / funnel.connect_sent) * 100)
    : 0;

  return (
    <div>
      <h4 className="mb-3 page-title">Recruiters</h4>

      {warning && (
        <div className="alert alert-warning py-2 px-3 mb-3" role="alert">
          ⚠️ {warning}
        </div>
      )}

      <div className="row g-3 mb-4">
        {STAGES.map((s) => (
          <div className="col-6 col-md" key={s.key}>
            <div className="stat-card text-center" style={{ "--stat-accent": s.color }}>
              <div className="stat-icon mb-1">{s.icon}</div>
              <div className="text-muted small">{s.label}</div>
              <div className="fs-4 fw-semibold">{funnel[s.key] ?? 0}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="row g-4 mb-4">
        <div className="col-lg-6">
          <div className="card h-100">
            <div className="card-header">ریتم (رعایت سقف لینکدین)</div>
            <div className="card-body">
              <Gauge label="امروز" sent={daily.sent} cap={daily.cap} />
              <Gauge
                label="این هفته"
                sent={weekly.sent}
                cap={weekly.cap}
                hardCap={weekly.hardCap}
              />
            </div>
          </div>
        </div>
        <div className="col-lg-6">
          <div className="card h-100">
            <div className="card-header">Accept rate</div>
            <div className="card-body text-center">
              <div className="fs-1 fw-semibold">{acceptRate}%</div>
              <div className="text-muted small">
                {funnel.connect_accepted} از {funnel.connect_sent} درخواست ارسالی — انتظار
                واقع‌بینانه ۲۰–۳۰٪
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="d-flex justify-content-between align-items-center mb-2">
        <h6 className="text-muted mb-0">لیست هدف ({visible.length})</h6>
        <input
          className="form-control"
          style={{ maxWidth: 260 }}
          placeholder="جست‌وجو..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {visible.length === 0 ? (
        <div className="text-muted small">
          لیست خالی است. یا با اسکریپت <code>recruiter_batch.py</code> (دستور «ریکروتر
          دسته‌ای») چند نفر اضافه کن، یا دستی در target_list.csv.
        </div>
      ) : (
        <div className="table-responsive">
          <table className="table align-middle">
            <thead className="table-light">
              <tr>
                <th>نام</th>
                <th>شرکت / عنوان</th>
                <th>وضعیت</th>
                <th>یادداشت‌ها</th>
                <th>اقدام</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <>
                  <tr key={r.id}>
                    <td>
                      {r.linkedin_url ? (
                        <a href={r.linkedin_url} target="_blank" rel="noreferrer">
                          {r.name}
                        </a>
                      ) : (
                        r.name
                      )}
                    </td>
                    <td>
                      <div>{r.company}</div>
                      <div className="text-muted small">{r.title}</div>
                    </td>
                    <td>
                      <StageBadge stage={r.stage} />
                    </td>
                    <td>
                      <div className="d-flex gap-2 flex-wrap">
                        <CopyButton text={r.connect_note} label="Connect" />
                        <CopyButton text={r.followup_note} label="Follow-up" />
                        <button
                          type="button"
                          className="btn btn-sm btn-link p-0"
                          onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                        >
                          {expandedId === r.id ? "بستن متن" : "نمایش متن"}
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="d-flex gap-1 flex-wrap">
                        <button
                          type="button"
                          className={`btn btn-sm ${r.connect_sent ? "btn-primary" : "btn-outline-primary"}`}
                          disabled={busyId === r.id}
                          onClick={() => handleMark(r, "connect_sent")}
                        >
                          {r.connect_sent ? `✓ Sent ${r.connect_sent}` : "Mark sent"}
                        </button>
                        <button
                          type="button"
                          className={`btn btn-sm ${r.connect_accepted ? "btn-primary" : "btn-outline-secondary"}`}
                          disabled={busyId === r.id || !r.connect_sent}
                          onClick={() => handleMark(r, "connect_accepted")}
                        >
                          {r.connect_accepted ? `✓ Accepted` : "Mark accepted"}
                        </button>
                        <button
                          type="button"
                          className={`btn btn-sm ${r.followup_sent ? "btn-primary" : "btn-outline-secondary"}`}
                          disabled={busyId === r.id || !r.connect_accepted}
                          onClick={() => handleMark(r, "followup_sent")}
                        >
                          {r.followup_sent ? `✓ Followed up` : "Mark followed up"}
                        </button>
                        <button
                          type="button"
                          className={`btn btn-sm ${r.replied ? "btn-success" : "btn-outline-success"}`}
                          disabled={busyId === r.id || !r.followup_sent}
                          onClick={() => handleMark(r, "replied")}
                        >
                          {r.replied ? `✓ Replied` : "Mark replied"}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === r.id && (
                    <tr>
                      <td colSpan={5} className="bg-light">
                        <div className="small mb-2">
                          <strong>Connect note</strong> ({(r.connect_note || "").length} کاراکتر):
                          <div className="border rounded p-2 bg-white mt-1">{r.connect_note}</div>
                        </div>
                        <div className="small">
                          <strong>Follow-up</strong>:
                          <div className="border rounded p-2 bg-white mt-1">{r.followup_note}</div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
