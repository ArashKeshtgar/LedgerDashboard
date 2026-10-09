import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createApp } from "../src/app.js";
import { createCsvStore } from "../src/stores/csvStore.js";

export const FOLDER_A = "2026-09-01__Acme__Backend-Developer";
export const FOLDER_B = "2026-09-02__Globex__Data-Engineer";

const LEDGER_HEADER =
  "date,company,role,branch,source,source_detail,poster_type,poster_name,end_client," +
  "applied_via,posting_url,date_posted,date_seen,location,match_score,variant,folder,status," +
  "last_contact,next_action,outcome,notes,gap_tags";

function ledgerRow(date, company, role, folder) {
  return `${date},${company},${role},,,,,,,,,,,Toronto,70,dotnet_azure,${folder},draft,,,,,`;
}

// A throwaway copy of the JobSearch/engine layout with two applications,
// so API tests never touch the real data.
export function makeDataDir() {
  const root = mkdtempSync(path.join(tmpdir(), "ledger-test-"));
  const engine = path.join(root, "engine");
  mkdirSync(path.join(engine, "applications", FOLDER_A), { recursive: true });
  mkdirSync(path.join(engine, "applications", FOLDER_B), { recursive: true });
  mkdirSync(path.join(engine, "facts"), { recursive: true });

  writeFileSync(
    path.join(engine, "ledger.csv"),
    [LEDGER_HEADER, ledgerRow("2026-09-01", "Acme", "Backend Developer", FOLDER_A),
      ledgerRow("2026-09-02", "Globex", "Data Engineer", FOLDER_B)].join("\n") + "\n"
  );
  writeFileSync(path.join(engine, "pipeline.csv"), "folder,company,stage,date,note\n");
  writeFileSync(
    path.join(engine, "pipeline_stages.yml"),
    "stages:\n  - key: draft\n  - key: applied\n    waiting: true\nterminal:\n  - key: rejected\n"
  );
  writeFileSync(path.join(engine, "gap_tags.yml"), "etl-ssis: ETL with SSIS\n");
  writeFileSync(
    path.join(engine, "facts", "projects.yml"),
    "- id: proj.demo.one\n  claim: Built a demo.\n  tags: [proj.demo]\n  strength: strong\n" +
      "- id: skill.languages\n  claim: C#, SQL\n  tags: [shared]\n  strength: strong\n"
  );
  writeFileSync(
    path.join(engine, "target_list.csv"),
    "name,title,company,linkedin_url,source,date_added,connect_note,connect_sent,connect_accepted," +
      "followup_note,followup_sent,replied,notes\n" +
      "Jane Doe,Recruiter,Acme,https://linkedin.com/in/jane,,2026-09-01,,,,,,,\n"
  );
  // Stand-ins for the Python engine, run with Node via cfg.python, so the
  // real async build path is exercised without Python or LibreOffice.
  writeFileSync(path.join(engine, "validate.py"), "process.exit(0);\n");
  writeFileSync(
    path.join(engine, "build.py"),
    "require('fs').writeFileSync(require('path').join(process.argv[3], 'Resume.docx'), 'x');\n"
  );

  return { root, engine, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function testConfig(root, overrides = {}) {
  return {
    production: false,
    host: "127.0.0.1",
    port: 0,
    password: null,
    sessionSecret: null,
    allowedOrigins: ["http://localhost:5173"],
    jobsearchDir: root,
    clientDist: path.join(root, "no-client-build"),
    motivationPath: path.join(root, "motivation.yml"),
    anthropicApiKey: null,
    // Tests call the AI routes directly, like a script would; the manual-only
    // brake has its own tests with "none".
    aiScriptCalls: "all",
    python: process.execPath,
    ...overrides,
  };
}

// Starts the real app on an ephemeral port; returns a fetch helper. Uses
// the CSV store over the temp data unless deps.store is given.
// The Fetch standard's blocked ports (fetch.spec.whatwg.org/#port-blocking).
const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

export async function startApp(cfg, deps = {}) {
  const store = deps.store ?? createCsvStore(path.join(cfg.jobsearchDir, "engine"));
  const app = createApp(cfg, { ...deps, store });
  // listen(0) takes any free port from the OS, and on this PC Windows hands
  // out 1024-15000 — which includes ports fetch() refuses outright ("bad
  // port": 5060, 6000, 6666, 10080, ...), failing a random test now and then.
  // Re-listen until the port is one fetch will talk to.
  let server;
  for (;;) {
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    if (!FETCH_BAD_PORTS.has(server.address().port)) break;
    await new Promise((r) => server.close(r));
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, { body, headers = {} } = {}) =>
    fetch(base + url, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  // Drop idle keep-alive sockets too, so a closed test server can't leave a
  // half-open connection behind for the next test's fetch to trip over.
  const close = () =>
    new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
  return { base, call, close };
}

export function fakeAnthropic(inputFor) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        return { content: [{ type: "tool_use", input: await inputFor(req) }] };
      },
    },
  };
}
