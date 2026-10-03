import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import {
  deleteFact, gapStatus, readFacts, renderFact, saveFact, saveGap, TruthBankError,
} from "../src/truthBank.js";
import { computeHealth, mentions } from "../src/health.js";
import { FOLDER_A, FOLDER_B, fakeAnthropic, makeDataDir, startApp, testConfig } from "./fixture.js";

const fact = (id, over = {}) => ({
  id, claim: "Built a thing.", evidence: "repo commit abc1234", tags: [], allowed_numbers: [], forbidden: [],
  strength: "strong", ...over,
});

const PROJECTS = `# Header comment — must survive every edit.

- id: proj.alpha.one
  claim: >
    Built the alpha service with a long claim that is folded over more
    than one line in the file.
  evidence: "alpha repo"
  tags: [proj.alpha, docker]
  allowed_numbers: ["5"]
  forbidden: ["led"]
  strength: strong

- id: proj.alpha.two
  claim: "Second alpha fact."
  evidence: "alpha repo"
  tags: [proj.alpha]
  allowed_numbers: []
  forbidden: []
  strength: medium

# ---- beta section comment ----

- id: proj.beta.one
  claim: "Beta fact."
  evidence: "beta repo"
  tags: [proj.beta]
  allowed_numbers: []
  forbidden: []
  strength: soft
`;

describe("truth bank file edits", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "facts-"));
    writeFileSync(path.join(dir, "projects.yml"), PROJECTS);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const text = () => readFileSync(path.join(dir, "projects.yml"), "utf-8");

  it("keeps a CRLF file all-CRLF when a fact is edited", () => {
    writeFileSync(path.join(dir, "projects.yml"), PROJECTS.replace(/\n/g, "\r\n"));
    saveFact(dir, { id: "proj.alpha.two", fact: fact("proj.alpha.two", { claim: "Second alpha fact, edited.", strength: "medium", tags: ["proj.alpha"] }) });
    const after = text();
    expect(after).toContain("Second alpha fact, edited.");
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    expect(readFacts(dir).facts).toHaveLength(3);
  });

  it("edits one fact and leaves every other line of the file untouched", () => {
    saveFact(dir, { id: "proj.alpha.two", fact: fact("proj.alpha.two", { claim: "Second alpha fact, now with MongoDB.", strength: "medium", tags: ["proj.alpha", "mongodb"] }) });
    const after = text();
    expect(after.replace(/- id: proj\.alpha\.two[\s\S]*?strength: medium\n/, "")).toBe(
      PROJECTS.replace(/- id: proj\.alpha\.two[\s\S]*?strength: medium\n/, "")
    );
    const f = readFacts(dir).facts.find((x) => x.id === "proj.alpha.two");
    expect(f.claim).toBe("Second alpha fact, now with MongoDB.");
    expect(f.tags).toEqual(["proj.alpha", "mongodb"]);
  });

  it("adds a new fact after the last one of its own section", () => {
    saveFact(dir, { create: true, fact: fact("proj.alpha.three") });
    expect(readFacts(dir).facts.map((f) => f.id)).toEqual([
      "proj.alpha.one", "proj.alpha.two", "proj.alpha.three", "proj.beta.one",
    ]);
    expect(text()).toContain("# ---- beta section comment ----");
  });

  it("folds a long claim and reads it back exactly", () => {
    const long = "word ".repeat(40).trim() + ' with "quotes" and: colons # and hashes';
    saveFact(dir, { id: "proj.beta.one", fact: fact("proj.beta.one", { claim: long, allowed_numbers: ["600+"], forbidden: ["full-time"] }) });
    const f = readFacts(dir).facts.find((x) => x.id === "proj.beta.one");
    expect(f.claim).toBe(long);
    expect(f.allowed_numbers).toEqual(["600+"]);
    expect(renderFact(f)).toContain("claim: >");
  });

  it("refuses an invalid fact, a duplicate id and a rename", () => {
    const fails = (fn) => {
      try {
        fn();
      } catch (e) {
        return e;
      }
      return null;
    };
    const invalid = fails(() => saveFact(dir, { create: true, fact: fact("proj.gamma.one", { evidence: "", strength: "huge" }) }));
    expect(invalid).toBeInstanceOf(TruthBankError);
    expect(invalid.details.join(" ")).toMatch(/evidence is required/);
    expect(fails(() => saveFact(dir, { create: true, fact: fact("proj.alpha.one") })).status).toBe(409);
    expect(fails(() => saveFact(dir, { id: "proj.alpha.one", fact: fact("proj.alpha.renamed") })).status).toBe(400);
    expect(text()).toBe(PROJECTS);
  });

  it("deletes one fact and nothing else", () => {
    deleteFact(dir, "proj.alpha.two");
    expect(readFacts(dir).facts.map((f) => f.id)).toEqual(["proj.alpha.one", "proj.beta.one"]);
    expect(text()).toContain("# Header comment");
    expect(text()).not.toMatch(/\n\n\n/);
  });

  it("reports a duplicate id across files instead of silently keeping one", () => {
    writeFileSync(path.join(dir, "skills.yml"), PROJECTS.slice(PROJECTS.indexOf("- id: proj.beta.one")));
    expect(readFacts(dir).duplicates).toEqual([{ id: "proj.beta.one", files: ["projects.yml", "skills.yml"] }]);
  });
});

describe("gap dictionary edits", () => {
  let file;
  beforeEach(() => {
    file = path.join(mkdtempSync(path.join(tmpdir(), "gaps-")), "gap_tags.yml");
    writeFileSync(file, '# comment\nmongodb-nosql: "MongoDB — all relational"\nazure-devops: "Azure DevOps"\n');
  });

  it("rewrites only that gap's line", () => {
    saveGap(file, { slug: "mongodb-nosql", label: "MongoDB in production — portfolio only (proj.rebiomed.offers)" });
    expect(readFileSync(file, "utf-8")).toBe(
      '# comment\nmongodb-nosql: "MongoDB in production — portfolio only (proj.rebiomed.offers)"\nazure-devops: "Azure DevOps"\n'
    );
  });

  it("reads status from the label the same way the Context engine does", () => {
    expect(gapStatus("CI/CD — با GitHub Actions بسته شد")).toBe("closed");
    expect(gapStatus("Docker بسته شد، Kubernetes همچنان باز")).toBe("partial");
    expect(gapStatus("کامل بسته شد ولی هنوز")).toBe("closed");
    expect(gapStatus("MongoDB در production")).toBe("open");
  });
});

describe("health checks", () => {
  const facts = [
    fact("proj.rebiomed.header", { claim: "ReBiomed — MERN stack (MongoDB, Express, React)", tags: ["project_header"] }),
    fact("proj.rebiomed.offers", { claim: "A unique sparse index limits one open offer per buyer.", tags: ["proj.rebiomed", "mongodb", "security"] }),
    fact("proj.smartledger.cicd", { claim: "GitHub Actions pipeline on every push.", tags: ["proj.smartledger", "github_actions"] }),
  ];
  const app = (over) => ({
    folder: "f1", company: "Hays", role: "Dev", stage: "draft", gapTags: [], analysisStale: false, built: false, ...over,
  });

  it("flags a technology tag the claim never names (the MongoDB miss)", () => {
    const { issues } = computeHealth({ facts });
    const hit = issues.find((i) => i.kind === "tag-not-in-claim");
    expect(hit.target.id).toBe("proj.rebiomed.offers");
    expect(hit.title).toMatch(/mongodb/);
    expect(issues.some((i) => i.kind === "tag-not-in-claim" && /security/.test(i.title))).toBe(false);
  });

  it("accepts a singular or inflected mention of a tag", () => {
    expect(mentions("stored_procedures", "a stored procedure suite")).toBe(true);
    expect(mentions("reverse_engineering", "Reverse-engineered a legacy proc")).toBe(true);
    expect(mentions("azure_functions", "an HTTP-triggered Azure Function")).toBe(true);
    expect(mentions("mongodb", "a unique sparse index")).toBe(false);
    expect(mentions("sql_server", "T-SQL reporting views")).toBe(false);
  });

  it("flags an open gap that cites nothing while tagged facts exist, and a dangling reference", () => {
    const { issues } = computeHealth({
      facts,
      gaps: { "mongodb-nosql": "MongoDB — all relational", "devops-cicd": "CI/CD (proj.smartledger.gone) بسته شد" },
    });
    expect(issues.find((i) => i.kind === "gap-possible-evidence").target.id).toBe("mongodb-nosql");
    expect(issues.find((i) => i.kind === "gap-dangling-ref").title).toMatch(/proj\.smartledger\.gone/);
  });

  it("only checks drafts: stale analysis, closed gaps still tagged, changed facts", () => {
    const { issues } = computeHealth({
      facts,
      gaps: { "devops-cicd": "CI/CD (proj.smartledger.cicd) بسته شد" },
      applications: [
        app({ analysisStale: true, gapTags: ["devops-cicd"], built: true, plan: { facts_used: { "proj.smartledger.cicd": "An older claim." } } }),
        app({ folder: "f2", stage: "applied", analysisStale: true, gapTags: ["devops-cicd"] }),
      ],
    });
    const kinds = issues.filter((i) => i.target.type === "application").map((i) => `${i.kind}:${i.target.id}`);
    expect(kinds.sort()).toEqual(["draft-closed-gap:f1", "draft-plan-stale:f1", "draft-stale-analysis:f1"]);
  });

  it("checks a variant's title line only against that variant's template", () => {
    const header = (title) => ({ paragraphs: [{ text: "ARASH KESHTGAR", kind: "other" }, { text: title, kind: "other" }], sections: [] });
    const { issues } = computeHealth({
      facts: [
        fact("identity.title_dotnet_azure", { claim: ".NET / Azure Developer", tags: ["header", "variant.dotnet_azure"] }),
        fact("identity.title_powerplatform", { claim: "Power Platform Developer", tags: ["header", "variant.powerplatform"] }),
      ],
      templates: { anchors: [], variants: { dotnet_azure: header(".NET  /  Azure Developer"), powerplatform: header("Power Platform Developer") } },
    });
    expect(issues.filter((i) => i.kind === "template-identity-drift")).toEqual([]);
  });

  it("hides dismissed issues and sorts errors first", () => {
    const all = computeHealth({ facts, duplicates: [{ id: "x.y", files: ["a", "b"] }] });
    expect(all.issues[0].severity).toBe("error");
    const key = all.issues.find((i) => i.kind === "tag-not-in-claim").key;
    const after = computeHealth({ facts, duplicates: [{ id: "x.y", files: ["a", "b"] }], dismissed: [key] });
    expect(after.issues.some((i) => i.key === key)).toBe(false);
    expect(after.dismissedCount).toBe(1);
  });
});

describe("truth bank API", () => {
  let data;
  let server;
  beforeEach(() => {
    data = makeDataDir();
    writeFileSync(path.join(data.engine, "facts", "projects.yml"), PROJECTS);
    writeFileSync(path.join(data.engine, "gap_tags.yml"), 'etl-ssis: "ETL with SSIS"\nalpha-gap: "covered by proj.alpha.one بسته شد"\n');
  });
  afterEach(async () => {
    await server?.close();
    server = null;
    data.cleanup();
  });

  const gitInit = () => {
    const run = (...args) => spawnSync("git", args, { cwd: data.engine, encoding: "utf-8" });
    run("init", "-q");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "Test");
    run("add", "facts", "gap_tags.yml");
    run("commit", "-q", "-m", "baseline");
    return run;
  };

  it("lists facts with their section and the gaps that cite them", async () => {
    server = await startApp(testConfig(data.root));
    const body = await (await server.call("GET", "/api/truth-bank")).json();
    const one = body.facts.find((f) => f.id === "proj.alpha.one");
    expect(one.section).toBe("proj.alpha");
    expect(one.gaps).toEqual([{ slug: "alpha-gap", status: "closed" }]);
    expect(body.history).toBe(false);
  });

  it("saves an edit as its own commit and shows it in that fact's history", async () => {
    const run = gitInit();
    server = await startApp(testConfig(data.root));
    const res = await server.call("PUT", "/api/truth-bank/facts/proj.alpha.two", {
      body: { fact: fact("proj.alpha.two", { claim: "Now names MongoDB.", strength: "medium" }), note: "name the database" },
    });
    expect(res.status).toBe(200);
    expect(run("log", "-1", "--format=%s").stdout.trim()).toBe("Edit proj.alpha.two: name the database");
    const history = await (await server.call("GET", "/api/truth-bank/history?q=proj.alpha.two")).json();
    expect(history.commits).toHaveLength(1);
    const shown = await (await server.call("GET", `/api/truth-bank/history/${history.commits[0].hash}`)).json();
    expect(shown.diff).toContain("+  claim: \"Now names MongoDB.\"");
  });

  it("returns the validation errors and writes nothing for a bad fact", async () => {
    server = await startApp(testConfig(data.root));
    const res = await server.call("POST", "/api/truth-bank/facts", { body: { fact: fact("bad id") } });
    expect(res.status).toBe(400);
    expect((await res.json()).details[0]).toMatch(/id must look like/);
    expect(readFileSync(path.join(data.engine, "facts", "projects.yml"), "utf-8")).toBe(PROJECTS);
  });

  it("won't delete a fact a gap cites as evidence", async () => {
    server = await startApp(testConfig(data.root));
    const res = await server.call("DELETE", "/api/truth-bank/facts/proj.alpha.one");
    expect(res.status).toBe(409);
    expect((await server.call("DELETE", "/api/truth-bank/facts/proj.beta.one")).status).toBe(200);
  });

  it("edits a gap label and counts the applications tagged with it", async () => {
    server = await startApp(testConfig(data.root));
    await server.call("PATCH", `/api/applications/${FOLDER_A}`, { body: { gap_tags: "etl-ssis,unknown-gap" } });
    const res = await server.call("PUT", "/api/gaps/etl-ssis", { body: { label: "SSIS — still open" } });
    expect(res.status).toBe(200);
    const gaps = await (await server.call("GET", "/api/gaps")).json();
    const etl = gaps.find((g) => g.slug === "etl-ssis");
    expect(etl.label).toBe("SSIS — still open");
    expect(etl.counts).toMatchObject({ total: 1, draft: 1 });
    expect(gaps.find((g) => g.slug === "unknown-gap").status).toBe("undefined");
  });

  it("saves analysis.json on analyze and plan.json (with the facts used) on build", async () => {
    let call = 0;
    const anthropic = fakeAnthropic(() =>
      ++call === 1
        ? { base_variant: "dotnet_azure", match_score: 70, recommendation: "apply", reasoning: "ok", gaps: ["No SSIS"], gap_tags: ["etl-ssis"] }
        : {
            summary: "Summary.", bullets: [{ fact_id: "proj.alpha.one", text: "Built alpha." }], skill_ids: [],
            match_report_markdown: "# r", interview_questions_markdown: "# q", cover_letter_markdown: "Body.",
          }
    );
    server = await startApp(testConfig(data.root), { anthropic });
    const { folder } = await (await server.call("POST", "/api/packages/analyze", {
      body: { company: "Initech", role: "Dev", postingText: "posting" },
    })).json();
    const dir = path.join(data.engine, "applications", folder);
    const analysis = JSON.parse(readFileSync(path.join(dir, "analysis.json"), "utf-8"));
    expect(analysis.gaps).toEqual(["No SSIS"]);
    expect(analysis.bank_fingerprint).toMatch(/^[0-9a-f]{12}$/);

    let health = await (await server.call("GET", "/api/health")).json();
    expect(health.issues.some((i) => i.kind === "draft-stale-analysis" && i.target.id === folder)).toBe(false);
    expect(health.issues.some((i) => i.kind === "draft-stale-analysis" && i.target.id === FOLDER_A)).toBe(false);

    const built = await server.call("POST", "/api/packages/build", {
      body: { folder, company: "Initech", role: "Dev", postingText: "posting", base_variant: "dotnet_azure" },
    });
    expect(built.status).toBe(201);
    const plan = JSON.parse(readFileSync(path.join(dir, "plan.json"), "utf-8"));
    expect(plan.bullets[0].fact_id).toBe("proj.alpha.one");
    expect(Object.keys(plan.facts_used)).toEqual(["proj.alpha.one"]);
    expect(readFileSync(path.join(data.engine, "applications", folder, "plan.json"), "utf-8")).toContain("built_at");

    // Changing the fact the résumé used makes Health flag both the analysis and the build.
    await server.call("PUT", "/api/truth-bank/facts/proj.alpha.one", {
      body: { fact: fact("proj.alpha.one", { claim: "Built alpha, rewritten.", tags: ["proj.alpha", "docker"], allowed_numbers: ["5"], forbidden: ["led"] }) },
    });
    health = await (await server.call("GET", "/api/health")).json();
    const mine = health.issues.filter((i) => i.target.id === folder).map((i) => i.kind).sort();
    expect(mine).toEqual(["draft-plan-stale", "draft-stale-analysis"]);
    const used = (await (await server.call("GET", "/api/truth-bank")).json()).facts.find((f) => f.id === "proj.alpha.one");
    expect(used.usedIn.map((u) => u.folder)).toEqual([folder]);
  });

  it("dismisses a health check and can bring it back", async () => {
    writeFileSync(path.join(data.engine, "facts", "education.yml"), "- id: edu.degree\n  claim: A degree\n  strength: strong\n");
    server = await startApp(testConfig(data.root));
    const before = await (await server.call("GET", "/api/health")).json();
    const key = before.issues.find((i) => i.kind === "invalid-fact").key;
    await server.call("POST", "/api/health/dismiss", { body: { key } });
    const after = await (await server.call("GET", "/api/health")).json();
    expect(after.issues.some((i) => i.key === key)).toBe(false);
    expect(existsSync(path.join(data.engine, "health_dismissed.yml"))).toBe(true);
    await server.call("DELETE", "/api/health/dismiss");
    expect((await (await server.call("GET", "/api/health")).json()).issues.some((i) => i.key === key)).toBe(true);
  });

  it("commits files edited outside the dashboard", async () => {
    const run = gitInit();
    server = await startApp(testConfig(data.root));
    writeFileSync(path.join(data.engine, "gap_tags.yml"), 'etl-ssis: "edited by hand"\n');
    const health = await (await server.call("GET", "/api/health")).json();
    expect(health.issues.find((i) => i.kind === "uncommitted").detail).toContain("gap_tags.yml");
    const res = await (await server.call("POST", "/api/truth-bank/commit", { body: {} })).json();
    expect(res.files).toEqual(["gap_tags.yml"]);
    expect(run("status", "--porcelain", "--", "facts", "gap_tags.yml").stdout.trim()).toBe("");
  });

  it("refuses a résumé view for an unknown folder", async () => {
    server = await startApp(testConfig(data.root));
    expect((await server.call("GET", "/api/applications/..%2Ffacts/resume")).status).toBe(404);
    expect((await server.call("GET", `/api/applications/${FOLDER_B}/resume`)).status).toBe(404);
  });
});

describe("résumé view", () => {
  let data;
  let server;
  afterEach(async () => {
    await server?.close();
    data.cleanup();
  });

  it("joins each built bullet to the fact it came from", async () => {
    data = makeDataDir();
    writeFileSync(path.join(data.engine, "facts", "projects.yml"), PROJECTS);
    const dir = path.join(data.engine, "applications", FOLDER_A);
    writeFileSync(path.join(dir, "Arash_Keshtgar_Resume.docx"), "x");
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify({
      bullets: [{ fact_id: "proj.alpha.one", text: "Built alpha." }],
      skill_ids: [],
      facts_used: { "proj.alpha.one": "An older claim." },
    }));
    // Node stand-in for inspect_resume.py (cfg.python is node in tests).
    writeFileSync(path.join(data.engine, "inspect_resume.py"),
      "process.stdout.write(JSON.stringify({ sections: ['proj.alpha'], paragraphs: [" +
      "{ text: 'Built alpha.', kind: 'bullet', section: 'proj.alpha' }," +
      "{ text: 'Not from a fact.', kind: 'bullet', section: 'proj.alpha' }] }));\n");
    mkdirSync(path.join(data.engine, "templates"), { recursive: true });
    server = await startApp(testConfig(data.root));
    const body = await (await server.call("GET", `/api/applications/${FOLDER_A}/resume`)).json();
    expect(body.document.paragraphs[0]).toMatchObject({ fact_id: "proj.alpha.one", fact_changed: true });
    expect(body.document.paragraphs[1].fact_id).toBeUndefined();
  });
});

describe("analyze prompt", () => {
  it("marks each gap slug with its status so a closed one isn't reused", async () => {
    const data = makeDataDir();
    writeFileSync(path.join(data.engine, "gap_tags.yml"), 'frontend-modern: "React/Angular — کامل بسته شد"\netl-ssis: "SSIS"\n');
    const anthropic = fakeAnthropic(() => ({
      base_variant: "dotnet_azure", match_score: 60, recommendation: "apply", reasoning: "ok", gaps: [], gap_tags: [],
    }));
    const server = await startApp(testConfig(data.root), { anthropic });
    await server.call("POST", "/api/packages/analyze", { body: { company: "X", role: "Dev", postingText: "AngularJS" } });
    expect(anthropic.calls[0].system.map((b) => b.text).join(" ")).toContain("- frontend-modern [CLOSED]:");
    expect(anthropic.calls[0].system.map((b) => b.text).join(" ")).toContain("- etl-ssis [OPEN]:");
    await server.close();
    data.cleanup();
  });
});
