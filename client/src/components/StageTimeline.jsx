// A logged stage update can carry a time too ("...T14:30") — show that as a
// space instead of a raw "T".
function formatEventDate(value) {
  return value && value.includes("T") ? value.replace("T", " ") : value;
}

// Horizontal stepper showing where one application stands.
// Past stages are filled, the current one is highlighted, future ones are muted.
export default function StageTimeline({ stages, terminal, current, history }) {
  if (!stages || stages.length === 0) return null;

  const terminalHit = (terminal || []).find((t) => t.key === current);
  const currentIndex = stages.findIndex((s) => s.key === current);
  const dateFor = (key) => {
    const ev = (history || []).filter((h) => h.stage === key).pop();
    return ev ? ev.date : null;
  };

  return (
    <div>
      <div className="stage-track">
        {stages.map((s, i) => {
          const done = currentIndex > i;
          const isCurrent = currentIndex === i;
          const date = dateFor(s.key);
          return (
            <div
              key={s.key}
              className={
                "stage-step" +
                (done ? " is-done" : "") +
                (isCurrent ? " is-current" : "")
              }
            >
              <div className="stage-dot">{done ? "✓" : s.icon}</div>
              <div className="stage-label">{s.label}</div>
              <div className="stage-date">{formatEventDate(date) || ""}</div>
            </div>
          );
        })}
      </div>

      {terminalHit && (
        <div className="alert alert-secondary mt-3 mb-0 py-2">
          {terminalHit.icon} <strong>{terminalHit.label}</strong>
          {dateFor(terminalHit.key) && (
            <span className="text-muted ms-2">{formatEventDate(dateFor(terminalHit.key))}</span>
          )}
        </div>
      )}
    </div>
  );
}
