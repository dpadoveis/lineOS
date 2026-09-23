# lineOS — roadmap and known issues

lineOS closes one loop: **design** a pipeline in the editor (with AI help),
**build** it from the design (an AI outside the app does the work, through MCP),
and **monitor** what was built (lineage and health). Lineages can also be
created for pipelines that were never designed first. Nothing in it may assume
one company's databases, hosts or jobs.

This document is the working spec: stage 0 makes the repository run anywhere;
stages 1–4 are the product. Each stage should get its own design → plan →
implementation cycle; the sections below fix scope, interfaces and acceptance.

Order: **0 → 1 → 2 → 3 → 4.** Stage 0 is mostly cleanup and can run alongside 1.

---

## Where the code stands

- **Editor** (`src/flow/`, `backend/app/` flows, accounts, sharing, versions,
  `backend/mcp/`): mature, from the Flow Editor.
- **Data Lineage** (`src/ops/`, `backend/app/*_ops.py`, `routers/pipelines.py`,
  `ops/collector/`): read-only lineage canvas (React Flow + elkjs, bronze/silver/
  gold bands), bottom panel (overview, node, dataset preview/schema/stats/history,
  job runs), share links, sync edges, archive. Health states: `ok`, `late`,
  `broken`, `skipped`, `no_data`, plus `unbound` (frontend) and at-risk downstream.
- **Collector** (host cron, every 5 min): probes Airflow's metadata DB read-only,
  crontab / `cron.d`, `run-job.sh` heartbeats, and Postgres tables through a
  read-only role. Table checks daily; telemetry retention 30 days.
- **Single payload reader:** `src/ops/view.js` is the only code that reads the
  pipeline payload. Traps: health lives at `node.binding.health.state`;
  `binding === null` means unbound; `graph.nodes` are flat; `graph.edges` refer
  to the numeric node id.

---

## Stage 0 — Make it run anywhere (rebrand + cleanup)

**Status (2026-09-23):** done in code — B1–B6, the rebrand (name, identity,
English identifiers), `REGISTRATION` with a first-run admin, the compose file
with its own Postgres and the opt-in lineage override, the `/` subpath, CI and
the repo hygiene files. Open: the first CI run on GitHub (it is the only place
the Docker half is exercised end to end), wiring or retiring `e2e/` (0.4 — its
specs predate the first-run screen), and whether to rename the `FLOW_*`
variables to `LINEOS_*` (kept, to avoid breaking existing `.env` files).

### 0.1 Bugs introduced by the extraction (fix first)

| # | Problem | Fix | Done when |
|---|---|---|---|
| B1 | `src/ops/view.test.js` and `src/ops/render.test.js` import `e2e/fixtures/sample-lineage.json`, which was removed (it was a real API response). | Write a **synthetic** fixture: ~12 nodes across bronze/silver/gold, one cron, one DAG, every health state, one unbound node, one orphaned binding, one pending edge. | `npm test` green. |
| B2 | Names in tests and docs were replaced mechanically with neutral ones (`table_a`, `job_a`, `dag_a`, `warehouse`, `host:local`, `/opt/lineos`, `/etc/lineos`, `lineage_probe_ro`) and never run. | Run the full backend and frontend suites; fix whatever the rename broke (string asserts, fixtures, parser expectations in `test_probe_cron.py`). | `pytest` and `npm test` green, `npm run build` succeeds. |
| B3 | `docker-compose.yml` has **no Postgres service** (the original deployment ran Postgres as a separate project) while `DATABASE_URL` points at `postgres:5432`. | Add a `postgres` service (PG 17, volume, healthcheck, `api.depends_on`). | `docker compose up -d` on a clean machine gives a working editor. |
| B4 | The compose joins an **external** network `airflow_default` and mounts a password file; both fail on a machine without them. | Make them opt-in: a `docker-compose.lineage.yml` override (or compose profiles) for the source network and secret. | Base compose starts with neither present. |
| B5 | Docs still describe the original host (`AGENT.md`: ports "because the host already uses 5432/8000", `proxy-net` / nginx-proxy-manager, resource ceilings tuned for a small shared host). | Rewrite as neutral defaults; keep the reasoning, drop the host. | No doc mentions a specific host. |
| B6 | `backend/app/dataset_detail.py` special-cases the column `r_e_c_n_o_` (a vendor-specific row id) as the preview's sort key. | Make the ordering column configurable per source (stage 1 sources registry), fall back to the primary key, then to no ordering. | Preview sorts correctly on a table without that column. |

### 0.2 Rebrand

- User-facing name **lineOS** everywhere (title, header, auth screen, emails,
  `package.json` name, MCP server name). The module inside stays "Data Lineage".
- Default subpath `/flow-editor/` → `/` (configurable `VITE_BASE`, keep the
  subpath option).
- Internal identifiers (`src/ops`, `/api/pipelines`, `pipelines` tables) stay
  for now; rename in one dedicated change later if ever, never mixed with features.
- Mixed-language identifiers (`onFechar`, `partes`, `nova`, Portuguese export
  file names) → English, in one mechanical change.

### 0.3 Install and configuration

- One command: `docker compose up -d`, then a first-run screen that creates the
  admin account.
- Everything instance-specific comes from `.env` or from the UI (stage 1), never
  from absolute paths in code. Current hard-coded defaults to move into settings:
  `COLLECTOR_CRON_SOURCE_NAME` (`host:local`), heartbeat dirs, `/etc/lineos/*`,
  the read-only source host/db/user in `backend/app/config.py`.
- Registration is open by default (`routers/auth.py`) — fine on a private
  network, wrong on the internet. Add `REGISTRATION=open|invite|closed`,
  default `invite` once an admin exists.

### 0.4 Known limitations carried over (fix in stage 0 or document)

- **Archive drops bindings.** Deleting a lineage sets `archived_at` but removes
  its `pipeline_bindings`, so "restore" loses every binding. Either keep bindings
  on archived pipelines (and add *Restore*), or call the action *Delete* and
  confirm it as irreversible.
- **Identity is `(kind, source, external_id)`.** Moving a job between sources
  (a user crontab to `/etc/cron.d`, one host to another) creates a new object and
  orphans its bindings. Give sources a stable, user-chosen name (stage 1), and add
  a "re-point binding" action for orphans.
- **The collector cannot write diagrams** (by design). New edges it discovers
  show as `pending_edges`; a human clicks **Sync edges**. Consider an opt-in
  per-lineage auto-sync.
- **Airflow is read from its metadata DB** (SQLite via `docker exec`). It works
  on one standalone install and nowhere else. Replaced in stage 1.
- **E2E suite** (`e2e/`, Playwright) is optional and not run in CI; either wire
  it into CI or delete it.
- **Deferred feature:** changing a DAG's schedule from the lineage panel. Needs
  write access to the orchestrator — design it after stage 1's Airflow REST
  source, behind an `admin` permission and an audit trail.

### 0.5 Public-repo hygiene

- Instance data never enters this repository: deployment compose overrides,
  secrets, real fixtures, runbooks for a specific host live in a private
  deployment repo.
- Add CI (GitHub Actions): `pytest` against a service Postgres, `npm test`,
  `npm run build`, and a secret scanner (gitleaks) on every push.
- `CONTRIBUTING.md`, issue templates, and a short architecture doc replacing the
  host-specific parts of `AGENT.md`.

**Stage 0 acceptance:** a fresh clone on a clean machine → `docker compose up
-d` → sign up → draw a diagram → promote it to a lineage → the canvas renders
(empty health) — with all test suites green in CI.

---

## Stage 1 — Universal ingestion

Goal: lineOS observes any environment, not one VM.

### 1.1 OpenLineage receiver

- `POST /api/lineage/v1/events` accepting OpenLineage `RunEvent`s (START,
  RUNNING, COMPLETE, FAIL, ABORT), authenticated by a per-source API key
  (`Authorization: Bearer`), size-limited, idempotent on `(runId, eventType,
  eventTime)`.
- Mapping: job → inventory object (`kind` from the job facet / integration:
  `airflow_dag`, `airflow_task`, `dbt_model`, `spark_job`, `generic_job`);
  dataset → `table` object keyed by `namespace + name`; inputs/outputs → edges;
  run → `object_runs` (outcome, start/end, error message from the
  `errorMessage` facet).
- Datasets' schema facet feeds the Schema tab without a database connection.
- Emitters to document and test against: Airflow's OpenLineage provider, dbt
  (`openlineage-dbt`), Spark, and a plain `curl` example.

### 1.2 Sources registry

- A **Sources** screen (admin): add / test / disable a source. Types:
  `openlineage` (shows its endpoint and key), `airflow_rest`, `postgres`
  (read-only DSN, schemas to include), `cron` (a crontab or `cron.d` file, read by
  an agent on that host), `heartbeat_dir`.
- Each source has a stable **name** — it is part of object identity (see 0.4).
- Credentials stored encrypted at rest (key from env), never returned by the API,
  never logged. "Test connection" returns only ok / error class.

### 1.3 Collectors as plugins

- The current probes (`probe_airflow`, `probe_cron`, heartbeats, tables) become
  plugins behind one interface: `discover() -> objects, edges`, `runs(since) ->
  runs`, `checks(objects) -> checks`, each declaring the source type it serves.
- Push sources (OpenLineage) write through the same sink as pull sources, so
  health rules don't care where a run came from.
- **Airflow REST** (`/api/v1/dags`, `dagRuns`, `datasets`) replaces the SQLite
  read; keep the SQLite plugin only as a fallback for standalone installs.
- The host-side collector ships as its own small container / binary (the
  "agent") for cron and heartbeat sources that live on another machine; it pushes
  to the API instead of writing to the database directly.

**Stage 1 acceptance:** a stock Airflow with the OpenLineage provider pointed at
lineOS, plus one dbt project, produce a lineage with runs and health — no code
or path specific to that installation.

---

## Stage 2 — Buildable node contract, on a React Flow editor

Goal: a node in the design says enough to be built and later recognised — and
the editor where that happens is as pleasant to move around as the lineage map.
The spec, the validation errors and (stage 3) the build status all land on the
node card, so the canvas and the card are redone once, here, not twice.

Order: 2.1 → 2.2 (design, in parallel with 2.1) → 2.3.

### 2.1 Move the editor onto React Flow

Today `src/flow/` draws its own canvas, and it shows: every mouse move — even a
hover, which writes the cursor readout into state — re-renders every node, edge
and group (nothing is memoised); the wheel always zooms, in fixed 10% steps, so
a trackpad jumps and cannot pan; a pinch zooms the whole browser page (the
React wheel listener is passive); leaving the canvas mid-gesture drops it
(`onMouseLeave` ends it); mouse only, left button only; no grab cursor; no fit
to view, no minimap, zoom capped at 0.35–2.2×. The lineage canvas
(`src/ops/canvas/`) already solves all of it with `@xyflow/react`, which is a
dependency.

- **Same payload, same state.** React Flow runs *controlled*: nodes, edges and
  groups stay in `useFlowEditor`'s reducer, so undo/redo by effect, drafts,
  versions, the 409, `payload.js`, the API and the MCP do not change. The `y`
  inversion (trap 1) and document-local ids (trap 2) stay where they are.
- **Mapping.** Node card → a custom node type; the amber port → a source
  `Handle` (any node body is a drop target, as today); edge labels → a custom
  edge with an inline label editor; groups → a group node rendered behind, with
  membership still decided by `reconcileGroups()` on drag (position, not a
  list); resize → `NodeResizer` within the 168–720 × 120–900 limits; snap to
  the 24 px grid → `snapToGrid`; the metadata drop-down stays outside the card
  so edges stop at the card (trap 14).
- **Interactions to match the lineage map:** drag to pan, pinch/Ctrl+wheel to
  zoom, two-finger scroll to pan, pointer capture, fit view on open and on
  `F`, minimap, controls, zoom 0.1–3×, touch.
- **Kept as they are:** the context menus, shortcuts (Ctrl+C/V/D/G/S/Z/Y, F2,
  Delete, Esc), *Arrange* (`organize.js` feeds positions in), the PNG export
  (`exportPng.js` draws from the data, not the DOM), read-only mode for `view`.
- One canvas for both modules: shared theme tokens, card chrome and controls
  between `src/flow/` and `src/ops/canvas/`; React Flow stops being lazy-loaded
  only for lineage.
- **Done when:** every feature in the README's *Editor* list works on the new
  canvas, the `e2e/` specs pass (updated for the first-run screen and wired
  into CI — closes the open item from stage 0), and pan/zoom stay smooth on a
  200-node diagram.

### 2.2 Card and panel design (owner: Diogo, in Claude Design)

The visual source of truth for 2.3, delivered as a handoff bundle in
`design/` **with its `chats/` transcripts**. Covers:

- the node card: name and stack, spec summary (kind, inputs → outputs,
  schedule), validation state, and room for the stage 3 build status
  (designed → built → observed → healthy);
- the spec panel where a node's spec is edited;
- the validation panel (the list of problems, each jumping to its node);
- the canvas chrome (controls, minimap, fit) shared with the lineage map.

2.1 does not wait for it: it ships today's card on the new canvas.

### 2.3 The spec, the validator and the export

- Per-node **spec** (stored in the diagram payload, edited in the node panel):
  `kind` (dag / task / dbt model / cron job / table / API), `inputs` and
  `outputs` (dataset names), `schedule`, `owner`, `sla` (freshness), free-text
  `intent` ("dedupe orders by id, keep the latest").
- Every node keeps its **`uid`** (already stamped on promote); the uid is the
  join key between design, built artifact and inventory.
- **Validation** (runs in the editor, same code the MCP uses): every output has
  one producer, no cycles, schedules consistent with dependencies, required
  fields present. Errors shown on the node and in a panel.
- **Spec export**: `GET /api/flows/{id}/spec` → a versioned JSON document
  (`lineos-spec/v1`) with nodes, edges, specs and uids — the input of stage 3.

- Card, spec panel and validation panel built to the 2.2 design.

**Stage 2 acceptance:** the editor runs on React Flow with every existing
feature intact; a designed pipeline exports a spec that validates, and the
validator catches each rule's failure in a test.

---

## Stage 3 — AI build handoff (AI runs outside, via MCP)

Goal: an agent (Claude Code or any MCP client) turns a spec into real code.

- **MCP tools** (extend `backend/mcp/`): `get_spec(flow)`, `validate_spec`,
  `mark_node_built(uid, artifact_ref)`, `get_lineage_health(flow)`.
- **Build conventions** (docs + templates, not a code generator in the app):
  every generated artifact declares its lineage (Airflow `inlets`/`outlets`, dbt
  `ref`/`source`, `run-job.sh` `writes`) and carries the node's uid as a tag
  (`lineos:uid=<uid>` in DAG tags, dbt `meta`, a cron comment).
- The agent works in the **user's jobs repository** and opens a **PR** for human
  review; lineOS never pushes code or deploys.
- **Auto-bind:** when the collector sees an object carrying `lineos:uid=…`, it
  binds it to that node automatically (today binding is manual).
- Build status per node in the editor: designed → built (PR link) → observed
  (first run seen) → healthy.

**Stage 3 acceptance:** from a 3-node design, an agent opens a PR with a DAG and
a dbt model; after merge and the first run, the lineage shows all three nodes
bound and healthy with no manual binding.

---

## Stage 4 — AI-assisted design

Goal: describe a pipeline in words and get a valid design to edit.

- MCP tools to create/modify diagrams already exist (`backend/mcp/toolset.py`);
  add `propose_design(prompt, context)` guidance and make every write go through
  the stage 2 validator.
- **Context for the agent:** the inventory (what datasets and jobs already
  exist, from stage 1) so designs reuse real tables instead of inventing names.
- In the editor: a **validation panel** and a diff view of what the agent
  changed (versions already exist — show the diff between two versions).
- The AI runs outside the app; the app exposes tools and shows results, it does
  not embed a chat or hold model keys.

**Stage 4 acceptance:** "ingest table X daily and build a gold aggregate by
month" produces a valid design that references existing datasets and can go
straight into stage 3.

---

## Cross-cutting rules

- The lineage canvas stays **read-only**; editing happens in the editor.
- Secrets: files or encrypted columns, never env vars printed by `docker
  inspect`, never in logs, never returned by the API.
- Read-only access to observed systems wherever possible; any write to an
  external system (stage 3 PRs, a future schedule change) needs explicit user
  action and is audited.
- Keep the footprint small (the whole stack should run in < 512 MB): it is
  part of the pitch against heavier catalogs.
