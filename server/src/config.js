import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MIN_SESSION_SECRET_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 12;

// Vite's dev server runs the client on its own port and calls this API
// cross-origin. Those are the only foreign origins ever allowed, and only
// outside production — the built app is served by this server itself.
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

// Reads and validates every environment setting in one place, so a
// dangerous combination stops the server at startup instead of running.
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const password = env.DASHBOARD_PASSWORD || null;

  // With no password there's no login at all, so the API must only be
  // reachable from this machine — not from the LAN or the internet.
  const host = env.HOST || (password ? "0.0.0.0" : "127.0.0.1");
  if (!password && !LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to listen on HOST=${host} without DASHBOARD_PASSWORD — ` +
        "with no password the API is unauthenticated, so it only binds to 127.0.0.1."
    );
  }

  let sessionSecret = null;
  if (password) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`DASHBOARD_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    sessionSecret = env.SESSION_SECRET || "";
    if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(
        `SESSION_SECRET must be set to a random value of at least ${MIN_SESSION_SECRET_LENGTH} ` +
          "characters whenever DASHBOARD_PASSWORD is set."
      );
    }
    if (sessionSecret === password) {
      throw new Error("SESSION_SECRET must be different from DASHBOARD_PASSWORD.");
    }
  }

  // For scripts (the nightly job search) that can't log in through the
  // browser form: `Authorization: Bearer <API_TOKEN>`. Only meaningful when
  // a password is set — without one there's no login to get past.
  const apiToken = env.API_TOKEN || null;
  if (apiToken) {
    if (!password) throw new Error("API_TOKEN only makes sense with DASHBOARD_PASSWORD set.");
    if (apiToken.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(`API_TOKEN must be a random value of at least ${MIN_SESSION_SECRET_LENGTH} characters.`);
    }
    if (apiToken === password || apiToken === sessionSecret) {
      throw new Error("API_TOKEN must be different from DASHBOARD_PASSWORD and SESSION_SECRET.");
    }
  }

  // Data store: the CSV files (default) or SQL Server. See stores/index.js.
  const store = (env.STORE || "csv").toLowerCase();
  if (store !== "csv" && store !== "sql") throw new Error(`STORE must be "csv" or "sql", not "${env.STORE}".`);
  if (store === "sql" && !env.DB_PASSWORD) {
    throw new Error("STORE=sql needs DB_PASSWORD (the ledger_svc login, see db/02-service-login.sql).");
  }

  // Session cookies are Secure in production, so browsers only send them
  // over HTTPS. A container on this machine reached at http://localhost
  // has no TLS in front of it; COOKIE_SECURE=false is for that case only.
  const cookieSecureSetting = (env.COOKIE_SECURE || "").toLowerCase();
  if (cookieSecureSetting && cookieSecureSetting !== "true" && cookieSecureSetting !== "false") {
    throw new Error(`COOKIE_SECURE must be "true" or "false", not "${env.COOKIE_SECURE}".`);
  }
  const secureCookies = cookieSecureSetting ? cookieSecureSetting === "true" : production;

  // Claude calls cost API credit, so by default only a button click in the
  // dashboard may start one. AI_SCRIPT_CALLS lets scripts (the nightly job
  // search) in too: "analyze" = analyze/reanalyze only, "all" = build as well.
  const aiScriptCalls = (env.AI_SCRIPT_CALLS || "none").toLowerCase();
  if (!["none", "analyze", "all"].includes(aiScriptCalls)) {
    throw new Error(`AI_SCRIPT_CALLS must be "none", "analyze" or "all", not "${env.AI_SCRIPT_CALLS}".`);
  }

  const extraOrigins = (env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  return {
    production,
    host,
    port: Number(env.PORT) || 4310,
    password,
    sessionSecret,
    apiToken,
    secureCookies,
    allowedOrigins: [...(production ? [] : DEV_ORIGINS), ...extraOrigins],
    // Locally this is always the sibling folder. In a deployed environment
    // the real JobSearch/engine data (personal résumé content, application
    // notes) lives on a mounted persistent volume instead, since it's
    // intentionally never in the git repo — JOBSEARCH_DATA_DIR points there.
    jobsearchDir: env.JOBSEARCH_DATA_DIR || path.resolve(__dirname, "../../../JobSearch"),
    clientDist: path.resolve(__dirname, "../../client/dist"),
    // Inside server/ so the Docker image (COPY server) always carries it —
    // at the repo root it was left out and the daily line silently vanished.
    motivationPath: path.resolve(__dirname, "../motivation.yml"),
    store,
    db: {
      server: env.DB_SERVER || "localhost",
      port: Number(env.DB_PORT) || 1433,
      database: env.DB_NAME || "LedgerDashboard",
      user: env.DB_USER || "ledger_svc",
      password: env.DB_PASSWORD || null,
      // true for a local SQL Server with its self-signed certificate; set
      // DB_TRUST_SERVER_CERT=false for a hosted database (e.g. Azure SQL).
      trustServerCertificate: (env.DB_TRUST_SERVER_CERT || "true") !== "false",
    },
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    aiScriptCalls,
    python: env.PYTHON || null,
  };
}
