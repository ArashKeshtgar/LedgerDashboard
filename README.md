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
- **Stats**: match-score distribution, sources, and the gap analysis, including which gaps show up in rejections.
- **Recruiters**: the LinkedIn outreach list with daily/weekly send targets.

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
| `applications/<folder>/` | posting, Match Report, Interview Questions, résumé/cover letter files |

`motivation.yml` (in this folder) holds the daily line at the top of every page. One quote is picked per day, by date, so it stays put until midnight.

### Recording a stage by hand

`pipeline.csv` is append-only: the **last** line for a folder is its current stage, so you never edit old rows:

```
folder,company,stage,date,note
2026-09-13__TELUS-Health__Intermediate-Backend-Developer,TELUS Health,technical_interview,2026-09-25,with two backend engineers
```

`stage` must be a key from `pipeline_stages.yml`. A future `date` shows as a booked event. Dates are read as local calendar dates.

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
