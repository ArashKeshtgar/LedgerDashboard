import { useEffect, useState } from "react";
import { fetchFunnel } from "../api.js";

// Applied -> reply -> interview -> offer, from the live pipeline, and the
// chance of an offer within 6 months at different paces. Developer track
// only; IT support is counted separately underneath.

const pct = (v, digits = 0) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(digits)}%`);

function Step({ label, value, of, hint }) {
  const share = of ? value / of : null;
  return (
    <div className="col-6 col-md">
      <div className="border rounded-3 p-3 h-100">
        <div className="small text-muted">{label}</div>
        <div className="fs-3 fw-semibold">{value}</div>
        {share !== null && <div className="small text-muted">{pct(share, 1)} of sent</div>}
        {hint && <div className="small text-muted">{hint}</div>}
      </div>
    </div>
  );
}

function BreakdownTable({ title, rows, note }) {
  return (
    <div className="card mb-4">
      <div className="card-header">{title}</div>
      <div className="table-responsive">
        <table className="table table-sm mb-0 align-middle">
          <thead>
            <tr>
              <th />
              <th className="text-end">Sent</th>
              <th className="text-end">Settled</th>
              <th className="text-end">Rejected</th>
              <th className="text-end">Silent</th>
              <th className="text-end">Screens</th>
              <th className="text-end">Interviews</th>
              <th className="text-end">Offers</th>
              <th className="text-end">Screen rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="fw-semibold">{r.key}</td>
                <td className="text-end">{r.sent}</td>
                <td className="text-end">{r.settled}</td>
                <td className="text-end">{r.rejected}</td>
                <td className="text-end">{r.silent}</td>
                <td className="text-end">{r.screens}</td>
                <td className="text-end">{r.interviews}</td>
                <td className="text-end">{r.offers}</td>
                <td className="text-end">{r.settled ? pct(r.screenRate, 1) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <div className="card-footer small text-muted">{note}</div>}
    </div>
  );
}

export default function FunnelPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchFunnel().then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <div className="text-muted">Loading…</div>;

  const t = data.totals;
  const f = data.forecast;
  const current = f.scenarios[1];
  const tone = current.probability >= 0.6 ? "success" : current.probability >= 0.35 ? "warning" : "danger";

  return (
    <div>
      <h2 className="h4 mb-3">📈 Funnel &amp; 6-month forecast</h2>

      <div className="row g-3 mb-4">
        <Step label="📤 Sent" value={t.sent} hint={`${t.pending} still waiting (< ${data.silentDays} days)`} />
        <Step label="💬 Any reply" value={t.replies} of={t.sent} />
        <Step label="📞 Recruiter screen" value={t.screens} of={t.sent} />
        <Step label="💻 Interview" value={t.interviews} of={t.sent} />
        <Step label="🎉 Offer" value={t.offers} of={t.sent} />
      </div>

      <div className={`card mb-4 border-${tone}`}>
        <div className="card-body">
          <div className="d-flex flex-wrap justify-content-between align-items-baseline gap-2">
            <div>
              <div className="text-muted small">Chance of at least one permanent offer within {Math.round(f.horizonWeeks / 4.33)} months, at the current pace</div>
              <div className={`display-6 fw-semibold text-${tone}`}>{pct(current.probability)}</div>
            </div>
            <div className="small text-muted text-end">
              Pace: <strong>{f.pacePerWeek}</strong> developer applications / week (last 4 weeks)<br />
              Estimated screen rate: <strong>{pct(f.screenRate.mean, 1)}</strong> · screen → offer: <strong>{pct(f.offerRate.mean)}</strong>
            </div>
          </div>

          <table className="table table-sm mt-3 mb-0">
            <thead>
              <tr>
                <th>Scenario</th>
                <th className="text-end">Apps / week</th>
                <th className="text-end">Chance</th>
              </tr>
            </thead>
            <tbody>
              {f.scenarios.map((s) => (
                <tr key={s.label} className={s === current ? "fw-semibold" : ""}>
                  <td>{s.label}</td>
                  <td className="text-end">{s.perWeek}</td>
                  <td className="text-end">
                    <div className="d-flex align-items-center justify-content-end gap-2">
                      <div className="progress flex-grow-1" style={{ height: 6, maxWidth: 120 }}>
                        <div className="progress-bar" style={{ width: pct(s.probability) }} />
                      </div>
                      <span style={{ minWidth: 40 }}>{pct(s.probability)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <details className="small text-muted mt-3">
            <summary>How this is calculated</summary>
            <p className="mt-2 mb-1">
              Starts from benchmarks for a newcomer applying cold (~3% of applications reach a recruiter
              screen, ~15% of screens end in an offer) and updates them with your own results: every
              application that got a screen, a rejection, or {data.silentDays}+ days of silence counts as
              settled. Only applications sent in the first {f.usefulWeeks} weeks count (hiring takes 4–6
              weeks), and 20% are assumed to be contracts rather than permanent roles. Monte Carlo over the
              uncertainty in both rates.
            </p>
            <p className="mb-0">
              The number only moves if replies are logged — mark every recruiter call, rejection email and
              interview on the application's page, and set Source to <em>referral</em>, <em>agency</em> or{" "}
              <em>program</em> when that's how it came in, so the table below can compare channels.
            </p>
          </details>
        </div>
      </div>

      <BreakdownTable
        title="By source"
        rows={data.bySource}
        note="Referral / agency / program rows appear once you add applications with those sources."
      />
      <BreakdownTable title="By match score" rows={data.byBand} />
      <BreakdownTable title="By week sent (week starting Monday)" rows={data.byWeek} />

      {data.it.sent > 0 && (
        <div className="small text-muted">
          🛠️ IT support track (not in the numbers above): {data.it.sent} sent, {data.it.screens} screens,{" "}
          {data.it.offers} offers.
        </div>
      )}
    </div>
  );
}
