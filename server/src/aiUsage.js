// What each Claude call cost, kept next to the package it was for:
// applications/<folder>/ai_usage.jsonl, one JSON line per call. That folder
// is the one place a release never overwrites (release.ps1 ships the engine
// files but excludes applications/), and the server log, which held these
// numbers before, is wiped on every container restart.
import { appendFileSync, existsSync, readFileSync, readdirSync } from "fs";
import path from "path";

export const USAGE_FILE = "ai_usage.jsonl";

// USD per million tokens. Cache writes are the 5-minute kind (1.25x input).
// A model missing here is priced as Sonnet and flagged, rather than as free.
const PRICES = {
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export function costOf(model, usage) {
  const p = PRICES[model] || PRICES["claude-sonnet-5"];
  const u = usage || {};
  const usd =
    ((u.input_tokens || 0) * p.input +
      (u.cache_read_input_tokens || 0) * p.cacheRead +
      (u.cache_creation_input_tokens || 0) * p.cacheWrite +
      (u.output_tokens || 0) * p.output) /
    1e6;
  return Math.round(usd * 1e6) / 1e6;
}

// One call -> one record (not yet tied to a folder).
export function usageRecord(kind, message, requestedModel) {
  const u = message?.usage;
  if (!u) return null;
  const model = message.model || requestedModel;
  return {
    at: new Date().toISOString(),
    kind,
    model,
    input: u.input_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    cache_write: u.cache_creation_input_tokens || 0,
    output: u.output_tokens || 0,
    usd: costOf(model, u),
    ...(PRICES[model] ? {} : { price_guessed: true }),
  };
}

export function recordUsage(folderPath, records) {
  const lines = (Array.isArray(records) ? records : [records]).filter(Boolean);
  if (!lines.length || !existsSync(folderPath)) return;
  appendFileSync(path.join(folderPath, USAGE_FILE), lines.map((r) => JSON.stringify(r) + "\n").join(""), "utf-8");
}

export function readUsage(folderPath) {
  const file = path.join(folderPath, USAGE_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return []; // a torn line from a crash costs one entry, not the page
      }
    });
}

export function summarize(calls) {
  const round = (n) => Math.round(n * 10000) / 10000;
  const byKind = {};
  for (const c of calls) byKind[c.kind] = round((byKind[c.kind] || 0) + (c.usd || 0));
  return { usd: round(calls.reduce((n, c) => n + (c.usd || 0), 0)), calls: calls.length, byKind };
}

// month: "YYYY-MM" (UTC, same as the stored timestamps).
export function monthUsage(applicationsDir, month) {
  const folders = existsSync(applicationsDir)
    ? readdirSync(applicationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  const perFolder = [];
  for (const folder of folders) {
    const calls = readUsage(path.join(applicationsDir, folder)).filter((c) => (c.at || "").startsWith(month));
    if (calls.length) perFolder.push({ folder, ...summarize(calls), last: calls[calls.length - 1].at });
  }
  perFolder.sort((a, b) => b.usd - a.usd);
  const all = perFolder.reduce((s, f) => ({
    usd: s.usd + f.usd,
    calls: s.calls + f.calls,
    byKind: Object.fromEntries(
      [...new Set([...Object.keys(s.byKind), ...Object.keys(f.byKind)])].map((k) => [k, (s.byKind[k] || 0) + (f.byKind[k] || 0)])
    ),
  }), { usd: 0, calls: 0, byKind: {} });
  return { month, ...all, usd: Math.round(all.usd * 10000) / 10000, packages: perFolder };
}

// Every call since `since` (an ISO date or timestamp), flat, for the
// Applications page's day cards. Only the time, kind and price leave the
// server; the client buckets by its own local day, since `at` is UTC.
export function usageCalls(applicationsDir, since) {
  const folders = existsSync(applicationsDir)
    ? readdirSync(applicationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  const out = [];
  for (const folder of folders) {
    for (const c of readUsage(path.join(applicationsDir, folder))) {
      if ((c.at || "") >= since) out.push({ at: c.at, kind: c.kind, usd: c.usd || 0, folder });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
