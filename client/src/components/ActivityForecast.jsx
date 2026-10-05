import { useEffect, useMemo, useRef, useState } from "react";
import { fetchUsageCalls } from "../api.js";
import {
  COST_KIND_LABEL, COST_TRACKED_FROM, addDays, dailyActivity, dailyCost, formatUsd, isoDay, parseDay,
} from "../dailyActivity.js";

// A weather-forecast style panel for the Applications page: a strip of day
// cards (one week, paged with the arrows), a smooth chart of the chosen
// measure over the three weeks ending that week, and a rejections band
// underneath — like a forecast's precipitation strip. Clicking a day card or
// a day on the chart filters the list below to that day.

const METRICS = [
  { key: "sent", label: "Sent", unit: "sent", icon: "📤" },
  { key: "found", label: "Found", unit: "found", icon: "🔎" },
  { key: "rejected", label: "Rejections", unit: "rejected", icon: "❌" },
  { key: "score", label: "Match score", unit: "avg score", icon: "🎯" },
  { key: "cost", label: "Claude cost", unit: "Claude API", icon: "💲" },
];

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CHART_DAYS = 21;

// Weather icon for a day's sending: busy days are sunny, empty days cloudy.
function dayIcon(d) {
  if (!d) return "☁️";
  if (d.sent >= 5) return "☀️";
  if (d.sent >= 2) return "🌤️";
  if (d.sent === 1) return "⛅";
  if (d.found > 0) return "🌥️";
  return "☁️";
}

function dayName(day, today) {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return WEEKDAY[parseDay(day).getDay()];
}

// Monotone cubic through the points (never overshoots below zero).
function smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
  const n = pts.length;
  const dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i][0] + h},${pts[i][1] + t[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - t[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

function useWidth(ref) {
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export default function ActivityForecast({ rows, selectedDay, onSelectDay }) {
  const today = isoDay(new Date());
  const days = useMemo(() => dailyActivity(rows, today), [rows, today]);
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const [metric, setMetric] = useState("sent");
  const [weekEnd, setWeekEnd] = useState(today); // last day of the card strip
  const [hover, setHover] = useState(null);
  const chartRef = useRef(null);
  const width = useWidth(chartRef);
  const [calls, setCalls] = useState(null); // null = not loaded / unavailable

  useEffect(() => {
    let live = true;
    fetchUsageCalls(COST_TRACKED_FROM)
      .then((r) => live && setCalls(r.calls || []))
      .catch(() => live && setCalls(null));
    return () => { live = false; };
  }, []);
  const costByDay = useMemo(() => dailyCost(calls), [calls]);
  // A day's Claude bill, or null where nothing could have been recorded.
  const costOf = (day) => (calls === null || day < COST_TRACKED_FROM || day > today ? null : costByDay.get(day)?.usd || 0);
  const costLines = (day) =>
    Object.entries(costByDay.get(day)?.byKind || {}).map(([k, usd]) => `${COST_KIND_LABEL[k] || k} ${formatUsd(usd)}`);

  if (!days.length) return null;
  const firstDay = days[0].day;
  const m = METRICS.find((x) => x.key === metric);
  const value = (d, day) =>
    metric === "cost" ? costOf(day) : d ? (metric === "score" ? d.score : d[metric]) : metric === "score" ? null : 0;
  const fmt = (v) => (v === null ? "—" : metric === "cost" ? formatUsd(v) : v);

  const week = Array.from({ length: 7 }, (_, i) => addDays(weekEnd, i - 6));
  const canBack = week[0] > firstDay;
  const canForward = weekEnd < today;

  // Chart window: three weeks ending at the strip's last day.
  const windowDays = Array.from({ length: CHART_DAYS }, (_, i) => addDays(weekEnd, i - CHART_DAYS + 1));
  const H = 230, top = 54, bottom = 186, left = 34, right = 14;
  const plotW = width - left - right;
  const x = (i) => left + (plotW * (i + 0.5)) / CHART_DAYS;
  const vals = windowDays.map((day) => value(byDay.get(day), day));
  const maxVal =
    metric === "score" ? 100 : Math.max(metric === "cost" ? 0.2 : 4, ...vals.filter((v) => v !== null));
  const niceMax =
    metric === "score" ? 100
      : metric === "cost" ? (maxVal <= 1 ? Math.ceil(maxVal * 5) / 5 : Math.ceil(maxVal * 2) / 2)
        : Math.ceil(maxVal / 2) * 2;
  const y = (v) => bottom - ((bottom - top) * v) / niceMax;
  const ticks = metric === "score" ? [0, 50, 100] : [0, niceMax / 2, niceMax];

  const pts = vals.map((v, i) => (v === null ? null : [x(i), y(v)]));
  const segments = [];
  pts.forEach((p) => {
    if (!p) { segments.push([]); return; }
    if (!segments.length) segments.push([]);
    segments[segments.length - 1].push(p);
  });
  const lines = segments.filter((s) => s.length).map(smoothPath);
  const area =
    metric !== "score" && lines.length === 1 && segments.flat().length === CHART_DAYS
      ? `${lines[0]} L${x(CHART_DAYS - 1)},${bottom} L${x(0)},${bottom} Z`
      : null;

  const weekStartIdx = windowDays.indexOf(week[0]);
  const labelEvery = width < 640 ? 3 : width < 900 ? 2 : 1;
  const weekSent = week.reduce((s, day) => s + (byDay.get(day)?.sent || 0), 0);
  const weekCost = week.reduce((s, day) => s + (costOf(day) || 0), 0);

  // Days in a row, up to today, with at least one application sent.
  let streak = 0;
  for (let d = today; byDay.get(d)?.sent > 0; d = addDays(d, -1)) streak++;

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.min(CHART_DAYS - 1, Math.max(0, Math.round(((px - left) / plotW) * CHART_DAYS - 0.5)));
    setHover(i);
  }

  const hovered = hover !== null ? windowDays[hover] : null;
  const hd = hovered ? byDay.get(hovered) : null;

  return (
    <section className="wx-panel mb-4" aria-label="Daily application activity">
      <div className="wx-head">
        <h5 className="wx-title mb-0">📅 Daily activity</h5>
        <div className="wx-tabs" role="tablist">
          {METRICS.map((x) => (
            <button
              key={x.key}
              type="button"
              role="tab"
              aria-selected={metric === x.key}
              className={`wx-tab ${metric === x.key ? "active" : ""}`}
              onClick={() => setMetric(x.key)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div className="wx-summary">
          This week: <strong>{weekSent}</strong> sent
          {calls !== null && <span className="ms-2">· <strong>{formatUsd(weekCost)}</strong> Claude</span>}
          {streak > 1 && <span className="ms-2">🔥 {streak}-day streak</span>}
        </div>
      </div>

      <div className="wx-strip">
        <button type="button" className="wx-arrow" disabled={!canBack} onClick={() => setWeekEnd(addDays(weekEnd, -7))} aria-label="Previous week">‹</button>
        <div className="wx-cards">
          {week.map((day) => {
            const d = byDay.get(day);
            const v = value(d, day);
            const cost = costOf(day);
            const future = day > today;
            const before = day < firstDay;
            return (
              <button
                key={day}
                type="button"
                className={`wx-card ${selectedDay === day ? "selected" : ""} ${day === today ? "today" : ""}`}
                disabled={future}
                onClick={() => onSelectDay(selectedDay === day ? null : day)}
                title={[
                  d ? `${day}: ${d.sent} sent · ${d.found} found · ${d.rejected} rejected` : day,
                  cost !== null && `Claude API: ${formatUsd(cost)}`,
                  ...costLines(day).map((l) => `  ${l}`),
                ].filter(Boolean).join("\n")}
              >
                <div className="wx-card-top">
                  <span>{parseDay(day).getDate()}</span>
                  <span>{dayName(day, today)}</span>
                </div>
                <div className="wx-card-body">
                  <span className="wx-icon" aria-hidden="true">{before || future ? "·" : dayIcon(d)}</span>
                  <span className="wx-values">
                    <span className="wx-big">{fmt(v)}</span>
                    <span className="wx-small">{metric === "sent" ? `${d?.found || 0} found` : m.unit}</span>
                  </span>
                </div>
                {metric !== "cost" && cost !== null && (
                  <div className={`wx-cost ${cost > 0 ? "spent" : ""}`}>💲 {formatUsd(cost)}</div>
                )}
              </button>
            );
          })}
        </div>
        <button type="button" className="wx-arrow" disabled={!canForward} onClick={() => setWeekEnd(addDays(weekEnd, 7) > today ? today : addDays(weekEnd, 7))} aria-label="Next week">›</button>
      </div>

      <div className="wx-chart-card">
        <div className="wx-chart-head">
          <span>{m.icon} {m.label} per day</span>
          <span className="wx-muted small">
            {windowDays[0]} → {windowDays[CHART_DAYS - 1]}
          </span>
        </div>
        <div className="wx-chart" ref={chartRef}>
          <svg
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            role="img"
            aria-label={`${m.label} per day, ${windowDays[0]} to ${windowDays[CHART_DAYS - 1]}`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            onClick={() => hover !== null && windowDays[hover] <= today && onSelectDay(windowDays[hover] === selectedDay ? null : windowDays[hover])}
          >
            <defs>
              <linearGradient id="wx-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--wx-line)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--wx-line)" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {weekStartIdx >= 0 && (
              <rect
                x={left + (plotW * weekStartIdx) / CHART_DAYS}
                y={top - 6}
                width={(plotW * (CHART_DAYS - weekStartIdx)) / CHART_DAYS}
                height={bottom - top + 6}
                fill="var(--wx-week)"
                rx="6"
              />
            )}

            {ticks.map((t) => (
              <g key={t}>
                <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} stroke="var(--wx-grid)" />
                <text x={left - 6} y={y(t) + 4} textAnchor="end" className="wx-axis">{metric === "cost" ? `$${+t.toFixed(2)}` : t}</text>
              </g>
            ))}

            {windowDays.map((day, i) => {
              const v = vals[i];
              const show = i % labelEvery === (CHART_DAYS - 1) % labelEvery;
              return show ? (
                <g key={day} className={day === today ? "wx-today" : ""}>
                  <text x={x(i)} y={16} textAnchor="middle" className="wx-axis">
                    {day === today ? "Today" : WEEKDAY[parseDay(day).getDay()]}
                  </text>
                  <text x={x(i)} y={30} textAnchor="middle" className="wx-axis">{parseDay(day).getDate()}</text>
                  <text x={x(i)} y={46} textAnchor="middle" className="wx-val">{v === null || day > today ? "" : metric === "cost" ? (v ? formatUsd(v) : "") : v}</text>
                </g>
              ) : null;
            })}

            {area && <path d={area} fill="url(#wx-fill)" />}
            {lines.map((d, i) => (
              <path key={i} d={d} fill="none" stroke="var(--wx-line)" strokeWidth="2" strokeLinecap="round" />
            ))}
            {metric === "score" &&
              pts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r="4" fill="var(--wx-line)" stroke="var(--wx-bg)" strokeWidth="2" />)}

            {windowDays.includes(selectedDay) && vals[windowDays.indexOf(selectedDay)] !== null && (
              <circle
                cx={x(windowDays.indexOf(selectedDay))}
                cy={y(vals[windowDays.indexOf(selectedDay)])}
                r="6"
                fill="var(--wx-line)"
                stroke="var(--wx-bg)"
                strokeWidth="2"
              />
            )}

            {hover !== null && (
              <line x1={x(hover)} x2={x(hover)} y1={top - 6} y2={bottom} stroke="var(--wx-cross)" strokeDasharray="3 3" />
            )}

            {/* Rejections band, like a forecast's precipitation strip. */}
            {windowDays.map((day, i) => {
              const n = byDay.get(day)?.rejected || 0;
              const w = plotW / CHART_DAYS;
              return (
                <g key={`r-${day}`}>
                  <rect
                    x={left + w * i + 1}
                    y={bottom + 14}
                    width={w - 2}
                    height={18}
                    rx="9"
                    fill={n ? "var(--wx-reject)" : "url(#wx-hatch)"}
                    opacity={n ? 1 : 0.5}
                  />
                  {n > 0 && (
                    <text x={x(i)} y={bottom + 27} textAnchor="middle" className="wx-band">{n}</text>
                  )}
                </g>
              );
            })}
            <defs>
              <pattern id="wx-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="var(--wx-grid)" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--wx-hatch)" strokeWidth="2" />
              </pattern>
            </defs>
          </svg>

          {hovered && (
            <div
              className="wx-tip"
              style={{ left: Math.min(width - 170, Math.max(0, x(hover) - 80)) }}
              role="status"
            >
              <div className="wx-tip-day">{hovered}{hovered === today ? " · Today" : ""}</div>
              {hovered > today ? (
                <div>—</div>
              ) : (
                <>
                  <div><strong>{hd?.sent || 0}</strong> sent</div>
                  <div><strong>{hd?.found || 0}</strong> found</div>
                  <div><strong>{hd?.rejected || 0}</strong> rejected</div>
                  <div><strong>{hd?.score ?? "—"}</strong> avg match score</div>
                  {costOf(hovered) !== null && (
                    <div className="wx-tip-cost">
                      <strong>{formatUsd(costOf(hovered))}</strong> Claude API
                      {costLines(hovered).map((l) => <div key={l} className="wx-muted small">{l}</div>)}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <div className="wx-foot">
          <span><span className="wx-key wx-key-line" /> {m.label}</span>
          <span><span className="wx-key wx-key-reject" /> Rejections received</span>
          <span><span className="wx-key wx-key-week" /> Week shown in the cards</span>
          <span className="ms-auto wx-muted">Click a day to filter the list</span>
        </div>
      </div>
    </section>
  );
}
