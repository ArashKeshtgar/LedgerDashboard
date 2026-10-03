# Ledger Dashboard

A job-search tracker and AI résumé builder: React (Vite + Bootstrap) front end, Node/Express API. It reads and writes the real job-search data in the sibling `JobSearch/engine/` folder (`ledger.csv`, `pipeline.csv`, `applications/`, the fact bank), and drives the Python résumé engine there (`validate.py` + `build.py`).

## Run it locally

```bash
cd server
npm install          # once
npm start
```

Open **http://localhost:4310**. The server serves both the API and the built web app, so no second terminal or dev server is needed. With no password configured it listens on **127.0.0.1 only**, so other devices on your network can't reach it.

The résumé engine needs `ANTHROPIC_API_KEY` in `server/.env` (see `server/.env.example`) and Python with `python-docx` + `pyyaml` (`JobSearch/engine/requirements.txt`). Set `PYTHON` if the interpreter isn't found automatically.

If you change anything under `client/src`, rebuild the front end:

```bash
cd client
npm run build
```

`npm run dev` (Vite on :5173) also works for front-end work; the API accepts requests from that origin outside production.

## What it does

- **Applications**: the full ledger with search, filters and date range; a detail page per application with its stage timeline, editable tracking fields, Match Report, Interview Questions and files.
- **Pipeline**: a drag-and-drop kanban from Draft to Contract signed, with days-in-stage, booked interview dates ("in 5d") and follow-up reminders after 7 silent days in a waiting stage. Drafts wait in an **approval gate** and don't count as applied until approved.
- **Build with AI** (`/packages/new`): paste a posting → `POST /api/packages/analyze` (Claude scores it against the fact bank, lists gaps, and creates a draft) → you choose Apply or Skip → `POST /api/packages/build` (Claude picks facts, `validate.py` checks the plan, and `build.py` renders the résumé and cover letter as Word + PDF, plus the Match Report and Interview Questions).
- **Hiring contact & email follow-up**: marking an application as sent first asks who you applied to (name, email, and where the email came from) — the moment the posting and the ATS confirmation are in front of you. **Only published or verified addresses are stored**: an email must come from the posting, the ATS confirmation's reply-to, or the person writing to you; one you found yourself must be marked as checked. A guessed `careers@` / `firstname@` is refused by the API and by a CHECK constraint in the database. After 7 days without a reply, **✉️ Email follow-up** opens a short, polite draft in your own mail app (nothing is sent from the dashboard); confirming it logs the follow-up and restarts the 7-day clock.
- **Stats**: match-score distribution, sources, and the gap analysis, including which gaps show up in rejections.
- **Recruiters**: the LinkedIn outreach list with daily/weekly send targets.
- **Truth Bank** (`/truth`): every fact in `facts/*.yml`, grouped by project/role, with the gaps it's evidence for and the built résumés that used it. Add, edit or remove facts here: a save rewrites only that fact's lines (comments and every other entry stay byte-for-byte), is parsed back and compared before the file is written, and is committed to the engine folder's local git repo — 🕘 shows any fact's history as diffs.
- **Gaps** (`/gaps`): the gap dictionary with each gap's status, the facts it cites as evidence, and the postings tagged with it (drafts / sent / rejected). Status is read from the label's own wording ("بسته شد" closed, plus "همچنان/باقی/هنوز" partial) — the same rule as the Context engine's `#G:` tags.
- **Résumé** (`/resume`): the base templates as the engine reads them (via `engine/inspect_resume.py`, which reuses `build.py`'s section logic), a sections × templates matrix, and every built résumé with each bullet linked to the fact it was written from (`plan.json`, saved with each build).
- **Health** (`/health`, badge in the navbar): where the truth bank, gap dictionary, templates and drafts disagree — a technology tag the claim never names (the model only reads claims), an open gap with tagged evidence but no citation, a label citing a fact that no longer exists, template skills/header lines out of date, drafts analyzed before the truth bank changed (exact, via a fingerprint in `analysis.json`), drafts still tagged with closed gaps, built drafts whose facts changed since, and truth-bank files edited outside the dashboard. Drafts can be re-analyzed one by one or all at once (`POST /api/packages/reanalyze`); a check can be dismissed (kept in `health_dismissed.yml`).

### Why the AI can't invent claims

The model never writes free-form claims. Each bullet must name a `fact_id` from an **enum** of the fact bank's real ids, and Skills lines are chosen by id and copied verbatim. `validate.py` then checks every bullet's numbers against that fact's `allowed_numbers` and its `forbidden` phrases **before anything is written to disk**. Analysis and build are separate steps, so a posting you skip only costs the cheap analysis call.

## Security model

| Mode | How it's protected |
|---|---|
| **Local** (no `DASHBOARD_PASSWORD`) | Binds to `127.0.0.1`; the server refuses to start on any other host without a password. |
| **Deployed** (`DASHBOARD_PASSWORD` + `SESSION_SECRET`) | Password login, compared in constant time; 5 wrong tries lock that IP out for 15 minutes. A signed `httpOnly` cookie session (`Secure` + `SameSite=Lax` in production) survives restarts; changing `SESSION_SECRET` logs every device out. Refuses to start if the secret is missing, shorter than 32 characters, or equal to the password. |
| **Both** | Cross-origin requests to `/api` get **403**, for reads as well as writes, so a website open in the same browser can't read the ledger, delete rows or trigger paid builds. The only foreign origin allowed is the Vite dev server, and only outside production. |

Data safety:

- Applications are addressed by their **folder name**, never by row position, so a delete or edit can't land on the wrong row after the ledger changes.
- Every folder is resolved strictly inside `applications/`. Empty, `..` or slash-containing values are rejected before touching the disk.
- `ledger.csv` and `target_list.csv` are written **atomically** (temp file + rename). If Excel has a file open, the API answers **423** with a clear message instead of failing halfway.
- `validate.py` and `build.py` run **asynchronously** with timeouts (30 s / 180 s). A hung LibreOffice is killed with its process tree, the rest of the app keeps responding, and a second build of the same application is refused while one is running.

## Deploy (Docker)

```bash
docker build -t ledger-dashboard .
docker run -p 4310:4310 \
  -e DASHBOARD_PASSWORD=... -e SESSION_SECRET=... -e ANTHROPIC_API_KEY=... \
  -v /path/to/JobSearch:/data/JobSearch \
  ledger-dashboard
```

To run it as a container on your own machine over plain `http://localhost`, add `-e COOKIE_SECURE=false`: production cookies are otherwise HTTPS-only and the browser would never send the login back. Control Panel's `compose.apps.yml` runs it this way, bound to 127.0.0.1, as a service it can start, stop and restart.

The image contains Node, Python and LibreOffice, runs as the unprivileged `node` user, and sets `NODE_ENV=production`. The job-search data is **never** baked into the image (same reason it isn't in git). Mount it at `/data/JobSearch`, and make sure that directory is writable by uid 1000.

## Tests

```bash
cd server && npm test      # Vitest
cd client && npm run lint  # oxlint
```

The server suite runs the real Express app against a temporary copy of the data layout. It covers the cross-origin guard, folder-based ids (including a delete after an earlier row was removed), path-traversal attempts, atomic writes, analyze → build with a faked Claude client and stand-in engine scripts, build timeouts and the in-flight lock, login with lockout, plus unit tests for CSV quoting, pipeline/follow-up date logic, config validation and the process runner. CI (`.github/workflows/ci.yml`) runs the tests, lint, client build and Docker build on every push.

## Data files

| File (under `JobSearch/engine/`) | Used for |
|---|---|
| `ledger.csv` | the applications table (incl. the `gap_tags` column) |
| `pipeline.csv` | append-only stage events behind the Pipeline board and timelines |
| `pipeline_stages.yml` | stage list, order, labels, icons, and which stages are "waiting" |
| `gap_tags.yml` | the gap-tag dictionary (slug → description) |
| `facts/*.yml` | the fact bank the résumé engine may draw from |
| `companies.yml` | past companies, for the duplicate-application check |
| `target_list.csv` | the recruiter outreach list |
| `applications/<folder>/` | posting, `analysis.json` (gaps + truth-bank fingerprint), `plan.json` (fact behind every bullet), Match Report, Interview Questions, résumé/cover letter files |
| `health_dismissed.yml` | Health checks you chose to hide |
| `.git` | local-only history of `facts/`, `gap_tags.yml`, `templates/` (no remote) — every dashboard save is a commit |

`server/motivation.yml` holds the daily line at the top of every page. One quote is picked per day, by date, so it stays put until midnight.

## SQL Server store (`STORE=sql`)

With `STORE=sql` in `server/.env`, applications, pipeline events, stages and recruiters live in SQL Server (`db/03-schema.sql`). The fact bank, `companies.yml`, `gap_tags.yml` and the application folders stay as files: they are hand-curated or binary.

```bash
sqlcmd -S . -E -b -i db/01-database.sql
sqlcmd -S . -E -b -d LedgerDashboard -i db/03-schema.sql
sqlcmd -S . -E -b -i db/02-service-login.sql -v DB_PASSWORD="<password>"
# put DB_PASSWORD (and STORE=sql) in server/.env, then:
cd server
npm run migrate:sql              # copy CSV -> SQL in one transaction, then verify
npm run migrate:sql -- --verify  # compare only
npm run export:csv               # SQL -> CSV snapshot in engine/sql-export/<time>/
```

**Reporting views for other systems** (`db/04-views.sql`, `db/05-reader-login.sql`): `vApplicationCurrentStage`, `vFollowupsDue`, `vFunnelBySource` and `vGapTagStats` compute in SQL what the dashboard computes in JavaScript (current stage, the 7-day follow-up rule, outcomes by source, gap tags vs rejections), and give the same numbers. The `ledger_reader` login can SELECT those four views and nothing else, not even the tables. Control Panel's `ledgerdash-adapter` connects with it.

```bash
sqlcmd -S . -E -b -d LedgerDashboard -i db/04-views.sql
sqlcmd -S . -E -b -i db/05-reader-login.sql -v READER_PASSWORD="<password>"
```

**Reporting schema `rpt`** (`db/06-report-views.sql`): `rpt.ApplicationFacts` (one row per application with every attribute a report slices by), `rpt.PipelineEvents`, `rpt.GapTags`, `rpt.Recruiters` (no names or profile URLs), plus ready-made summaries — `ScoreBucketOutcome`, `TimeToRejection`, `OutcomeByChannel`, `WeeklyActivity` (Monday weeks), `FollowupEffect`, `GapTagTrend`, `DataQuality`. `ledger_reader` can read the whole schema.

The migration never modifies the CSV files; they remain as the backup. It skips pipeline events whose application is no longer in the ledger and removes repeated gap-tag slugs, and lists both. The verification then compares every field, event, stage, recruiter and the computed pipeline view. To go back, remove `STORE=sql` and restart.

**Once on SQL, editing the CSV files has no effect.** Record stages from the UI or the API:

```bash
curl -X POST http://127.0.0.1:4310/api/pipeline-events -H "Content-Type: application/json" \
  -d '{"folder":"2026-09-13__TELUS-Health__Intermediate-Backend-Developer","stage":"technical_interview","date":"2026-09-25","note":"with two backend engineers"}'
```

`JobSearch/engine/recruiter_batch.py` also goes through the API (`POST /api/recruiters`), so it works with either store while the dashboard is running.

SQL tests run when `server/.env.test` sets `TEST_SQL_SERVER`, `TEST_SQL_USER` and `TEST_SQL_PASSWORD` for a login that can create databases. Each run creates and drops its own database. CI uses a SQL Server service container.

## Structure

```
LedgerDashboard/
  server/
    index.js        entry: loads config, starts the app
    src/app.js      routes (createApp(config) — also used by the tests)
    src/config.js   environment validation
    src/security.js origin guard, login limiter, password check
    src/csv.js      CSV parsing/quoting, atomic writes
    src/paths.js    safe application-folder resolution
    src/pipeline.js stage + follow-up computation
    src/process.js  async child processes with timeouts
    test/           Vitest suites
  client/           React source (Vite); built output in client/dist
  docs/workflow/    diagrams of the search → build → pipeline → feedback cycle
```
