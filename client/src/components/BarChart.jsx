// Simple horizontal bar chart: magnitude comparison, one bar per category.
// Each item: { label, value, color, sublabel? }
export default function BarChart({ items, maxValue, valueSuffix = "" }) {
  const max = maxValue ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="viz-root">
      {items.map((item) => {
        const pct = Math.max(2, (item.value / max) * 100);
        return (
          <div key={item.label} className="viz-row">
            <div className="viz-row-label">
              {item.icon && <span className="viz-icon">{item.icon}</span>}
              {item.label}
            </div>
            <div className="viz-track">
              <div
                className="viz-bar"
                style={{ width: `${pct}%`, background: item.color }}
                title={`${item.label}: ${item.value}${valueSuffix}`}
              />
            </div>
            <div className="viz-value">{item.value}{valueSuffix}</div>
          </div>
        );
      })}
    </div>
  );
}
