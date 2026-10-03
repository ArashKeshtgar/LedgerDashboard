import { useState } from "react";
import { KIND_LABELS, usd } from "../costs.js";

// What Claude calls cost for this one package (analyze, re-analyze, build,
// repair turns), from the package folder's own usage log.
export default function PackageCostCard({ usage }) {
  const [open, setOpen] = useState(false);
  if (!usage || !usage.calls) return null;

  return (
    <div className="card mb-4">
      <div className="card-header d-flex justify-content-between align-items-center">
        <span>💲 Claude cost for this package</span>
        <span className="fw-semibold">{usd(usage.usd)}</span>
      </div>
      <div className="card-body py-2">
        <div className="d-flex flex-wrap gap-2 align-items-center">
          {Object.entries(usage.byKind).map(([kind, v]) => (
            <span key={kind} className="badge rounded-pill text-bg-light border">
              {KIND_LABELS[kind] || kind}: {usd(v)}
            </span>
          ))}
          <button type="button" className="btn btn-link btn-sm p-0 ms-auto" onClick={() => setOpen(!open)}>
            {open ? "Hide calls" : `${usage.calls} call${usage.calls === 1 ? "" : "s"} — details`}
          </button>
        </div>
        {open && (
          <div className="table-responsive mt-2">
            <table className="table table-sm small mb-0">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th className="text-end">In</th>
                  <th className="text-end">From cache</th>
                  <th className="text-end">To cache</th>
                  <th className="text-end">Out</th>
                  <th className="text-end">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.list.map((c, i) => (
                  <tr key={i}>
                    <td>{new Date(c.at).toLocaleString()}</td>
                    <td>{KIND_LABELS[c.kind] || c.kind}</td>
                    <td className="text-end">{c.input.toLocaleString()}</td>
                    <td className="text-end">{c.cache_read.toLocaleString()}</td>
                    <td className="text-end">{c.cache_write.toLocaleString()}</td>
                    <td className="text-end">{c.output.toLocaleString()}</td>
                    <td className="text-end">{usd(c.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
