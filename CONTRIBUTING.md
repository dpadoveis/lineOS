# Contributing

Thanks for looking. lineOS is small and opinionated; these notes keep changes
easy to review.

## Before you start

- Read [`AGENT.md`](AGENT.md) whole — it is written for humans and coding agents
  alike, and its *Real traps in this code* section lists mistakes already made
  here once.
- For anything beyond a fix, open an issue first. [`docs/ROADMAP.md`](docs/ROADMAP.md)
  is the working spec: each stage fixes scope, interfaces and acceptance.

## Setting up

```bash
cp .env.example .env              # set FLOW_DB_PASSWORD
docker compose up -d --build      # postgres, api, frontend
npm install && npm run dev        # the frontend with hot reload, on :5173
```

## Checks

The same ones CI runs (`.github/workflows/ci.yml`):

```bash
npm test && npm run build
pip install -r backend/requirements-dev.txt
cd backend && DATABASE_URL_TEST=postgresql+psycopg://... pytest -q
python backend/mcp/selftest.py
```

`AGENT.md` has a table of which check covers which part of the code, and how to
get a disposable test database.

## Conventions

- **English everywhere**: UI copy, identifiers, comments, commits, docs.
- **No new frontend dependency**: native `fetch`, no state or UI library.
- **Colours through tokens** (`src/flow/theme.css`), never literals — the light
  and dark themes depend on it.
- **Change what the change is about.** No drive-by reformatting: the diff is
  what gets reviewed.
- **Commits**: one imperative subject saying what the change does for whoever
  uses lineOS ("Let an admin close registration"), no prefixes, no emoji.
- **No instance data**: real hosts, credentials, captured payloads or runbooks
  for one deployment stay out of this repository. Fixtures are synthetic.
