# Flow Editor backend — decisions and operation

Documents how the persistence layer was built: what was decided, what was
discarded and why, how the schema and the API behave, and how to operate the
stack. For the project's general context, see [`../AGENT.md`](../AGENT.md).

## 1. The problem

The editor kept everything in memory, in a single `useReducer`. Reloading the
page threw the work away and went back to the `INITIAL_NODES` seed. The only
persistence was manual: download `flow.json`/`flow.png`, or copy JSON to the
clipboard. The README itself recorded the gap and pointed at the extension
point: *"A backend can be plugged in later at `payload.js` /
`useFlowEditor.js`."*

## 2. Agreed requirements

| Decision | Choice | Consequence |
| --- | --- | --- |
| Authentication | none at first | the API only on `127.0.0.1`; `flow_versions.author` a free label, not an identity |
| History | immutable versions | an INSERT/SELECT-only table; restoring = inserting a copy |
| Running it | Postgres + API in Docker; frontend on Vite | an `/api` proxy in the dev server, no CORS |
| Files | the flows' JSON **and** attachments/PNG | the `flow_files` volume + the `flow_assets` table |

## 3. Design decisions

### 3.1 The graph is `jsonb`, not node/edge tables

**Discarded:** normalising into relational `nodes` and `edges`.

**Why:** (a) the `flow-graph` payload was already the documented public
contract, and storing it whole makes the round trip trivially correct; (b)
versions are immutable snapshots — normalising would duplicate, in every
version, `id`s that are local to the document, with no query gain whatsoever;
(c) the editor always loads and saves the whole graph, never a single node.

**Price accepted:** the textual key order inside each object is normalised by
`jsonb` (the values come back identical). In exchange comes the
`GIN (graph jsonb_path_ops)` index, which answers queries like:

```sql
SELECT DISTINCT flow_id FROM flow.flow_versions
WHERE graph @> '{"nodes":[{"name":"Kafka"}]}';
```

If a report by tool or by metadata is ever needed, the way out is a materialised
*view* derived from the `jsonb` — not decomposing the source of truth.

### 3.2 The draft is separate from the version

**Discarded:** having every save (including the automatic one) create a version.

That would turn the history into noise: dozens of versions per working session.
The opposite was discarded too — manual saving only — which loses the work of
anyone who closes the tab.

**Adopted:** two routes with distinct semantics.

- `PUT /api/flows/{id}/draft` overwrites `flows.draft_graph`. It is what the
  editor calls, debounced by 3 s. It creates no version.
- `PUT /api/flows/{id}/versions` inserts into `flow_versions` and **clears the
  draft**, which has become redundant.

On opening a flow, `GET /api/flows/{id}` returns the draft when there is one,
and reports where the graph came from in `graph_source` (`"draft"` or
`"version"`) — the editor uses that for the status bar.

### 3.3 Optimistic locking instead of a lock

`PUT .../versions` requires `base_version`. If it does not match
`flows.current_version`, the answer is **409**, carrying the server's version.
Two tabs open on the same flow do not overwrite each other in silence.

The numbering is serialised with `SELECT … FOR UPDATE` over the `flows` row
(`app/service.py`, `create_version`), which keeps two simultaneous saves from
being handed the same number — `UNIQUE (flow_id, version)` is the safety net.

### 3.4 No Alembic

The project has one table per thing and a brand-new schema. Alembic would add a
migrations directory, an extra command in the deploy and a state to version, to
solve a problem that does not exist yet. We adopted the same mechanism as the
sibling project `~/VistoPro`: `Base.metadata.create_all` at startup (creates
missing tables only) followed by `app/migrations.py`, a list of idempotent
statements (`IF EXISTS` / `IF NOT EXISTS`) for changes to already populated
tables. **Every column/constraint change goes there.** Once the list passes a
couple of dozen statements, it is time to swap it for Alembic.

### 3.5 Content-addressed attachments

`flow_assets` keeps metadata; the content goes to the volume as
`<sha256[0:2]>/<sha256[2:4]>/<sha256>.<ext>` (`app/storage.py`). The two-level
fanout keeps directories from holding thousands of entries, and hash addressing
deduplicates identical uploads. Writing to a temporary file plus a `rename`
means an interrupted upload never leaves truncated content under a valid sha256.
Deletion only removes the file when no row references it any more
(`storage.remove_if_orphan`).

### 3.6 Soft delete

`DELETE /api/flows/{id}` marks `deleted_at` (the trash, listable with
`?trashed=true`, reversible through `POST .../restore`).
`DELETE /api/flows/{id}?purge=true` really deletes, cascading into versions and
attachments and cleaning the volume. An editor with no `Ctrl+Z` for deletion
should not erase history on a single click.

## 4. Schema (`flow` in the `flows` database)

```
flows                                     flow_versions  (immutable)
  id            BIGSERIAL PK                id          BIGSERIAL PK
  slug          TEXT UNIQUE                 flow_id     BIGINT FK -> flows CASCADE
  name          TEXT                        version     INT
  description   TEXT NULL                   graph       JSONB    ← flow-graph payload
  current_version INT                       node_count  INT
  draft_graph   JSONB NULL   ← autosave     edge_count  INT
  draft_updated_at TIMESTAMPTZ NULL         note        TEXT NULL
  created_at    TIMESTAMPTZ                 author      TEXT NULL
  updated_at    TIMESTAMPTZ                 created_at  TIMESTAMPTZ
  deleted_at    TIMESTAMPTZ NULL ← trash    UNIQUE (flow_id, version)

flow_assets
  id BIGSERIAL PK · flow_id FK CASCADE · flow_version INT NULL
  kind TEXT CHECK IN ('png','attachment') · filename · content_type
  size_bytes INT · sha256 TEXT · storage_path TEXT · created_at

custom_tools   (catalog, not content — no FK to flows)
  id BIGSERIAL PK · slug TEXT UNIQUE · name · category · initials · color
  tags TEXT · icon TEXT NULL  ← a 64×64 PNG as a data URL
  created_at · updated_at

users                                     user_sessions
  id            BIGSERIAL PK                id          BIGSERIAL PK
  email         TEXT UNIQUE ← lowercased    user_id     BIGINT FK -> users CASCADE
  name          TEXT                        token_hash  TEXT UNIQUE ← sha256 of the cookie
  password_hash TEXT ← pbkdf2_sha256$…      expires_at  TIMESTAMPTZ
  created_at · last_login_at                created_at · last_seen_at

flow_shares                               flow_share_links
  id BIGSERIAL PK                           id BIGSERIAL PK
  flow_id FK -> flows CASCADE               flow_id FK -> flows CASCADE
  user_id FK -> users CASCADE               token_hash TEXT UNIQUE ← sha256 of the link
  permission TEXT CHECK view|edit|full      permission TEXT CHECK view|edit|full
  created_by FK -> users SET NULL           label TEXT NULL · created_by FK SET NULL
  created_at                                created_at · expires_at NULL · revoked BOOL
  UNIQUE (flow_id, user_id)

flows.owner_id  BIGINT FK -> users SET NULL   ← nullable only because of the legacy
```

Indexes: `flows_slug_key`, `ix_flows_deleted_at`, `ix_flow_versions_flow_id`,
`uq_flow_versions_flow_version`, `ix_flow_versions_graph` (GIN),
`ix_flow_assets_flow_id`, `ix_flow_assets_sha256`, `custom_tools_slug_key`,
`ix_custom_tools_name`, `uq_custom_tools_builtin`.

### 4.1 Accounts, permissions and the ownerless legacy

`flows.owner_id` arrived after the flows did. The migration
(`ALTER TABLE flows ADD COLUMN IF NOT EXISTS owner_id`, in `migrations.py`)
creates it nullable, and the **first registration adopts the orphans**
(`access.adopt_orphan_flows`) — without it, everything that existed before
accounts would be unreachable. Later registrations find nothing to adopt.

Three permission levels, compared through `PERMISSION_RANK` in `models.py`:

| Level | Can |
| --- | --- |
| `view` | open, list versions, export |
| `edit` | + move, edit, save a version, autosave, attach, restore a version |
| `full` | + share, change other people's permission, delete the flow |

`access.permission_for()` resolves the level from three sources — being the
owner, having a `flow_shares` row, and the link token in the `X-Share-Token`
header — and keeps the **strongest**. Every flow route goes through
`Depends(access.RequireFlow("<level>"))`, which answers **404** (not 403) when
there is no access at all: saying "it exists, but is not yours" would leak the
existence of other people's flows.

Passwords: PBKDF2-HMAC-SHA256 from the standard library, 210k iterations, with
the cost embedded in the hash itself (`security.py`) — no new dependency, and
raising the cost later does not invalidate an old hash. Sessions and links store
only the sha256 of the token: a database dump hands over neither a live session
nor a valid link.

### 4.2 `custom_tools` is a catalog, not content

A user-registered tool exists so the sidebar is not a dead end when a tool is
missing. Dropping one on the plane **copies** name, category, initials and
colour into the node; only the icon is still resolved live, through the node's
`tool` field (the slug). The intended consequence: editing or deleting a tool
**never** rewrites a stored graph — the node simply goes back to showing its
initials.

**Built-in tools live in the frontend source** (`TOOLS`, in
`src/flow/constants.js`), so the server has no copy of that list. Editing one
materialises it as a `custom_tools` row tagged with `builtin` (the built-in's
name): the sidebar then drops the source entry and serves the row. `hidden` is
the same mechanism used to take a built-in OUT of the catalog — deleting its row
would only put the source entry back, so a `DELETE` on a row carrying `builtin`
sets `hidden` instead of removing it. To bring one back:

```sql
DELETE FROM flow.custom_tools WHERE builtin = 'Airflow';
```

**A tool is only removed while no diagram uses it.** `GET /api/tools/usage`
answers where it is used, and both the `DELETE` and the "register it hidden"
call refuse with `409` otherwise. What is scanned is the **current** content of
every flow, trashed ones included (`draft_graph`, or the last version when there
is no draft) — not older versions, which are immutable history that degrades
gracefully. A node points at its tool in one of two ways, and both are matched:
a registered tool leaves its `slug` in `tool`, while a node made from a built-in
has `tool: null` and carries the tool's name in `name`.

The icon travels inline as a data URL instead of becoming a `flow_assets` row
because it is tiny (the browser downscales it to a 64×64 PNG before sending) and
because `flow_assets` is tied to a flow, and a tool belongs to no flow. The
ceiling is `settings.max_tool_icon_bytes` (192 KB).

## 5. Endpoints

| Method | Route | Action |
| --- | --- | --- |
| GET | `/api/health` | liveness + a ping on Postgres (used by the healthcheck) |
| POST | `/api/auth/register` | creates an account and opens a session (an `httpOnly` cookie) |
| POST | `/api/auth/login` | opens a session; an identical 401 for a missing account and a wrong password |
| POST | `/api/auth/logout` | deletes the session and the cookie |
| GET | `/api/auth/me` | who is signed in (200 with `user: null` when nobody is) + `smtp_ready` |
| POST | `/api/auth/password` | changes one's own password (needs the current one); drops every other session |
| GET | `/api/users?q=` | finds an account to share with (≥3 letters, ≤10 results, needs a session) |
| GET | `/api/shares/open/{token}` | resolves a received link: which flow, at what permission |
| GET | `/api/shares/{id}` | the sharing state of one flow (needs `full`) |
| POST | `/api/shares/{id}/users` | shares with an account; re-sharing updates the level |
| PATCH/DELETE | `/api/shares/{id}/users/{share_id}` | changes the level / revokes access |
| POST | `/api/shares/{id}/links` | creates a link; **the token comes back only here** |
| DELETE | `/api/shares/{id}/links/{link_id}` | revokes it (marks `revoked`, does not delete the row) |
| POST | `/api/shares/{id}/email` | creates a link and sends it; with no SMTP, 200 with `sent:false` + `mailto` |
| GET | `/api/flows?q=&trashed=&limit=` | this account's flows (its own + shared); `limit` feeds the home |
| POST | `/api/flows` | creates the flow **and** version 1 |
| GET | `/api/flows/{id\|slug}` | metadata + the graph to open + `graph_source` |
| PATCH | `/api/flows/{id}` | renames/redescribes (creates no version; regenerates the slug) |
| PUT | `/api/flows/{id}/draft` | autosave |
| DELETE | `/api/flows/{id}[?purge=true]` | trash / permanent removal |
| POST | `/api/flows/{id}/restore` | takes it out of the trash |
| GET | `/api/flows/{id}/versions` | the history without the graphs |
| PUT | `/api/flows/{id}/versions` | saves a version (requires `base_version`) |
| GET | `/api/flows/{id}/versions/{n}` | one version's graph |
| POST | `/api/flows/{id}/versions/{n}/restore` | creates a new version holding `n`'s content |
| GET | `/api/flows/{id}/export[?version=]` | downloads the JSON with `Content-Disposition` |
| GET/POST | `/api/flows/{id}/files` | lists / uploads an attachment (multipart) |
| GET/DELETE | `/api/files/{asset_id}` | download / removal |
| GET | `/api/tools?q=` | the registered tool catalog, newest first |
| POST | `/api/tools` | registers one (slug and initials derived from the name when missing) |
| PATCH | `/api/tools/{id}` | edits; `icon: ""` clears the image, omitting it keeps it |
| GET | `/api/tools/usage?slug=&name=` | which diagrams hold a node made from this tool (works for a built-in, which has no id) |
| DELETE | `/api/tools/{id}` | removes it from the catalog — `409` while any diagram uses it; a row standing for a built-in is hidden rather than deleted. Nodes already created stay intact |

Every flow route requires a session, **except** when the request carries a valid
link token in the `X-Share-Token` header (or `?share=`) — that is what makes a
shared link work for someone with no account.

Interactive documentation at `http://localhost:8010/api/docs`.

## 6. Validation

`app/schemas.py` translates the format of `src/flow/payload.js` into Pydantic,
with the fields declared **in the same order** the frontend emits them. Refusals
with 422:

- a `kind` other than `flow-graph`, or a `version` other than `1`;
- a repeated node/edge `id`, or `id <= 0`;
- a `color` outside `^#[0-9a-fA-F]{3,8}$`;
- an empty `name`/`category`/`initials`, or an empty `label` (use `null` for "no
  nickname"; `name` always holds the technical stack name);
- a `width` outside 168–720 or a `height` outside 120–900 (the node's manual
  size; `null` returns the node to the default);
- an edge pointing at a node that does not exist, an edge from a node to itself,
  or a duplicate `(from, to)` pair — the same rule the editor applies when
  creating edges;
- a repeated group `id`, a group `width` outside 160–6000 or `height` outside
  120–6000, or a node whose `group` points at a box that does not exist
  (`groups` itself is optional: a flow saved before the feature has none);
- an unknown field in any object (`extra="forbid"`), which keeps a format
  mismatch from passing silently;
- above the ceilings: 500 nodes, 2000 edges, 200 groups, 60 metadata pairs per
  node;
- a tool icon that is not a PNG/JPEG/WebP data URL, or one above 192 KB. SVG is
  refused on purpose: it is markup, and the icon is rendered straight into the
  page.

A body above 2 MB is cut off with **413** by a middleware in `app/main.py`,
before it is read into memory. Attachments above 10 MB and types outside the
list (`png`, `jpeg`, `svg`, `json`, `pdf`, `txt`) are refused too.

`from` is a Python keyword, so `EdgePayload` uses `Field(alias="from")` with
`populate_by_name=True`.

## 7. Resources, and why these numbers

The host has **2 vCPUs, ~7 GiB of free RAM** and more than ten containers from
other projects running. The ceilings exist so this project does not get in their
way.

| Service | CPU | Memory | Rationale |
| --- | --- | --- | --- |
| `flow-postgres` | 0.60 | 512 MB (256 MB reserved) | `shared_buffers=128MB` + up to 50 connections × `work_mem=4MB` + overhead fit with room to spare |
| `flow-api` | 0.60 | 384 MB (128 MB reserved) | 1 uvicorn worker + a 5+5 connection pool; the 2 MB body limit prevents spikes |

Together, 1.2 of 2 CPUs — about 40% is left for the rest of the machine.
`shm_size: 128m` on Postgres avoids intermittent shared-memory errors in Docker
(the 64 MB default is tight). Parallelism is off
(`max_parallel_workers_per_gather=0`): with 0.60 CPU, a parallel worker only
competes with itself.

`deploy.resources.limits` is applied by Docker Compose v2+ outside Swarm. To
confirm:

```bash
docker inspect flow-postgres flow-api \
  --format '{{.Name}} NanoCpus={{.HostConfig.NanoCpus}} Memory={{.HostConfig.Memory}}'
docker stats --no-stream flow-postgres flow-api
```

**When you touch one, touch the other:** raising `shared_buffers` or
`max_connections` without raising `memory` gets Postgres killed by the OOM
killer; raising uvicorn's `--workers` without raising CPU and memory only
increases latency.

## 8. Operating

```bash
docker compose up -d --build      # bring it up
docker compose ps                 # healthchecks
docker compose logs -f api        # logs
docker compose down               # stop (volumes kept)
docker compose down -v            # stop and DELETE the data
```

Backing up the database and the attachments:

```bash
docker exec flow-postgres pg_dump -U flow -d flows -n flow -Fc > flows.dump
docker run --rm -v flow_files:/d -v "$PWD:/b" alpine tar czf /b/files.tgz -C /d .
```

Useful queries:

```sql
-- flows with a pending draft
SELECT name, current_version, draft_updated_at FROM flow.flows
WHERE draft_graph IS NOT NULL AND deleted_at IS NULL;

-- how the history is growing
SELECT f.name, count(*) AS versions, pg_size_pretty(sum(pg_column_size(v.graph))) AS bytes
FROM flow.flows f JOIN flow.flow_versions v ON v.flow_id = f.id
GROUP BY f.name ORDER BY versions DESC;
```

### 8.1 Resetting an account's password (operator)

There is no "forgot my password": whoever loses their password depends on
whoever runs the server. The command below swaps the hash and **closes that
account's sessions**; after signing in, the person changes the password through
the interface (account menu → *Change password*), which is the normal path.

```bash
docker exec -e TARGET=someone@example.com -e NEW='temporary-password' flow-api python -c "
import os
from sqlalchemy import select
from app.database import SessionLocal
from app.models import User, UserSession
from app.security import hash_password

target = os.environ['TARGET'].strip().lower()
with SessionLocal() as db:
    u = db.execute(select(User).where(User.email == target)).scalar_one_or_none()
    if u is None:
        raise SystemExit('account not found: ' + target)
    u.password_hash = hash_password(os.environ['NEW'])
    n = db.query(UserSession).filter(UserSession.user_id == u.id).delete()
    db.commit()
    print(f'password reset for {u.email} (id={u.id}); {n} session(s) closed')
"
```

Diagnosis before resetting — the nginx log says whether the problem is a
credential (`401`), an account that already exists (`409` on sign-up) or too many
attempts (`429`):

```bash
sudo grep auth /var/log/nginx/access.log | tail -20
```

## 9. Tests

74 tests cover, in `backend/tests/test_flows.py`, the payload round trip, the
validation rules, versioning, the 409, drafts, listing/search, the trash, export
and attachments (deduplication included); in `test_tools.py`, the tool catalog;
and in `test_accounts.py`, sign-up, sign-in, ownership, the three permission
levels, links (revoked ones and the "never demotes someone who already edits"
rule included), the email fallback and the password change (wrong current
password, short password, dropping the other sessions).

Since the whole API came to require an account, the `client` fixture in
`conftest.py` already registers and signs a user in; `anonymous_client` is the
client with no session.

They need a real Postgres — the schema uses `jsonb` and a GIN index, which
SQLite does not have — and skip themselves without `DATABASE_URL_TEST`. They run
in a schema of their own (`flow_test`), recreated at the start of the session:

```bash
docker exec flow-postgres psql -U flow -d postgres \
  -c "CREATE DATABASE flows_test OWNER flow"

docker run --rm --network flow-net -v "$PWD/backend:/app:ro" -w /app \
  -e DATABASE_URL_TEST="postgresql+psycopg://flow:$(grep FLOW_DB_PASSWORD .env | cut -d= -f2)@postgres:5432/flows_test" \
  --entrypoint bash flow-editor-api \
  -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
```

## 10. Troubleshooting

| Symptom | Likely cause | Way out |
| --- | --- | --- |
| `port is already allocated` on startup | 5433 or 8010 taken by another service | change the **host** port in the compose file and the proxy `target` in `vite.config.js` |
| the frontend gets 404 on `/api/...` | Vite started before the proxy existed | restart `npm run dev` |
| `server unavailable` in the status bar | the containers are stopped | `docker compose ps` and `docker compose up -d` |
| 409 on save | another tab saved first | reopen the flow, or use "Save as new" |
| 413 on save | a graph above 2 MB | shrink the flow, or raise `max_graph_bytes` **and** the API's memory |
| Postgres complains about shared memory | not enough `shm_size` | it is already 128 MB; raise it together with `memory` |
| `410` when downloading an attachment | the volume was recreated without the database | restore `flow_files` from the backup, or delete the orphaned metadata |
| 401 on everything after an update | the API came to require an account | sign up on the first screen; the first registration adopts the flows that had no owner |
| the sign-in "disappears" on reload | `SESSION_COOKIE_SECURE=true` without HTTPS | the browser drops the cookie; go back to `false` while the proxy serves HTTP |
| "email sending is not configured" | no `SMTP_HOST` | expected — the editor opens the local mail client; fill in the `FLOW_SMTP_*` variables to send from the server |
| the API starts but `/api/health` fails | `FLOW_DB_PASSWORD` changed after the first boot | the volume's password is the one from the first boot; `docker compose down -v` recreates it (deletes data) |

## 11. What was left out

- ~~**Authentication**~~ — done: accounts (`users`), a session in an `httpOnly`
  cookie (`user_sessions`), `flows.owner_id`, sharing at three levels (§4.1),
  self-service password change and a rate limit on the credential routes (in
  nginx — see [`DEPLOY.md`](DEPLOY.md)). Still out: **"forgot my password"**
  (with no SMTP there is nowhere to send the link; the way out is the operator
  reset, §8.1) and **email verification on sign-up**.
- ~~**The frontend in the compose file**~~ — done: the `frontend` service serves
  the SPA under `/flow-editor/` and is published on the nginx-proxy-manager. See
  [`DEPLOY.md`](DEPLOY.md).
- **Alembic** — see §3.4.
- **Automatic purging of old versions** — nothing is deleted today. If the
  history grows too much, a retention routine (keep the last N and one per day)
  would go in as a job in `lifespan`, like the daily closing in `~/VistoPro`.
- **A frontend test suite** — there is only the end-to-end coverage of accounts,
  sharing and the password change in `e2e/` (Playwright, through the shared
  `~/tools/browser-test` environment); the rest of the verification is
  `npm run build` plus a manual round trip in the editor.
