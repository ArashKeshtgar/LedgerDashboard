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
