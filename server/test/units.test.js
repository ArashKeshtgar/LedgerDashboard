import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { csvField, readCsv, toCsv, writeFileAtomic } from "../src/csv.js";
import { isSafeFolderName, resolveApplicationFolder } from "../src/paths.js";
import { attachPipeline, FOLLOWUP_THRESHOLD_DAYS } from "../src/pipeline.js";
import { createLoginLimiter, passwordMatches } from "../src/security.js";
import { loadConfig } from "../src/config.js";
import { runProcess } from "../src/process.js";
import { slugify, weekStartISO } from "../src/text.js";
import { resolveContact, ContactValidationError } from "../src/contact.js";
import { buildFunnel, offerProbability, outcomeOf, scoreBand } from "../src/funnel.js";
import { parseReport, reasonBucket } from "../src/rejections.js";

describe("csv", () => {
  it("quotes fields containing commas, quotes and line breaks", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
    expect(csvField("cr\ronly")).toBe('"cr\ronly"');
    expect(csvField(null)).toBe("");
  });

  it("round-trips awkward values through toCsv and readCsv", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "csv-"));
    const file = path.join(dir, "t.csv");
    const rows = [{ a: "x, y", b: 'quote "q"' }, { a: "سلام", b: "" }];
    writeFileSync(file, "\uFEFF" + toCsv(["a", "b"], rows));
    expect(readCsv(file)).toEqual(rows);
  });

  it("writes atomically: replaces the file and leaves no temp file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atomic-"));
    const file = path.join(dir, "ledger.csv");
    writeFileSync(file, "old");
    writeFileAtomic(file, "new");
    expect(readFileSync(file, "utf-8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["ledger.csv"]);
  });
});

describe("application folder paths", () => {
  const root = path.join(tmpdir(), "apps");

  it("accepts generated folder names", () => {
    expect(isSafeFolderName("2026-09-13__TELUS-Health__Intermediate-Backend-Developer")).toBe(true);
    expect(resolveApplicationFolder(root, "2026-09-13__A__B")).toBe(path.join(root, "2026-09-13__A__B"));
  });

  it.each(["", ".", "..", "../facts", "a/../../b", "a/b", "a\\b", "C:\\x", "/etc", " spaced", null, 42])(
    "rejects %j",
    (name) => {
      expect(isSafeFolderName(name)).toBe(false);
      expect(() => resolveApplicationFolder(root, name)).toThrow(/Invalid application folder/);
    }
  );
});

describe("attachPipeline", () => {
  const stages = {
    stages: [{ key: "draft" }, { key: "applied", waiting: true }, { key: "technical_interview" }],
    terminal: [{ key: "rejected" }],
  };
  const now = new Date("2026-09-26T12:00:00");
  const row = { folder: "f", status: "draft" };

  it("falls back to the ledger status when there are no events", () => {
    const [r] = attachPipeline([row], [], stages, now);
    expect(r.stage).toBe("draft");
    expect(r.stageIndex).toBe(0);
  });

  it("takes the last stage event, ignoring follow-ups for the stage", () => {
    const events = [
      { folder: "f", stage: "applied", date: "2026-09-10" },
      { folder: "f", stage: "follow_up", date: "2026-09-20" },
    ];
    const [r] = attachPipeline([row], events, stages, now);
    expect(r.stage).toBe("applied");
    expect(r.daysInStage).toBe(16);
    expect(r.followupCount).toBe(1);
    expect(r.daysSinceAction).toBe(6); // the follow-up reset the clock
    expect(r.needsFollowup).toBe(false);
  });

  it(`flags a waiting stage after more than ${FOLLOWUP_THRESHOLD_DAYS} silent days`, () => {
    const events = [{ folder: "f", stage: "applied", date: "2026-09-10" }];
    expect(attachPipeline([row], events, stages, now)[0].needsFollowup).toBe(true);
  });

  it("reports a future-dated stage as days until, not a negative age", () => {
    const events = [{ folder: "f", stage: "technical_interview", date: "2026-10-01" }];
    const [r] = attachPipeline([row], events, stages, now);
    expect(r.daysInStage).toBeNull();
    expect(r.daysUntilStage).toBe(5);
  });

  it("ignores follow-ups logged before the current stage", () => {
    const events = [
      { folder: "f", stage: "follow_up", date: "2026-09-01" },
      { folder: "f", stage: "rejected", date: "2026-09-05" },
    ];
    const [r] = attachPipeline([row], events, stages, now);
    expect(r.isTerminal).toBe(true);
    expect(r.followupCount).toBe(0);
  });
});

describe("login security", () => {
  it("compares passwords correctly, including different lengths", () => {
    expect(passwordMatches("secret-password", "secret-password")).toBe(true);
    expect(passwordMatches("secret", "secret-password")).toBe(false);
    expect(passwordMatches(undefined, "secret-password")).toBe(false);
  });

  it("locks an IP out after 5 failures and lets it back in after the window", () => {
    let t = 0;
    const limiter = createLoginLimiter({ maxFailures: 5, windowMs: 1000, now: () => t });
    for (let i = 0; i < 4; i++) limiter.recordFailure("1.1.1.1");
    expect(limiter.retryAfterSeconds("1.1.1.1")).toBe(0);
    limiter.recordFailure("1.1.1.1");
    expect(limiter.retryAfterSeconds("1.1.1.1")).toBe(1);
    expect(limiter.retryAfterSeconds("2.2.2.2")).toBe(0); // per IP
    t = 1000;
    expect(limiter.retryAfterSeconds("1.1.1.1")).toBe(0);
  });

  it("clears the count on a successful login", () => {
    const limiter = createLoginLimiter({ maxFailures: 2 });
    limiter.recordFailure("ip");
    limiter.recordSuccess("ip");
    limiter.recordFailure("ip");
    expect(limiter.retryAfterSeconds("ip")).toBe(0);
  });
});

describe("loadConfig", () => {
  const secret = "x".repeat(32);

  it("binds to 127.0.0.1 with no password", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
  });

  it("refuses a public HOST without a password", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/without DASHBOARD_PASSWORD/);
  });

  it("requires a long, distinct SESSION_SECRET when a password is set", () => {
    expect(() => loadConfig({ DASHBOARD_PASSWORD: "long-enough-pass" })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ DASHBOARD_PASSWORD: "long-enough-pass", SESSION_SECRET: "short" })).toThrow();
    expect(() =>
      loadConfig({ DASHBOARD_PASSWORD: secret, SESSION_SECRET: secret })
    ).toThrow(/different/);
    const cfg = loadConfig({ DASHBOARD_PASSWORD: "long-enough-pass", SESSION_SECRET: secret });
    expect(cfg.host).toBe("0.0.0.0");
  });

  it("accepts a long, distinct API_TOKEN only alongside a password", () => {
    const withPassword = { DASHBOARD_PASSWORD: "long-enough-pass", SESSION_SECRET: secret };
    const token = "k".repeat(32);
    expect(loadConfig({ ...withPassword, API_TOKEN: token }).apiToken).toBe(token);
    expect(loadConfig(withPassword).apiToken).toBe(null);
    expect(() => loadConfig({ API_TOKEN: token })).toThrow(/DASHBOARD_PASSWORD/);
    expect(() => loadConfig({ ...withPassword, API_TOKEN: "short" })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...withPassword, API_TOKEN: secret })).toThrow(/different/);
  });

  it("rejects a short dashboard password", () => {
    expect(() => loadConfig({ DASHBOARD_PASSWORD: "short", SESSION_SECRET: secret })).toThrow(/at least 12/);
  });

  it("uses Secure cookies in production unless COOKIE_SECURE=false", () => {
    const deployed = { NODE_ENV: "production", DASHBOARD_PASSWORD: "long-enough-pass", SESSION_SECRET: secret };
    expect(loadConfig(deployed).secureCookies).toBe(true);
    expect(loadConfig({ ...deployed, COOKIE_SECURE: "false" }).secureCookies).toBe(false);
    expect(loadConfig({}).secureCookies).toBe(false);
    expect(() => loadConfig({ ...deployed, COOKIE_SECURE: "no" })).toThrow(/COOKIE_SECURE/);
  });

  it("allows the Vite dev origin only outside production", () => {
    expect(loadConfig({}).allowedOrigins).toContain("http://localhost:5173");
    expect(
      loadConfig({ NODE_ENV: "production", DASHBOARD_PASSWORD: "long-enough-pass", SESSION_SECRET: secret })
        .allowedOrigins
    ).toEqual([]);
  });
});

describe("runProcess", () => {
  it("returns exit status and output without blocking", async () => {
    const r = await runProcess(process.execPath, ["-e", "console.log('hi'); process.exit(3)"]);
    expect(r.status).toBe(3);
    expect(r.stdout.trim()).toBe("hi");
    expect(r.timedOut).toBe(false);
  });

  it("kills a process that runs past its timeout", async () => {
    const started = Date.now();
    const r = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports a missing executable instead of throwing", async () => {
    const r = await runProcess("definitely-not-a-real-binary-xyz", []);
    expect(r.status).toBeNull();
  });
});

describe("text helpers", () => {
  it("slugifies roles for folder names", () => {
    expect(slugify("Sr. Power Platform Developer (Remote)")).toBe("Sr-Power-Platform-Developer");
    expect(slugify("شرکت")).toBe("");
  });

  it("starts weeks on Monday", () => {
    expect(weekStartISO(new Date(2026, 8, 27))).toBe("2026-09-21"); // Sunday
    expect(weekStartISO(new Date(2026, 8, 21))).toBe("2026-09-21"); // Monday
  });
});

describe("resolveContact (published or verified emails only)", () => {
  const none = {};

  it("stores a published address and marks it verified", () => {
    expect(resolveContact(none, { contact_name: " Jane Doe ", contact_email: "Jane@Acme.com ", contact_source: "posting" }))
      .toEqual({ contact_name: "Jane Doe", contact_email: "jane@acme.com", contact_source: "posting", contact_verified: "true" });
  });

  it("refuses a self-found address that wasn't verified", () => {
    expect(() => resolveContact(none, { contact_email: "careers@acme.com", contact_source: "found" }))
      .toThrow(ContactValidationError);
  });

  it("accepts a self-found address once it is marked verified", () => {
    expect(resolveContact(none, { contact_email: "jane@acme.com", contact_source: "found", contact_verified: true }))
      .toMatchObject({ contact_source: "found", contact_verified: "true" });
  });

  it.each([
    ["an invalid address", { contact_email: "not-an-email", contact_source: "posting" }],
    ["a missing source", { contact_email: "jane@acme.com" }],
    ["an unknown source", { contact_email: "jane@acme.com", contact_source: "guessed" }],
  ])("refuses %s", (_label, input) => {
    expect(() => resolveContact(none, input)).toThrow(ContactValidationError);
  });

  it("clears source and verified when the email is removed, keeping the name", () => {
    const current = { contact_name: "Jane", contact_email: "jane@acme.com", contact_source: "posting", contact_verified: "true" };
    expect(resolveContact(current, { contact_email: "" }))
      .toEqual({ contact_name: "Jane", contact_email: "", contact_source: "", contact_verified: "" });
  });

  it("merges a partial update with the current contact", () => {
    const current = { contact_name: "Jane", contact_email: "jane@acme.com", contact_source: "ats_email", contact_verified: "true" };
    expect(resolveContact(current, { contact_name: "Jane Doe" })).toMatchObject({
      contact_name: "Jane Doe", contact_email: "jane@acme.com", contact_source: "ats_email",
    });
  });
});

describe("motivation.yml", () => {
  // The Docker image copies only client/ and server/; a quotes file outside
  // server/ never reached production and the daily line silently vanished.
  it("lives inside server/ and has enough distinct quotes", async () => {
    const { load } = await import("js-yaml");
    const cfg = loadConfig({});
    const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    expect(path.relative(serverDir, cfg.motivationPath).startsWith("..")).toBe(false);
    const quotes = load(readFileSync(cfg.motivationPath, "utf-8")).quotes;
    const texts = quotes.map((q) => q.text?.trim()).filter(Boolean);
    expect(texts.length).toBe(quotes.length);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts.length).toBeGreaterThanOrEqual(60);
  });
});

describe("similar postings", () => {
  it("compares postings by stack, role and industry words only", async () => {
    const { tokenize, similarTo } = await import("../src/similar.js");
    expect(tokenize("We value diversity. Senior C# / ASP.NET Core dev with SQL Server and Power BI."))
      .toEqual(["senior", "c#", "asp.net-core", "sql-server", "power-bi"]);
    // plain English that is also a tech name stays out
    expect(tokenize("Go the extra mile, rest assured, lead by example, excel at it")).toEqual([]);

    const docs = [
      { folder: "a", text: "C# .NET Core, Azure, SQL Server, React. Banking client." },
      { folder: "b", text: "Senior .NET Core developer: C#, Azure, SQL Server, Angular. Banking." },
      { folder: "c", text: "Service desk analyst: Active Directory, Windows, ticketing, ITIL." },
      { folder: "d", text: "Help desk technician: Windows, Active Directory, ITIL, Office 365." },
    ];
    const res = similarTo("a", docs, { min: 0 });
    expect(res[0].folder).toBe("b");
    expect(res[0].shared).toEqual(expect.arrayContaining(["c#", "azure", "sql-server", "banking"]));
    expect(res.find((r) => r.folder === "c")?.similarity ?? 0).toBeLessThan(res[0].similarity);
    expect(similarTo("missing", docs)).toEqual([]);
  });
});

describe("funnel", () => {
  const now = new Date(2026, 9, 30); // 30 Oct 2026, local
  const row = (folder, stages, extra = {}) => ({
    folder, track: "dev", source: "LinkedIn", match_score: "60",
    stage: stages[stages.length - 1][0],
    isTerminal: ["rejected", "no_response"].includes(stages[stages.length - 1][0]),
    stageHistory: stages.map(([stage, date]) => ({ stage, date, note: "" })),
    ...extra,
  });

  it("counts silence after 21 days as a settled no, and fresh ones as pending", () => {
    const old = outcomeOf(row("a", [["draft", "2026-10-01"], ["applied", "2026-10-01"]]), now);
    const fresh = outcomeOf(row("b", [["draft", "2026-10-20"], ["applied", "2026-10-20"]]), now);
    expect(old).toMatchObject({ silent: true, settled: true, reply: false });
    expect(fresh).toMatchObject({ silent: false, settled: false });
  });

  it("drafts never sent are not in the funnel; a later stage implies the earlier ones", () => {
    expect(outcomeOf(row("d", [["draft", "2026-10-01"]]), now)).toBeNull();
    const o = outcomeOf(row("i", [["draft", "2026-10-01"], ["applied", "2026-10-02"], ["technical_interview", "2026-10-10"]]), now);
    expect(o).toMatchObject({ screen: true, interview: true, offer: false, settled: true, reply: true });
  });

  it("groups by lower-cased source and score band, and keeps IT apart", () => {
    const rows = [
      row("a", [["applied", "2026-10-01"]]),
      row("b", [["applied", "2026-10-02"]], { source: "linkedin", match_score: "70" }),
      row("c", [["applied", "2026-10-02"], ["rejected", "2026-10-05"]], { source: "agency" }),
      row("t", [["applied", "2026-10-02"]], { track: "it" }),
    ];
    const f = buildFunnel(rows, now, { samples: 500 });
    expect(f.totals.sent).toBe(3);
    expect(f.it.sent).toBe(1);
    expect(f.bySource.find((s) => s.key === "linkedin").sent).toBe(2);
    expect(f.byBand.map((b) => b.key)).toEqual(["65+", "55–64"]);
    expect(f.totals).toMatchObject({ rejected: 1, silent: 2, settled: 3, screens: 0 });
  });

  it("zero screens pull the screen-rate estimate below the 3% prior", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`r${i}`, [["applied", "2026-09-15"]]));
    const f = buildFunnel(rows, now, { samples: 500 });
    expect(f.forecast.screenRate.mean).toBeLessThan(0.03);
    const p = f.forecast.scenarios.map((s) => s.probability);
    expect(p[2]).toBeGreaterThan(p[1]); // more applications, better odds
    expect(p[3]).toBeGreaterThan(p[1]); // better reply rate, better odds
  });

  it("forecast is deterministic and bounded", () => {
    const args = { screenA: 1.5, screenB: 48.5, offerA: 3, offerB: 17, apps: 160, samples: 3000 };
    expect(offerProbability(args)).toBe(offerProbability(args));
    expect(offerProbability({ ...args, apps: 0 })).toBe(0);
    expect(scoreBand("")).toBe("no score");
    expect(scoreBand("64")).toBe("55–64");
  });
});

describe("rejections from daily reports", () => {
  const md = [
    "## امتیاز تخمینی گرفتند",
    "| شرکت | عنوان | امتیاز |",
    "|---|---|---|",
    "| Kept | Dev | 66 |",
    "### 🕒 امتیاز گرفتند، بسته فردا",
    "| شرکت | عنوان | امتیاز |",
    "|---|---|---|",
    "| Tomorrow | Dev | 70 |",
    "## رد شده بعد از امتیازدهی",
    "| شرکت | عنوان | امتیاز | دو شکاف اصلی |",
    "|---|---|---|---|",
    "| **Sagen** (Oakville) | Application Support Developer | 54 | Java و Apache Camel |",
    "## رد در پیش‌غربال (دولوپری)",
    "| شرکت | عنوان | دلیل |",
    "|---|---|---|",
    "| MDA Space | Full Stack Developer | ۱۰+ سال و clearance می‌خواهد |",
    "### رد شده‌ی IT",
    "| شرکت | عنوان | امتیاز | دلیل |",
    "|---|---|---|---|",
    "| Opendoor | IT Support Technician | 42 | پشتیبانی macOS و MDM |",
    "## برای فردا — آگهی‌هایی که از پیش‌غربال رد شدند ولی امتیاز نگرفتند",
    "| شرکت | عنوان | دلیل |",
    "|---|---|---|",
    "| Waiting | Dev | x |",
  ].join("\n");

  it("reads only rejection tables, with stage, score, reason and track", () => {
    const rows = parseReport(md, "2026-10-03");
    expect(rows.map((r) => r.company)).toEqual(["Sagen", "MDA Space", "Opendoor"]);
    expect(rows[0]).toMatchObject({ companyNote: "Oakville", stage: "scored", score: 54, track: "dev", reason: "Java و Apache Camel" });
    expect(rows[1]).toMatchObject({ stage: "prescreen", score: null });
    expect(rows[2]).toMatchObject({ track: "it", score: 42 });
  });

  it("buckets reasons, a named stack beating a year count", () => {
    const [sagen, mda, opendoor] = parseReport(md, "2026-10-03");
    expect(reasonBucket(sagen)).toBe("other stack");
    expect(reasonBucket(mda)).toBe("clearance");
    expect(reasonBucket(opendoor)).toBe("other stack");
    expect(reasonBucket({ stage: "prescreen", reason: "۸+ سال", score: null })).toBe("seniority");
  });
});
