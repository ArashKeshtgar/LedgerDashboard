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
    python: process.execPath,
    ...overrides,
  };
}

// Starts the real app on an ephemeral port; returns a fetch helper. Uses
// the CSV store over the temp data unless deps.store is given.
export async function startApp(cfg, deps = {}) {
  const store = deps.store ?? createCsvStore(path.join(cfg.jobsearchDir, "engine"));
  const app = createApp(cfg, { ...deps, store });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
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
