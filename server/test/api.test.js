import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
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
