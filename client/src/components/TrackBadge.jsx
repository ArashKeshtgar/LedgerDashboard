import { TRACKS } from "../track.js";

// Only IT rows carry a badge by default — developer roles are the norm, so
// badging every one of them would just be noise. Pass `always` to show both.
export function TrackBadge({ track, always = false, className = "" }) {
  if (track !== "it" && !always) return null;
  const t = TRACKS[track] || TRACKS.dev;
  return (
    <span className={`chip chip-track-${track} ${className}`} title={t.label}>
      <span aria-hidden="true">{t.icon}</span> {t.short}
    </span>
  );
}

// All / Developer / IT Support segmented filter with per-track counts.
export function TrackTabs({ value, onChange, rows, trackOf }) {
  const count = (key) => rows.filter((r) => key === "all" || trackOf(r) === key).length;
  const options = [
    { key: "all", label: "All" },
    { key: "dev", label: `${TRACKS.dev.icon} ${TRACKS.dev.label}` },
    { key: "it", label: `${TRACKS.it.icon} ${TRACKS.it.label}` },
  ];
  return (
    <div className="track-tabs" role="tablist" aria-label="Job family">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          className={`track-tab track-tab-${o.key}${value === o.key ? " active" : ""}`}
          onClick={() => onChange(o.key)}
        >
          {o.label} <span className="track-tab-count">{count(o.key)}</span>
        </button>
      ))}
    </div>
  );
}
