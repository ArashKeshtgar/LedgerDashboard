import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { FOLDER_A, FOLDER_B, fakeAnthropic, makeDataDir, startApp, testConfig } from "./fixture.js";
import { createCsvStore } from "../src/stores/csvStore.js";
import { createSqlStore } from "../src/stores/sqlStore.js";
import { migrateCsvToSql } from "../src/stores/migrate.js";
import { createTestDatabase, sqlAvailable } from "./sqlTestDb.js";

// The whole API suite runs once per store: the CSV files, and (when a SQL
// Server is configured) a throwaway SQL database seeded from the same
// fixture through the real migration. Same requests, same expectations.
const KINDS = sqlAvailable ? ["csv", "sql"] : ["csv"];

let testDb;
beforeAll(async () => {
  if (sqlAvailable) testDb = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  await testDb?.drop();
});

describe.each(KINDS)("%s store", (kind) => {
let data;
let server;
let store;

beforeEach(async () => {
  data = makeDataDir();
  const csvStore = createCsvStore(data.engine);
  if (kind === "sql") {
    await migrateCsvToSql({ csvStore, pool: testDb.pool, replace: true });
    store = createSqlStore(testDb.pool);
  } else {
    store = csvStore;
  }
});

afterEach(async () => {
  await server?.close();
  server = null;
  data.cleanup();
});

const start = (cfg, deps = {}) => startApp(cfg, { ...deps, store });
const ledgerFolders = async () => (await store.listApplications()).map((r) => r.folder);

describe("cross-origin guard", () => {
  beforeEach(async () => {
    server = await start(testConfig(data.root));
  });

  it("refuses a read from a foreign website", async () => {
    const res = await server.call("GET", "/api/applications", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a delete preflight from a foreign website", async () => {
    const res = await server.call("OPTIONS", `/api/applications/${FOLDER_A}`, {
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "DELETE" },
    });
    expect(res.status).toBe(403);
  });

  it("allows same-origin and non-browser requests", async () => {
    expect((await server.call("GET", "/api/applications")).status).toBe(200);
    const sameOrigin = await server.call("GET", "/api/applications", {
      headers: { Origin: server.base },
    });
    expect(sameOrigin.status).toBe(200);
  });

  it("allows the Vite dev origin and echoes it (never *)", async () => {
    const res = await server.call("GET", "/api/applications", {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
});

describe("applications are addressed by folder, not row position", () => {
  beforeEach(async () => {
    server = await start(testConfig(data.root));
  });

  it("uses the folder as the id", async () => {
    const rows = await (await server.call("GET", "/api/applications")).json();
    expect(rows.map((r) => r.id)).toEqual([FOLDER_A, FOLDER_B]);
  });

  it("deletes exactly the requested row and its folder", async () => {
    const res = await server.call("DELETE", `/api/applications/${FOLDER_B}`);
    expect(res.status).toBe(200);
    expect(await ledgerFolders()).toEqual([FOLDER_A]);
    expect(existsSync(path.join(data.engine, "applications", FOLDER_B))).toBe(false);
    expect(existsSync(path.join(data.engine, "applications", FOLDER_A))).toBe(true);
  });

  it("still deletes the right row after an earlier row was removed", async () => {
    // With index ids, deleting row 0 turned the client's "row 1" into row 0.
    await server.call("DELETE", `/api/applications/${FOLDER_A}`);
    const res = await server.call("DELETE", `/api/applications/${FOLDER_B}`);
    expect(res.status).toBe(200);
    expect(await ledgerFolders()).toEqual([]);
  });

  it("refuses traversal-shaped ids and leaves the fact bank alone", async () => {
    const res = await server.call("DELETE", `/api/applications/${encodeURIComponent("../facts")}`);
    expect(res.status).toBe(404);
    expect(existsSync(path.join(data.engine, "facts", "projects.yml"))).toBe(true);
    expect(await ledgerFolders()).toEqual([FOLDER_A, FOLDER_B]);
  });

  it("edits the requested row by folder", async () => {
    const res = await server.call("PATCH", `/api/applications/${FOLDER_B}`, {
      body: { notes: "called back", company: "ignored — not editable" },
    });
    const row = await res.json();
    expect(row.folder).toBe(FOLDER_B);
    expect(row.notes).toBe("called back");
    expect(row.company).toBe("Globex");
  });

  it.skipIf(kind !== "csv")("writes the ledger atomically without leaving temp files", async () => {
    await server.call("PATCH", `/api/applications/${FOLDER_A}`, { body: { notes: "x" } });
    expect(readdirSync(data.engine).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("resume engine", () => {
  const packageInput = {
    summary: "Summary.",
    bullets: [{ fact_id: "proj.demo.one", text: "Built a demo." }],
    skill_ids: ["skill.languages"],
    match_report_markdown: "# Match",
    interview_questions_markdown: "# Questions",
    cover_letter_markdown: "Body.",
  };

  it("analyze creates a draft row and saves the posting", async () => {
    const anthropic = fakeAnthropic(() => ({
      base_variant: "dotnet_azure", match_score: 81, recommendation: "apply",
      reasoning: "Good fit.", gaps: ["No SSIS"], gap_tags: ["etl-ssis"],
    }));
    server = await start(testConfig(data.root), { anthropic });

    const res = await server.call("POST", "/api/packages/analyze", {
      body: { company: "Initech", role: "SQL Developer", postingText: "We need SQL." },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.id).toBe(body.folder);
    expect(readFileSync(path.join(data.engine, "applications", body.folder, "posting.txt"), "utf-8"))
      .toBe("We need SQL.");
  });

  it("analyze sends a strict tool and cleans gap_tags before saving", async () => {
    const anthropic = fakeAnthropic(() => ({
      base_variant: "dotnet_azure", match_score: 140, recommendation: "apply",
      reasoning: "Good fit.", gaps: ["No SSIS", "No Redis"], gap_tags: ["ETL SSIS", "caching-redis", "etl-ssis"],
    }));
    server = await start(testConfig(data.root), { anthropic });

    const res = await server.call("POST", "/api/packages/analyze", {
      body: { company: "Initech", role: "SQL Developer", postingText: "We need SQL." },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(anthropic.calls[0].tools[0].strict).toBe(true);
    expect(body.match_score).toBe(100);
    const row = await (await server.call("GET", `/api/applications/${body.folder}`)).json();
    expect(row.gap_tags).toBe("etl-ssis,caching-redis");
  });

  it("analyze saves nothing when the model lists gaps but no gap_tags", async () => {
    const anthropic = fakeAnthropic(() => ({
      base_variant: "dotnet_azure", match_score: 58, recommendation: "skip",
      reasoning: "Weak.", gaps: ["No DBA ownership"], gap_tags: [],
    }));
    server = await start(testConfig(data.root), { anthropic });
    const before = (await (await server.call("GET", "/api/applications")).json()).length;

    const res = await server.call("POST", "/api/packages/analyze", {
      body: { company: "Initech", role: "DBA", postingText: "We need a DBA." },
    });
    expect(res.status).toBe(500);
    expect((await (await server.call("GET", "/api/applications")).json()).length).toBe(before);
  });

  it("reanalyze re-scores a draft's saved posting and keeps its variant", async () => {
    let call = 0;
    const anthropic = fakeAnthropic(() => (++call === 1
      ? { base_variant: "dotnet_azure", match_score: 72, recommendation: "apply",
        reasoning: "Ok.", gaps: ["No MongoDB", "No degree"], gap_tags: ["mongodb-nosql", "bachelor-degree-cs"] }
      : { base_variant: "powerplatform", match_score: 80, recommendation: "apply",
        reasoning: "Better.", gaps: ["No degree"], gap_tags: ["bachelor-degree-cs"] }));
    server = await start(testConfig(data.root), { anthropic });
    const { folder } = await (await server.call("POST", "/api/packages/analyze", {
      body: { company: "Initech", role: "Dotnet Developer", postingText: "We need MongoDB." },
    })).json();

    const res = await server.call("POST", "/api/packages/reanalyze", { body: { folder } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.previous.gap_tags).toBe("mongodb-nosql,bachelor-degree-cs");
    expect(body.application.gap_tags).toBe("bachelor-degree-cs");
    expect(body.application.match_score).toBe("80");
    expect(body.application.variant).toBe("dotnet_azure");
    expect(anthropic.calls[1].messages[0].content).toContain("We need MongoDB.");
    expect(anthropic.calls[1].system).toContain("the fact wins");
    expect(anthropic.calls[1].system).toContain("Never put a [CLOSED] slug in gap_tags");
  });

  it("refuses Claude calls that didn't come from a dashboard click, before calling the model", async () => {
    const anthropic = fakeAnthropic(() => ({
      base_variant: "itsupport", match_score: 74, recommendation: "apply",
      reasoning: "Ok.", gaps: [], gap_tags: [],
    }));
    server = await start(testConfig(data.root, { aiScriptCalls: "none" }), { anthropic });
    const posting = { company: "Initech", role: "Help Desk", postingText: "We need help desk." };

    for (const url of ["/api/packages/analyze", "/api/packages/reanalyze", "/api/packages/build"]) {
      const res = await server.call("POST", url, { body: { ...posting, folder: FOLDER_A } });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("ai_manual_only");
    }
    expect(anthropic.calls).toHaveLength(0);

    // The script's way: save the posting unscored, then analyze it with a click.
    const draft = await server.call("POST", "/api/applications", { body: posting });
    const { folder, variant } = await draft.json();
    expect(variant).toBe("");
    expect(readFileSync(path.join(data.engine, "applications", folder, "posting.txt"), "utf-8"))
      .toBe("We need help desk.");
    const res = await server.call("POST", "/api/packages/reanalyze", {
      body: { folder }, headers: { "X-AI-Request": "app" },
    });
    expect(res.status).toBe(200);
    const { application } = await res.json();
    expect(application.variant).toBe("itsupport");
    expect(application.match_score).toBe("74");
  });

  it("AI_SCRIPT_CALLS=analyze lets scripts analyze but not build", async () => {
    const anthropic = fakeAnthropic(() => ({
      base_variant: "dotnet_azure", match_score: 70, recommendation: "apply",
      reasoning: "Ok.", gaps: [], gap_tags: [],
    }));
    server = await start(testConfig(data.root, { aiScriptCalls: "analyze" }), { anthropic });
    const analyzed = await server.call("POST", "/api/packages/analyze", {
      body: { company: "Initech", role: "Dev", postingText: "C#" },
    });
    expect(analyzed.status).toBe(200);
    const { folder } = await analyzed.json();
    const built = await server.call("POST", "/api/packages/build", {
      body: { folder, company: "Initech", role: "Dev", postingText: "C#", base_variant: "dotnet_azure" },
    });
    expect(built.status).toBe(403);
    expect(anthropic.calls).toHaveLength(1);
  });

  it("reanalyze refuses a sent application and one without a posting, before calling the model", async () => {
    const anthropic = fakeAnthropic(() => ({}));
    server = await start(testConfig(data.root), { anthropic });

    expect((await server.call("POST", "/api/packages/reanalyze", { body: { folder: FOLDER_A } })).status)
      .toBe(422);
    writeFileSync(path.join(data.engine, "applications", FOLDER_A, "posting.txt"), "posting", "utf-8");
    await server.call("POST", "/api/pipeline-events", { body: { folder: FOLDER_A, stage: "applied" } });
    expect((await server.call("POST", "/api/packages/reanalyze", { body: { folder: FOLDER_A } })).status)
      .toBe(409);
    expect((await server.call("POST", "/api/packages/reanalyze", { body: { folder: "../facts" } })).status)
      .toBe(404);
    expect(anthropic.calls).toHaveLength(0);
  });

  it("build refuses a folder outside applications/ before calling the model", async () => {
    const anthropic = fakeAnthropic(() => packageInput);
    server = await start(testConfig(data.root), { anthropic });

    for (const folder of ["../facts", "..", "", "../../engine"]) {
      const res = await server.call("POST", "/api/packages/build", {
        body: { folder, company: "x", role: "y", postingText: "z", base_variant: "dotnet_azure" },
      });
      expect(res.status).toBe(404);
    }
    expect(anthropic.calls).toHaveLength(0);
    expect(readdirSync(path.join(data.engine, "facts"))).toEqual(["projects.yml"]);
  });

  it("build runs validate + build asynchronously and fills the folder in", async () => {
    const anthropic = fakeAnthropic(() => packageInput);
    server = await start(testConfig(data.root), { anthropic });

    const res = await server.call("POST", "/api/packages/build", {
      body: {
        folder: FOLDER_A, company: "Acme", role: "Backend Developer",
        postingText: "posting", base_variant: "dotnet_azure", match_score: 88, gap_tags: ["etl-ssis"],
      },
    });
    expect(res.status).toBe(201);
    const files = readdirSync(path.join(data.engine, "applications", FOLDER_A));
    expect(files).toEqual(expect.arrayContaining(["Resume.docx", "Match_Report.md", "CoverLetter.md"]));
    expect(readdirSync(data.engine).filter((f) => f.startsWith(".tmp-plan"))).toEqual([]);
  });

  it("build keeps the saved gap tags and score when the request doesn't send them", async () => {
    // The detail page used to send `gaps` instead of `gap_tags`; the server
    // treated "missing" as "empty" and wiped the tags /analyze had saved.
    const anthropic = fakeAnthropic(() => packageInput);
    server = await start(testConfig(data.root), { anthropic });
    await server.call("PATCH", `/api/applications/${FOLDER_A}`, { body: { gap_tags: "etl-ssis,power-bi" } });

    const res = await server.call("POST", "/api/packages/build", {
      body: {
        folder: FOLDER_A, company: "Acme", role: "Backend Developer",
        postingText: "posting", base_variant: "powerplatform",
      },
    });
    const row = await res.json();
    expect(res.status).toBe(201);
    expect(row.gap_tags).toBe("etl-ssis,power-bi");
    expect(row.match_score).toBe("70");
    expect(row.variant).toBe("powerplatform");
    expect(row.track).toBe("dev");
  });

  it("marks a package built from the itsupport variant as the IT track", async () => {
    const anthropic = fakeAnthropic(() => packageInput);
    server = await start(testConfig(data.root), { anthropic });

    const res = await server.call("POST", "/api/packages/build", {
      body: {
        folder: FOLDER_A, company: "Acme", role: "Service Desk Analyst",
        postingText: "posting", base_variant: "itsupport",
      },
    });
    expect(res.status).toBe(201);
    const listed = (await (await server.call("GET", "/api/applications")).json())
      .find((r) => r.folder === FOLDER_A);
    expect(listed.track).toBe("it");
  });

  it("keeps serving other requests while a build runs, and refuses a second build of the same folder", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const anthropic = fakeAnthropic(async () => {
      await gate;
      return packageInput;
    });
    server = await start(testConfig(data.root), { anthropic });
    const buildBody = {
      folder: FOLDER_A, company: "Acme", role: "Backend Developer",
      postingText: "posting", base_variant: "dotnet_azure",
    };

    const first = server.call("POST", "/api/packages/build", { body: buildBody });
    await new Promise((r) => setTimeout(r, 50));

    expect((await server.call("GET", "/api/applications")).status).toBe(200);
    expect((await server.call("POST", "/api/packages/build", { body: buildBody })).status).toBe(409);
    expect((await server.call("DELETE", `/api/applications/${FOLDER_A}`)).status).toBe(409);

    release();
    expect((await first).status).toBe(201);
  });

  it("gives a guardian-rejected package one repair turn with the errors, then gives up", async () => {
    // Stand-in guardian: rejects until a marker file exists, which the test
    // creates between the two model calls.
    const marker = path.join(data.engine, "ok.marker");
    writeFileSync(
      path.join(data.engine, "validate.py"),
      `if (!require('fs').existsSync(${JSON.stringify(marker)})) { console.log("ERROR: summary: blacklisted guarantee-verb 'ensuring' found"); process.exit(1); }\n`
    );
    let repairable = true;
    const anthropic = fakeAnthropic(() => {
      if (repairable && anthropic.calls.length === 2) writeFileSync(marker, "");
      return packageInput;
    });
    server = await start(testConfig(data.root), { anthropic });
    const body = {
      folder: FOLDER_A, company: "Acme", role: "Backend Developer",
      postingText: "posting", base_variant: "dotnet_azure",
    };

    expect((await server.call("POST", "/api/packages/build", { body })).status).toBe(201);
    expect(anthropic.calls).toHaveLength(2);
    const repair = anthropic.calls[1].messages.at(-1).content[0];
    expect(repair.type).toBe("tool_result");
    expect(repair.content).toContain("'ensuring'");

    rmSync(marker);
    repairable = false;
    const failed = await server.call("POST", "/api/packages/build", { body });
    expect(failed.status).toBe(422);
    expect(anthropic.calls).toHaveLength(4);
  });

  it("sends a package that drops an employment role back for repair", async () => {
    writeFileSync(
      path.join(data.engine, "facts", "experience.yml"),
      "- id: exp.acme.role\n  claim: Developer at Acme\n  tags: [role_header]\n  strength: strong\n"
    );
    const anthropic = fakeAnthropic(() => packageInput);
    server = await start(testConfig(data.root), { anthropic });

    const res = await server.call("POST", "/api/packages/build", {
      body: {
        folder: FOLDER_A, company: "Acme", role: "Backend Developer",
        postingText: "posting", base_variant: "dotnet_azure",
      },
    });
    expect(res.status).toBe(422);
    expect(anthropic.calls).toHaveLength(2);
    expect(anthropic.calls[1].messages.at(-1).content[0].content).toContain("exp.acme");
  });

  it("kills a hung validate step and answers 504 instead of hanging", async () => {
    writeFileSync(path.join(data.engine, "validate.py"), "setTimeout(() => {}, 60000);\n");
    const anthropic = fakeAnthropic(() => packageInput);
    server = await start(testConfig(data.root, { validateTimeoutMs: 500 }), { anthropic });

    const res = await server.call("POST", "/api/packages/build", {
      body: {
        folder: FOLDER_A, company: "Acme", role: "Backend Developer",
        postingText: "posting", base_variant: "dotnet_azure",
      },
    });
    expect(res.status).toBe(504);
    // The lock is released, so the next build of this folder is allowed again.
    writeFileSync(path.join(data.engine, "validate.py"), "process.exit(0);\n");
    const retry = await server.call("POST", "/api/packages/build", {
      body: {
        folder: FOLDER_A, company: "Acme", role: "Backend Developer",
        postingText: "posting", base_variant: "dotnet_azure",
      },
    });
    expect(retry.status).toBe(201);
  });
});

describe("undoing a stage marked by mistake", () => {
  beforeEach(async () => {
    server = await start(testConfig(data.root));
    for (const [folder, stage] of [[FOLDER_A, "draft"], [FOLDER_B, "draft"], [FOLDER_A, "applied"],
      [FOLDER_B, "applied"], [FOLDER_A, "rejected"]]) {
      await server.call("POST", "/api/pipeline-events", { body: { folder, stage } });
    }
  });

  const undo = (body) => server.call("POST", "/api/pipeline-events/undo", { body });
  const stagesOf = async (folder) =>
    (await (await server.call("GET", `/api/applications/${folder}`)).json()).stageHistory.map((h) => h.stage);

  it("removes only the latest event of that application", async () => {
    const res = await undo({ folder: FOLDER_A });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage).toBe("applied");
    expect(body.removed.map((e) => e.stage)).toEqual(["rejected"]);
    expect(await stagesOf(FOLDER_A)).toEqual(["draft", "applied"]);
    expect(await stagesOf(FOLDER_B)).toEqual(["draft", "applied"]);
  });

  it("resets to the first event with all, then has nothing left to undo", async () => {
    expect((await (await undo({ folder: FOLDER_A, all: true })).json()).stage).toBe("draft");
    expect(await stagesOf(FOLDER_A)).toEqual(["draft"]);
    expect(await stagesOf(FOLDER_B)).toEqual(["draft", "applied"]);
    expect((await undo({ folder: FOLDER_A })).status).toBe(409);
  });

  it("404s an unknown folder", async () => {
    expect((await undo({ folder: "nope" })).status).toBe(404);
  });
});

describe("hiring contact", () => {
  beforeEach(async () => {
    server = await start(testConfig(data.root));
  });

  const patch = (body) => server.call("PATCH", `/api/applications/${FOLDER_A}`, { body });

  it("saves a published contact and returns it on the row", async () => {
    const res = await patch({ contact_name: "Jane Doe", contact_email: "Jane@Acme.com", contact_source: "ats_email" });
    expect(res.status).toBe(200);
    const row = await (await server.call("GET", `/api/applications/${FOLDER_A}`)).json();
    expect(row).toMatchObject({
      contact_name: "Jane Doe", contact_email: "jane@acme.com", contact_source: "ats_email", contact_verified: "true",
    });
  });

  it("refuses a guessed address and leaves the row unchanged", async () => {
    const res = await patch({ contact_email: "careers@acme.com", contact_source: "found" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/published or verified/);
    const row = await (await server.call("GET", `/api/applications/${FOLDER_A}`)).json();
    expect(row.contact_email).toBe("");
  });

  it("accepts a self-found address once marked verified, and clears it again", async () => {
    expect((await patch({ contact_email: "jane@acme.com", contact_source: "found", contact_verified: true })).status).toBe(200);
    const cleared = await (await patch({ contact_email: "" })).json();
    expect(cleared).toMatchObject({ contact_email: "", contact_source: "", contact_verified: "" });
  });

  it("returns empty contact fields on rows that never had one", async () => {
    const rows = await (await server.call("GET", "/api/applications")).json();
    expect(rows[1]).toMatchObject({ contact_name: "", contact_email: "", contact_source: "", contact_verified: "" });
  });
});

describe("password login", () => {
  const SECRET = "s".repeat(40);
  const PASSWORD = "correct-horse-battery";

  beforeEach(async () => {
    server = await start(testConfig(data.root, { password: PASSWORD, sessionSecret: SECRET }));
  });

  it("requires a session for the API", async () => {
    expect((await server.call("GET", "/api/applications")).status).toBe(401);
  });

  it("logs in with the right password and uses the session cookie", async () => {
    const login = await server.call("POST", "/api/login", { body: { password: PASSWORD } });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("ld_session=");
    const res = await server.call("GET", "/api/applications", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  it("locks out an IP after 5 wrong passwords, even for the right one", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await server.call("POST", "/api/login", { body: { password: "nope" } })).status).toBe(401);
    }
    const blocked = await server.call("POST", "/api/login", { body: { password: PASSWORD } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("API token", () => {
  const TOKEN = "t".repeat(40);

  beforeEach(async () => {
    server = await start(
      testConfig(data.root, { password: "correct-horse-battery", sessionSecret: "s".repeat(40), apiToken: TOKEN })
    );
  });

  it("lets a script in with the bearer token", async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await server.call("GET", "/api/applications", { headers: auth })).status).toBe(200);
    expect(await (await server.call("GET", "/api/session", { headers: auth })).json()).toMatchObject({ authed: true });
  });

  it("refuses a wrong or missing token", async () => {
    const wrong = { Authorization: `Bearer ${"x".repeat(40)}` };
    expect((await server.call("GET", "/api/applications", { headers: wrong })).status).toBe(401);
    expect((await server.call("GET", "/api/applications", { headers: { Authorization: TOKEN } })).status).toBe(401);
    expect((await server.call("GET", "/api/applications")).status).toBe(401);
  });
});

describe("recruiters", () => {
  it("uses a stable hash id instead of the row position", async () => {
    server = await start(testConfig(data.root));
    const { rows } = await (await server.call("GET", "/api/recruiters")).json();
    expect(rows[0].id).toMatch(/^[0-9a-f]{12}$/);

    const res = await server.call("POST", `/api/recruiters/${rows[0].id}`, {
      body: { field: "connect_sent" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).stage).toBe("connect_sent");
    expect((await server.call("POST", "/api/recruiters/0", { body: { field: "replied" } })).status).toBe(404);
  });
});
});
