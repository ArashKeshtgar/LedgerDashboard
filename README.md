# Ledger Dashboard

A React + Bootstrap viewer for your job-search `ledger.csv`, served by a small
Node/Express API.

## How to run it (one terminal)

Open the `server` folder, type `cmd` in the File Explorer address bar, then:

```
npm start
```

Then open **http://localhost:4310** in your browser. That's it — the server
serves both the API and the built web app, so you don't need a second terminal
or a dev server.

## What it shows

- **Applications** — the full ledger table (date, company, role, location,
  source, match score, current stage) with a search box, and a detail page per
  application showing every field, its stage timeline, and its Match Report and
  Interview Questions.
- **Pipeline** — a kanban board from Draft through to Contract signed, one card
  per application, showing how long it has sat in its current stage (or how many
  days until a booked interview). Rejected / no-response ones drop to "Closed".
- **Stats** — total/average/sources tiles, match-score distribution, status
  breakdown, applications by source, and the **gap analysis**: which gap tag
  appears in the most postings (the one worth skilling up on) versus the
  one-off gaps that are cheaper to answer in a cover letter.

## The daily line

`motivation.yml` (in this folder) holds the line that shows at the top of every
page. One is picked per day — by date, not at random, so it stays put until
midnight and the list cycles without repeating. To add your own, append an item:

```yaml
  - text: "..."
    mine: true     # optional — shows the "حرف خودت" tag
```

## Moving an application along the pipeline

Stages live in `..\JobSearch\engine\pipeline.csv` — one row per event, newest
last. To record something, add a line:

```
folder,company,stage,date,note
2026-09-13__TELUS-Health__Intermediate-Backend-Developer,TELUS Health,technical_interview,2026-09-25,با دو نفر از تیم بک‌اند
```

- `folder` must match the application's `folder` value in `ledger.csv`
- `stage` must be one of the keys in `pipeline_stages.yml`
  (`draft`, `applied`, `recruiter_screen`, `technical_interview`, `final_round`,
  `offer`, `contract_signed`, or the closers `rejected` / `no_response`)
- the **last** line for a folder is its current stage, so you never edit old
  rows — you just append
- a future `date` is fine: the board shows it as "in 5d" (a booked interview)

Editing the file in Excel works, and so does just telling Claude
("TELUS رفتم مصاحبه فنی") — the line gets appended for you.

## Where the data comes from

| File | Used for |
|---|---|
| `..\JobSearch\engine\ledger.csv` | the applications table (incl. the `gap_tags` column) |
| `..\JobSearch\engine\gap_tags.yml` | the standard gap-tag dictionary (key → description) |
| `..\JobSearch\engine\pipeline.csv` | the stage events behind the Pipeline board and the stage timeline |
| `..\JobSearch\engine\pipeline_stages.yml` | the stage list and their order/labels/icons |
| `motivation.yml` | the daily line shown at the top of every page |
| `..\JobSearch\engine\applications\<folder>\` | Match_Report.md, Interview_Questions.md, file list |

Nothing is cached — refresh the page and it re-reads the files.

## If you change the front-end code

The browser serves `client/dist`, so after editing anything under `client/src`
that folder has to be rebuilt:

```
cd client
npm run build
```

**Note:** `npm run dev` (the Vite dev server) needs native Windows binaries. If
you ever want to use it, delete `client\node_modules` and `client\package-lock.json`
first and run `npm install` from a Windows terminal. For normal use you don't
need it — `npm run build` + `npm start` is enough.

## Structure

```
LedgerDashboard/
  server/   Express API + serves the built client
  client/   React + Bootstrap source (Vite), built output in client/dist
```
