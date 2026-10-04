import { FOLLOWUP_KEY, parseLocalDate } from "./pipeline.js";

// The application funnel (applied -> any reply -> interview -> offer) and a
// 6-month "will I have an offer" forecast, computed from live pipeline rows.
// Pure: takes rows that already went through attachPipeline() and "now".

// A posting nobody has answered for this long is counted as a silent "no".
export const SILENT_DAYS = 21;

// Hiring takes ~4-6 weeks, so only applications sent in the first 20 weeks
// of a 26-week horizon can still turn into a job inside it.
const HORIZON_WEEKS = 26;
const USEFUL_WEEKS = 20;

// Benchmarks before any of the user's own data (newcomer, cold applications):
// ~3% of applications reach a recruiter screen, ~15% of screens end in an
// offer. Beta(1.5, 48.5) and Beta(3, 17) are those means with a weak weight,
// so a few weeks of real results move them quickly.
const SCREEN_PRIOR = [1.5, 48.5];
const OFFER_PRIOR = [3, 17];

const SCREEN_STAGES = ["recruiter_screen", "technical_interview", "final_round", "offer", "contract_signed"];
const INTERVIEW_STAGES = ["technical_interview", "final_round", "offer", "contract_signed"];
const OFFER_STAGES = ["offer", "contract_signed"];
const SENT_STAGES = new Set(["applied", ...SCREEN_STAGES]);

export function scoreBand(score) {
  const n = Number(score);
  if (score === "" || score === null || score === undefined || isNaN(n)) return "no score";
  if (n >= 65) return "65+";
  if (n >= 55) return "55–64";
  return "< 55";
}

export function normalizeSource(source) {
  const s = String(source || "").trim().toLowerCase();
  return s || "unknown";
}

// Monday of the date's week, as YYYY-MM-DD (local time).
function weekOf(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return null;
  const day = (d.getDay() + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return [monday.getFullYear(), monday.getMonth() + 1, monday.getDate()]
    .map((v, i) => String(v).padStart(i ? 2 : 4, "0"))
    .join("-");
}

function daysBetween(fromStr, now) {
  const d = parseLocalDate(fromStr);
  if (!d) return null;
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000);
}

// One sent application, reduced to what the funnel needs.
export function outcomeOf(row, now = new Date()) {
  const history = (row.stageHistory || []).filter((h) => h.stage !== FOLLOWUP_KEY);
  const sentEvent = history.find((h) => SENT_STAGES.has(h.stage));
  const reached = new Set(history.map((h) => h.stage));
  reached.add(row.stage);
  // A card dragged straight to Rejected/No response from draft was still sent.
  const sentDate = sentEvent?.date || (row.isTerminal ? history.find((h) => h.stage === row.stage)?.date : null);
  if (!sentDate) return null;

  const screen = SCREEN_STAGES.some((s) => reached.has(s));
  const interview = INTERVIEW_STAGES.some((s) => reached.has(s));
  const offer = OFFER_STAGES.some((s) => reached.has(s));
  const rejected = row.stage === "rejected";
  const age = daysBetween(sentDate, now);
  const silent = !screen && !rejected && (row.stage === "no_response" || (age !== null && age >= SILENT_DAYS));
  return {
    folder: row.folder,
    sentDate: String(sentDate).slice(0, 10),
    week: weekOf(String(sentDate).slice(0, 10)),
    age,
    track: row.track || "dev",
    source: normalizeSource(row.source),
    band: scoreBand(row.match_score),
    screen, interview, offer, rejected, silent,
    reply: screen || rejected,
    // Settled = we know whether it reached a screen: it did, it was turned
    // down, or it has been silent long enough to count as a no.
    settled: screen || rejected || silent,
  };
}

function tally(list) {
  const settled = list.filter((o) => o.settled).length;
  const screens = list.filter((o) => o.screen).length;
  return {
    sent: list.length,
    replies: list.filter((o) => o.reply).length,
    rejected: list.filter((o) => o.rejected).length,
    silent: list.filter((o) => o.silent).length,
    screens,
    interviews: list.filter((o) => o.interview).length,
    offers: list.filter((o) => o.offer).length,
    settled,
    pending: list.length - settled,
    screenRate: settled ? screens / settled : null,
  };
}

function groupBy(list, key) {
  const map = new Map();
  for (const o of list) {
    const k = o[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(o);
  }
  return [...map.entries()].map(([k, items]) => ({ key: k, ...tally(items) }));
}

// --- forecast ---------------------------------------------------------------

// Seeded PRNG so the same data always gives the same number on screen.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Marsaglia-Tsang gamma sampler; beta = X/(X+Y).
function gamma(rand, k) {
  if (k < 1) return gamma(rand, k + 1) * Math.pow(rand(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      x = gaussian(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function beta(rand, a, b) {
  const x = gamma(rand, a);
  return x / (x + gamma(rand, b));
}

// Probability of at least one offer from `apps` more applications, averaged
// over the uncertainty in the two rates.
export function offerProbability({ screenA, screenB, offerA, offerB, apps, rateBoost = 1, samples = 20000, seed = 7 }) {
  const rand = mulberry32(seed);
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const p = Math.min(1, beta(rand, screenA, screenB) * rateBoost) * beta(rand, offerA, offerB);
    total += 1 - Math.pow(1 - p, apps);
  }
  return total / samples;
}

export function buildFunnel(rows, now = new Date(), { samples = 20000 } = {}) {
  const outcomes = rows.map((r) => outcomeOf(r, now)).filter(Boolean);
  const dev = outcomes.filter((o) => o.track === "dev");
  const total = tally(dev);

  // Pace: developer applications per week over the last 4 full weeks.
  const recent = dev.filter((o) => o.age !== null && o.age < 28).length;
  const firstAge = Math.max(0, ...dev.map((o) => o.age ?? 0));
  const pace = recent / Math.min(4, Math.max(1, firstAge / 7));

  const screenA = SCREEN_PRIOR[0] + total.screens;
  const screenB = SCREEN_PRIOR[1] + (total.settled - total.screens);
  // A screen that ended in a rejection or offer counts as a finished process.
  const finished = dev.filter((o) => o.screen && (o.offer || o.rejected)).length;
  const offerA = OFFER_PRIOR[0] + total.offers;
  const offerB = OFFER_PRIOR[1] + (finished - total.offers);

  // Some sent applications are contracts; the goal is a permanent role.
  const permanentShare = 0.8;
  const scenario = (label, perWeek, rateBoost = 1) => ({
    label,
    perWeek: Math.round(perWeek * 10) / 10,
    rateBoost,
    probability: total.offers > 0 ? 1 : offerProbability({
      screenA, screenB, offerA, offerB, rateBoost, samples,
      apps: perWeek * USEFUL_WEEKS * permanentShare,
    }),
  });
  const base = Math.max(pace, 1);

  const weeks = groupBy(dev, "week").sort((a, b) => a.key.localeCompare(b.key));

  return {
    asOf: now.toISOString(),
    silentDays: SILENT_DAYS,
    totals: total,
    it: tally(outcomes.filter((o) => o.track === "it")),
    bySource: groupBy(dev, "source").sort((a, b) => b.sent - a.sent),
    byBand: ["65+", "55–64", "< 55", "no score"]
      .map((k) => ({ key: k, ...tally(dev.filter((o) => o.band === k)) }))
      .filter((b) => b.sent),
    byWeek: weeks,
    forecast: {
      horizonWeeks: HORIZON_WEEKS,
      usefulWeeks: USEFUL_WEEKS,
      pacePerWeek: Math.round(pace * 10) / 10,
      screenRate: { mean: screenA / (screenA + screenB), a: screenA, b: screenB },
      offerRate: { mean: offerA / (offerA + offerB), a: offerA, b: offerB },
      scenarios: [
        scenario("Half the current pace", base / 2),
        scenario("Current pace", base),
        scenario("Double the pace", base * 2),
        scenario("Current pace + referrals/agencies (2× reply rate)", base, 2),
        scenario("Double pace + referrals/agencies", base * 2, 2),
      ],
    },
  };
}
