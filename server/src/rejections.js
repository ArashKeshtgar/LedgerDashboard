import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";

// Postings the nightly job-search run turned down, read back out of its
// daily reports (engine/daily/YYYY-MM-DD.md). The reports are written for a
// person, so this only trusts their stable shape: a heading that says the
// rows below were rejected ("رد"), followed by a markdown table with a
// company column and a role column.

const REPORT_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

// "برای فردا" sections list postings that passed and are waiting, even when
// the heading also mentions a rejection, so they are never read as rejects.
// "رد" must be a whole word: it is also inside "فردا" (tomorrow), "کرد" etc.
const REJECT_WORD_RE = /(^|[\s(])رد($|[\s‌)])/;

function isRejectHeading(text) {
  return REJECT_WORD_RE.test(text) && !/برای فردا/.test(text);
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const stripMd = (s) => s.replace(/\*\*/g, "").replace(/`/g, "").trim();

function columnIndex(header, patterns) {
  return header.findIndex((h) => patterns.some((p) => p.test(h)));
}

export function parseReport(markdown, date) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let section = null;
  let header = null;

  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2].trim();
      section = isRejectHeading(text)
        ? {
            title: text,
            stage: /امتیاز/.test(text) ? "scored" : "prescreen",
            track: /\bIT\b/.test(text) ? "it" : null,
          }
        : null;
      // An "IT" sub-heading (### رد شده‌ی IT) sits under an IT ## section.
      header = null;
      continue;
    }
    if (!section || !line.startsWith("|")) {
      if (!line.startsWith("|")) header = null;
      continue;
    }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // |---|---|
    if (!header) {
      header = {
        company: columnIndex(cells, [/شرکت/, /company/i]),
        role: columnIndex(cells, [/عنوان/, /role/i, /title/i]),
        score: columnIndex(cells, [/امتیاز/, /score/i]),
        reason: columnIndex(cells, [/دلیل/, /شکاف/, /reason/i, /gap/i]),
        link: columnIndex(cells, [/لینک/, /link/i]),
      };
      if (header.company < 0 || header.role < 0) header = { skip: true };
      continue;
    }
    if (header.skip) continue;
    // "Sagen (Oakville، ۹۰ تا ۱۱۵ هزار دلار)": the name, then the report's aside.
    const companyCell = stripMd(cells[header.company] || "");
    const aside = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(companyCell);
    const company = aside ? aside[1] : companyCell;
    const role = stripMd(cells[header.role] || "");
    if (!company || !role) continue;
    const scoreText = header.score >= 0 ? stripMd(cells[header.score] || "") : "";
    const score = /^\d{1,3}$/.test(scoreText) ? Number(scoreText) : null;
    const linkCell = header.link >= 0 ? cells[header.link] || "" : "";
    const url = (/\((https?:\/\/[^)\s]+)\)/.exec(linkCell) || /(https?:\/\/\S+)/.exec(linkCell) || [])[1] || "";
    out.push({
      date,
      stage: section.stage,
      track: section.track || (/\bIT\b/.test(role) || /Help ?Desk|Service Desk|Desktop Support|Technician/i.test(role) ? "it" : "dev"),
      section: section.title,
      company,
      companyNote: aside ? aside[2] : "",
      role,
      score,
      reason: header.reason >= 0 ? stripMd(cells[header.reason] || "") : "",
      url,
    });
  }
  return out;
}

// Newest report first; `days` limits how far back to read.
export function readRejections(dailyDir, { days = 30 } = {}) {
  if (!existsSync(dailyDir)) return [];
  const reports = readdirSync(dailyDir)
    .map((name) => REPORT_RE.exec(name))
    .filter(Boolean)
    .map((m) => m[1])
    .sort()
    .reverse()
    .slice(0, days);
  return reports.flatMap((date) =>
    parseReport(readFileSync(path.join(dailyDir, `${date}.md`), "utf-8"), date)
  );
}

// Rough reason buckets, so the page can say which rule drops the most.
// First match wins: a named stack beats a year count ("React ۳+ سال" is a
// stack mismatch), and only a bare "۸+ سال" or a Lead title is seniority.
const REASON_BUCKETS = [
  ["duplicate", /تکراری|قبلاً|duplicate|already/i],
  ["clearance", /clearance/i],
  ["language", /French|فرانسه|چینی|ماندارین|Mandarin|Chinese|bilingual/i],
  ["other stack", /Java|Python|PHP|Ruby|Go\b|Node|MERN|Next\.js|Salesforce|Appian|Sitecore|SAP|Dynamics|Business Central|NAV|Kafka|AWS|Databricks|Informatica|macOS|Jamf/i],
  ["seniority", /Lead|Principal|Architect|Staff|Manager|mentor|رهبری|[\d۰-۹]+\+?\s*سال|years/i],
  ["different job", /firmware|embedded|VMware|سیستم‌ادمین|sysadmin|زیرساخت|infrastructure|CRM/i],
  ["location", /محدوده|location|onsite|حضوری|خارج/i],
  ["low score", /امتیاز|score/i],
];

export function reasonBucket(row) {
  if (row.stage === "scored" && row.score !== null && !row.reason) return "low score";
  for (const [name, re] of REASON_BUCKETS) if (re.test(row.reason)) return name;
  return row.stage === "scored" ? "low score" : "other";
}
