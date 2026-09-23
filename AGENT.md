# AGENT.md — project context

Required reading before touching the code. It describes what this project is,
how the two halves fit together, which conventions to follow, and where the
traps are.

## What it is

**lineOS** designs, builds and monitors data pipelines (the plan is in
[`docs/ROADMAP.md`](docs/ROADMAP.md)). Its two modules today:

- the **editor** (`src/flow/`), inherited from the Flow Editor — described
  below;
- **Data Lineage** (`src/ops/`, `backend/app/*_ops.py`, `ops/collector/`): a
  diagram promoted to a watched lineage, with the health of each bound job and
  table.

The editor is a visual editor for data architectures on a cartesian plane.
The user drags tools (Airflow, dbt, Kafka, Snowflake…) from a search box onto
the plane, links them with labelled directed arrows, describes each step and
attaches key/value metadata. The result can be laid out automatically in layers,
exported as PNG/JSON and — since the backend arrived — **stored on the server
with a version history**.

Since **accounts** arrived, each diagram belongs to a user and can be **shared**
with others — by account, by link or by email — at three permission levels
(`view`, `edit`, `full`). The application opens on the **home**, with that
account's recent diagrams; the editor is a route, not the landing screen.

The project grew out of a Claude Design prototype, kept in `design/`.

## Architecture

Two independent halves, joined by HTTP at `/api`:

```
browser                          docker compose (project "lineos")
┌──────────────────────┐         ┌──────────────────────────────────────┐
│ React 18 + Vite      │         │ frontend   nginx      :8020 -> 80    │
│ :5173 (npm run dev)  │         │      │ /api                          │
│                      │  /api   │      ▼                               │
│ src/flow/*.jsx  ─────┼────────►│ api        FastAPI    :8010 -> 8000  │
│ src/flow/api.js      │  proxy  │      │                               │
└──────────────────────┘  Vite   │      ▼                               │
                                 │ postgres   PG 17      :5433 -> 5432  │
                                 │   schema "flow" in the "lineos" db   │
                                 │ volumes: lineos_pgdata, lineos_files │
                                 └──────────────────────────────────────┘
```

In development the frontend runs on Vite, and the `/api` proxy (in
`vite.config.js`) avoids CORS. The **published version** is the compose file's
`frontend` service: a static build served by nginx at `/` (or under the
subpath in `FLOW_BASE`), which also proxies `/api` to the API — see
[`docs/DEPLOY.md`](docs/DEPLOY.md). The dataset tabs of Data Lineage read a
Postgres of the user's; joining its network is opt-in, in
`docker-compose.lineage.yml`.

### MCP

`backend/mcp/` publishes the editor to MCP clients (Claude Code, Claude
Desktop): a stdio server that talks to the **API over HTTP**, like any other
client, so permissions, validation and the 409 on concurrency apply to the agent
too. Standard library only — a server that needs installing is not running
when the client tries to start it, on a machine without pip or a venv.
Credentials come from the `FLOW_MCP_*` keys in `.env`. Details in
[`backend/mcp/README.md`](backend/mcp/README.md).

### Ports

`5433` (Postgres) and `8010` (API) instead of the usual 5432/8000, so a stack
started next to another Postgres or API does not collide with it; both are bound
to `127.0.0.1` only, and both move with `FLOW_DB_PORT` / `FLOW_API_PORT`. The
published frontend sits on `8020` (`FLOW_HTTP_PORT`), Vite on `5173`.

### Resource limits

A small footprint is part of the pitch, so every service has an explicit
ceiling (`deploy.resources.limits` in the compose file): **0.60 CPU each**, 512 MB for
Postgres and 384 MB for the API. The Postgres tuning (`shared_buffers=128MB`,
`max_connections=50`, parallelism off) and SQLAlchemy's `pool_size=5` exist to
fit inside those ceilings — **do not raise one without the other**. Details and
rationale in [`docs/BACKEND.md`](docs/BACKEND.md).

## How to run it

```bash
cp .env.example .env          # set FLOW_DB_PASSWORD
docker compose up -d --build  # postgres + api + the frontend on :8020
npm install && npm run dev    # http://localhost:5173
```

A change in `src/` only reaches the published version after
`docker compose up -d --build frontend` — the image carries the build inside it.

Quick checks: `curl localhost:8010/api/health`, interactive documentation at
`http://localhost:8010/api/docs`, and `docker compose ps` for the healthchecks.

## Working here (for agents)

What follows applies to any agent working in this repository — Claude Code, an
MCP client, whatever comes next.

### Before changing anything

Read this file whole, then the document for the half you are touching:
[`docs/BACKEND.md`](docs/BACKEND.md) for the API and the database,
[`docs/DEPLOY.md`](docs/DEPLOY.md) for the publication and the proxy,
[`backend/mcp/README.md`](backend/mcp/README.md) for the MCP server, and
[`e2e/README.md`](e2e/README.md) **before** running anything end to end. "Real
traps in this code", further down, is not optional reading: almost every item
there is a mistake already made once here.

Then look at what is running — `docker compose ps`. The compose project is
`flow-editor`, but **the host carries more than ten containers from other
projects**: never run `docker compose down` without naming a service, never
`docker system prune`, and never `docker rm` a container you did not start.

### The loop: change, verify, report

Do not report a change as done without the check for the half you touched.

| Touched | Check |
| --- | --- |
| anything in `src/` | `npm run build`, then the manual round trip described under Tests |
| the plane, the header, sharing, the home | the same, plus the `e2e/` suite — **against a disposable API** (`e2e/README.md`), never against your real one |
| `backend/app/` | the pytest suite, with `DATABASE_URL_TEST` pointing at `flows_test` |
| `backend/app/models.py` | the above, plus `docker compose up -d --build api` and `docker compose logs api` — the migration runs at startup |
| `backend/mcp/` | `python3 backend/mcp/selftest.py` (the round-trip half needs the disposable API) |
| the compose file, nginx, the subpath | `docker compose config` and the checklist in `docs/DEPLOY.md` |

A change under `src/` reaches Vite and stops there. It only reaches the
published frontend after `docker compose up -d --build frontend`.

When a check cannot be run — no test database, the API is down, the environment
refuses — say so plainly in the answer. An unverified change reported as
verified is worse than an unfinished one.

### Things that move together

Changing one side alone leaves the project inconsistent. These are the pairs
this project has already broken at least once:

- `src/flow/payload.js` **and** `backend/app/schemas.py` — the serialised format;
- `backend/app/models.py` **and** an idempotent `ALTER` in `app/migrations.py`;
- `META_*` in `src/flow/constants.js` **and** `.fe-meta-drop` in the CSS — or the
  PNG stops matching the screen;
- `backend/app/config.py` **and** `docker-compose.yml` — the ceilings on size and
  on resources;
- the four places that carry the published subpath, listed in the map above.

### Scope

Change what was asked and leave the rest alone. Do not reformat, re-indent or
"tidy" a file you had no reason to touch — the diff is what gets reviewed, and
noise in it hides the change. The one standing exception is the Portuguese
leftovers: renaming one is always in scope.

The frontend takes **no new dependency** — the native `fetch`, no axios, no
state library, no UI framework, no test runner of its own. A backend dependency
means editing `backend/requirements.txt` and rebuilding the image; do not add one
for something the standard library already does, and never add one to
`backend/mcp/`, which has to start on a host with no `pip`.

### Driving the editor over MCP

`backend/mcp/` lets an agent create and edit diagrams through the API. It is a
client like any other: it authenticates with the `FLOW_MCP_*` credentials, it
obeys permissions and it takes the 409 on stale versions. It also **writes for
real** — point `FLOW_MCP_BASE_URL` at the disposable API when experimenting (or
set `FLOW_MCP_READ_ONLY=true`), and treat whatever it names as production
otherwise. The `.mcp.json` at the root declares the server; this checkout keeps
it disabled in `.claude/settings.local.json`, so turning it on is the user's
call.

### Commits

Only when asked for one. Then: a single subject line, imperative English, saying
what the change does for whoever uses the editor — "Edit a registered tool, from
a button under New tool", not "feat(tools): add edit modal". No Conventional
Commits prefix, no scope in parentheses, no emoji. Nothing generated goes in
(`dist/`, `test-results/`, `node_modules/`), and `.env` never does.


## Data model

The contract between the two halves is the **`flow-graph`** payload, produced by
`flowPayload()` in `src/flow/payload.js` and documented in the README:

```json
{ "kind": "flow-graph", "version": 1,
  "nodes": [{ "id": 1, "name": "Airflow", "label": "Daily ingestion",
              "category": "ORCHESTRATION", "initials": "AF", "color": "#7dd3a0",
              "x": -432, "y": 24, "width": null, "height": null,
              "description": null, "metadata": {}, "tool": null, "group": 1 }],
  "edges": [{ "id": 1, "from": 1, "to": 2, "label": "trigger" }],
  "groups": [{ "id": 1, "name": "Ingestion", "x": -480, "y": 120,
               "width": 520, "height": 320, "color": "#6fb8d3" }] }
```

That object is written whole into a `jsonb` column, **without** being decomposed
into node/edge tables. Eight tables in the `flow` schema:

| Table | Role |
| --- | --- |
| `flows` | the "file": name, slug, description, `current_version`, `draft_graph`, trash (`deleted_at`) |
| `flow_versions` | **immutable** snapshots (INSERT/SELECT only), numbered per flow |
| `flow_assets` | binary attachments (the exported PNG and so on), content on the volume, addressed by sha256 |
| `custom_tools` | the catalog of tools registered by users — **not** flow content. A row with `builtin` set stands for a built-in tool that was edited; with `hidden`, for one taken out of the sidebar |
| `users` | accounts: email (the login, lowercased), name and a PBKDF2 password hash |
| `user_sessions` | one row per signed-in browser; keeps the **sha256** of the cookie's token, never the token |
| `flow_shares` | one flow shared with one account, at one level (`view`/`edit`/`full`) |
| `flow_share_links` | a shareable link; keeps the **sha256** of the token and the level it grants |

`flows.owner_id` is the owner. It is nullable **only** because of the flows
created before accounts existed: the first registration adopts them
(`access.adopt_orphan_flows`), and from then on every flow is born with an
owner.

### Permissions

Three levels, weakest to strongest, compared through `PERMISSION_RANK`:

| Level | Can |
| --- | --- |
| `view` | open and export |
| `edit` | everything `view` does + move, edit, save a version, autosave, attach |
| `full` | everything `edit` does + share, change other people's permission and delete |

The owner always has `full`. `access.permission_for()` resolves the level by
adding up three sources — owner, a `flow_shares` row for the signed-in account,
and the link token sent in the `X-Share-Token` header — and **keeps the
strongest**, so handing a view link to someone who could already edit does not
demote them.

Whoever cannot reach a flow gets **404, not 403**: answering "it exists, but is
not yours" would hand the existence of other people's flows to anyone sweeping
slugs.

**A draft is not a version** — that is the central decision. The editor
autosaves into `flows.draft_graph` after 3 s of inactivity; only "Save version"
(Ctrl+S) inserts into `flow_versions`. Without that separation the autosave
would produce hundreds of useless versions. On opening a flow, the draft comes
back if there is one — and the `graph_source` field in the response says where
the graph came from.

## Conventions

- **Everything is in English.** UI labels and copy, status and error messages,
  code identifiers (functions, variables, components, tables, columns),
  comments, API routes and fields, file names, commit messages, infrastructure
  names (containers, network, volumes, database, schema, environment variables)
  and the documentation, this file included. Do not make an exception for "just
  one label" or "just one helper".
- The project used to be half Portuguese: the flow routes were `/api/fluxos`,
  the identifiers were `gravarVersao` / `montar_detalhe`, the database was
  `fluxos` in the `fluxo` schema, the containers were `fluxo-*` and the subpath
  was `/editor-fluxo/`. That conversion is **done**, API routes and identifiers
  included. If you find a Portuguese identifier anywhere, it is a leftover —
  rename it.
- The **payload fields have always been in English** (`nodes`, `edges`, `label`,
  `metadata`) and stay that way — it is the contract already published.
- CSS: a flat `fe-` prefix (`fe-node-head`, `fe-item-main`) and colours
  **always** through the tokens in `src/flow/theme.css` (`--card`, `--txt`,
  `--edge1`), never literals — the light/dark theme depends on it.
- The backend: FastAPI, typed SQLAlchemy 2.0, `psycopg`, `pydantic-settings`,
  a dedicated Postgres schema and an idempotent migration of its own
  (`app/migrations.py`) instead of Alembic.
- Zero new frontend dependencies: the native `fetch`, no axios, no state
  library, no UI framework.

## Map: where to go to…

| Goal | File |
| --- | --- |
| add a **built-in** tool to the catalog | `src/flow/constants.js` (`TOOLS`) |
| touch the user's tool registration or editing | `src/flow/ToolModal.jsx` (one form, `mode` create/edit) + `src/flow/toolIcon.js` + `backend/app/routers/tools.py` |
| touch the history dropdown | `src/flow/HistoryMenu.jsx` (anchored on the document name, in `Header.jsx`) |
| touch the sidebar (collapse, resize) | `src/flow/Sidebar.jsx` + `sidebarWidth`/`boxOpen` in `useFlowEditor.js` |
| change the plane's interactions (pan, zoom, drag, arrows) | `src/flow/useFlowEditor.js` |
| change saving/opening/versions on the client | `src/flow/useFlowEditor.js` (the "Server persistence" block) + `src/flow/api.js` |
| change the serialised format | `src/flow/payload.js` **and** `backend/app/schemas.py` (they move together) |
| add an endpoint | `backend/app/routers/` + register it in `app/main.py` |
| change the database schema | `backend/app/models.py` + an idempotent `ALTER` in `app/migrations.py` |
| change the automatic layout | `src/flow/organize.js` |
| touch the group boxes (create, move, resize, colour) | `src/flow/Group.jsx` + the "Groups" block of `useFlowEditor.js`; the membership rule is `reconcileGroups()` in `src/flow/geometry.js` |
| reset someone's password (there is no "forgot my password") | `docs/BACKEND.md` §8.1 |
| touch sign-in, sign-up or sessions | `backend/app/routers/auth.py` + `app/access.py` + `app/security.py` · client in `src/app/useSession.js` and `src/app/AuthScreen.jsx` |
| touch sharing and permissions | `backend/app/routers/sharing.py` + `app/access.py` · client in `src/flow/ShareMenu.jsx` and the "Sharing" block of `useFlowEditor.js` |
| touch the homepage | `src/app/Home.jsx` (the list comes from `GET /api/flows?limit=`) |
| touch the SPA's routes | `src/app/route.js` + `src/App.jsx` |
| touch email sending | `backend/app/mailer.py` + the compose file's `SMTP_*` variables |
| touch undo/redo (Ctrl+Z / Ctrl+Y) | `src/flow/useFlowEditor.js` (the "Undo / redo" block) |
| change the PNG export | `src/flow/exportPng.js` (`renderFlowCanvas` is shared by download and upload) |
| touch the MCP server | `backend/mcp/` — `toolset.py` (tools), `graph.py` (spec → payload), its own `README.md` |
| change size/resource ceilings | `backend/app/config.py` + `docker-compose.yml` |
| change the published subpath | nothing in the code: `FLOW_BASE` in `.env`, then `docker compose up -d --build frontend` (it feeds `VITE_BASE` and `docker/frontend-nginx.conf.template`) |
| touch who may sign up | `registration` in `backend/app/config.py`, `register` in `routers/auth.py` · client in `src/app/AuthScreen.jsx` |
| change the lineOS mark or name | `src/app/Brand.jsx` (every header uses it) |

### Groups

A group is a box drawn **behind** the nodes (first child of `.fe-layer`, so it
needs no `z-index`) and it keeps **no list of members**. A node belongs to the
box whose rectangle contains its **centre**, and `reconcileGroups()` re-answers
that for every node on each `onMove` — which is why dragging a node out of the
box leaves the group, and dropping one inside joins it, with nothing to update
by hand. `node.g` (`group` in the JSON) is only a cache of that answer, so it
survives a reload without re-measuring every card.

Two consequences worth knowing before changing anything there:

- membership is settled **during** the drag, not on `mouseup`, on purpose: it
  keeps the whole gesture inside one `live:` history step (a change committed at
  the release would become a second Ctrl+Z step);
- moving a box translates the nodes captured when the drag STARTED (`gdrag.mates`,
  with their offsets), so the content keeps its arrangement instead of being
  re-laid out. Anything that changes what "inside" means has to go through
  `reconcileGroups`, never through a members array.

## Real traps in this code

1. **The `y` axis is inverted only on serialisation.** In memory `y` grows
   downwards (a screen coordinate); in the payload it grows upwards.
   `flowPayload` negates, `flowFromPayload`/`nodeFromPayload` un-negate. The API
   does **not** reinterpret the sign — it stores what it received. Losing that
   inversion mirrors the diagram.
2. **Node ids and edge ids are local to the document** and generated by
   `nextId = max(id) + 1` **separately** for each collection — node 1 and edge 1
   coexist. Do not treat them as global keys and do not renumber them on load:
   the arrows point through them.
3. **The reducer is a *shallow merge*** (`{...state, ...patch}`), so `setState`
   behaves like a class `setState`. And **do not dispatch functions**: the local
   `setState` resolves function patches *before* the dispatch on purpose —
   handing the function to the reducer caused a runaway re-render loop (see the
   comment in `useFlowEditor.js`).
4. **After an `await`, `state` is stale.** Async handlers read `docRef.current` /
   `libRef.current` / `versionsRef.current`, which carry the freshly committed
   value. When writing a new async action, follow that pattern.
5. **`desc: null` hides the description block; `desc: ''` shows it empty.** The
   same goes for an arrow's `label`. `flowPayload` collapses `''` into `null`,
   so a round trip **closes** a block that was open and empty — inherited
   behaviour, preserved on purpose.
6. **`metadata` travels as a JSON object**, so row order holds in practice but
   **duplicate keys collapse** and rows with an empty key are dropped on
   serialisation. The database does not fix that: it stores what the client
   sent.
7. **The key order inside each object is normalised by `jsonb`.** The *values*
   come back identical; the textual order does not. It is irrelevant to the
   client (which reads by key) and it is the price of the GIN index.
8. **`pristineRef`** exists so that loading a document from the server does not
   mark the editor as "changed". When creating a new path that replaces
   `nodes`/`edges` wholesale, use `applyDocument` — it takes care of that.
9. **Saving with a stale `base_version` answers 409, on purpose.** Two tabs on
   the same flow do not overwrite each other in silence; the user decides
   between reopening and "Save as new".
10. **The SPA's subpath is fixed at build time**, because Vite rewrites the asset
    URLs. `src/flow/api.js` derives the API base from
    `import.meta.env.BASE_URL`, so the same code serves at the root and under
    a subpath — do not go back to a hard-coded `'/api'`.
11. **`node.tool` is an icon reference, not an identity.** Dropping a registered
    tool on the plane *copies* name, category, initials and colour into the
    node; `tool` keeps only the slug, and only the icon is resolved through it at
    draw time (`iconBySlug`). That is why deleting a tool from the catalog
    changes **no** graph: the node goes back to showing its initials. Do not
    start reading name or colour from the catalog.
12. **A tool icon is a 64×64 PNG data URL**, downscaled in the browser by
    `toolIcon.js` before upload. The backend refuses SVG on purpose (it is
    markup rendered into the page) and cuts anything above
    `settings.max_tool_icon_bytes`. Raise one and you raise the other.
13. **The history has no panel of its own any more**: it is the dropdown in
    `HistoryMenu.jsx`, opened from the document name. It closes on an outside
    click (a listener on `document`), so any new trigger in the header needs
    `stopPropagation` on `mousedown`, as the `.fe-doc` button does.
14. **The metadata panel hangs BELOW the card** (`.fe-meta-drop`, absolute), not
    inside it. That is why `nodeHeight` does not count the metadata rows: the
    height measured in the DOM is the card's alone, and it is what decides where
    the arrows stop. Whoever needs the space the panel occupies — the PNG
    framing and the automatic layout — adds `metaPanelHeight(n)`. Changing the
    row height means changing `META_*` in `constants.js` **and** `.fe-meta-drop`
    in the CSS together, or the PNG stops matching the screen.
15. **Undo/redo records by effect, not by action.** An effect on `nodes`/`edges`
    pushes the previous state, so no new path has to remember anything. In
    exchange, a continuous action has to **label** itself (`tagHistory`): a drag
    uses `live:*` (grouping until the `mouseup`, which calls `endHistoryStroke`)
    and typing uses `text:*` (grouping by 1.5 s). Without a label, one Ctrl+Z
    would undo a pixel of a drag or a single letter. The stacks live in
    `histRef` — outside the state, so they do not re-render — and only the
    `{canUndo, canRedo}` pair reaches `state`.
16. **Permission belongs to the server; the client merely avoids offering what
    would be refused.** The guards in `useFlowEditor` (`readOnly()`) exist so the
    user does not edit and lose the work on save — they are not security. Every
    write route goes through `Depends(access.RequireFlow("edit"))` or `"full"`.
    When creating a new flow route, **use the dependency**: without it the route
    is open to any account.
17. **Session tokens and link tokens are never stored in the clear** — the
    database keeps the sha256 (`security.token_hash`). A link token comes back
    **exactly once**, in the creation response; that is why the editor copies it
    to the clipboard right away. Losing it means creating another.
18. **A link is a hash route** (`#/share/<token>`), not a path. nginx serves
    only `index.html`, possibly under a subpath: with a path, a shared link
    would depend on proxy configuration. See `src/app/route.js`.
19. **`FlowListItem` carries owner and permission fields** (`owner_id`,
    `owner_name`, `permission`, `is_owner`, `shared_count`). The default for
    `permission` is `"full"`, for the internal calls that already went through
    the access dependency — do not rely on that default in a new path, pass the
    user to `service.build_item`.
20. **Without SMTP, "Send by email" answers 200 with `sent: false`**, not an
    error: the body carries `url` and a ready `mailto:`, and the editor opens the
    user's own mail client. A link **is created either way** — the server does
    not know whether the message went out.

## What not to touch

- **`design/`** — the prototype exported from Claude Design (`Editor de
  Fluxo.dc.html`, `support.js`, the conversation transcript, `HANDOFF.md`). It is
  a visual reference, it does not enter the build and it must not be edited by
  hand. Its file names are the ones the export produced, in Portuguese; leave
  them as they are.
- **`flow_versions`** — never `UPDATE` or `DELETE` in that table. Restoring an
  old state means *inserting* a new version holding the old content
  (`POST /api/flows/{id}/versions/{n}/restore`).
- **`.env`** — it holds the Postgres password and the bind IP, and it is in
  `.gitignore`. Instance data (real hosts, real fixtures, secrets, runbooks for
  one deployment) never enters this repository.

## Tests

```bash
# a disposable database, on the stack's Postgres (or any Postgres 17)
docker compose exec postgres psql -U lineos -d lineos -c "CREATE DATABASE flows_test"

pip install -r backend/requirements-dev.txt
cd backend && DATABASE_URL_TEST="postgresql+psycopg://lineos:PASSWORD@127.0.0.1:5433/flows_test" pytest -q
npm test          # the frontend's unit tests (Vitest), from the root
```

CI (`.github/workflows/ci.yml`) runs both suites, the build, the MCP
self-test, `docker compose up` on a clean runner and a secret scan on every
push.

The backend tests cover the payload round trip (the node's nickname and size included,
and the group boxes), the validation rules, versioning, the 409 on concurrency,
drafts, the trash, attachments, the tool catalog and its delete rule
(`test_tools.py`) and accounts,
permissions and sharing (`test_accounts.py`). They need a real Postgres (the schema uses `jsonb`
and a GIN index) and skip themselves without `DATABASE_URL_TEST`.

The MCP server has a check of its own, which drives the process over stdio the
way a client would: `python3 backend/mcp/selftest.py`. The protocol half runs
anywhere; the round-trip half **writes for real** and refuses to point at the
production API — see `backend/mcp/README.md`.

The end-to-end suite in `e2e/` (Playwright) covers sign-up, sharing and the
password change through the interface. It is not wired into CI yet, and it
writes for real: run it against the disposable API from `e2e/README.md`.

Beyond the unit tests of `src/ops/`, the frontend has no test suite. Before
considering a change done:
`npm run build` and a manual round trip — create nodes with a description,
metadata and a labelled arrow, Ctrl+S, reload the page and reopen from the
library.
