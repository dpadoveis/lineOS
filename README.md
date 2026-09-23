# lineOS

Design, build and monitor data pipelines in one place: draw the pipeline, hand
the design to an AI to build it, and watch the lineage and health of what was
built.

> **Early.** lineOS runs on any machine with Docker (stage 0 of
> [`docs/ROADMAP.md`](docs/ROADMAP.md)); ingestion from any environment, the
> buildable node contract and the AI build handoff are the stages ahead.

## Quick start

```bash
git clone https://github.com/dpadoveis/lineOS && cd lineOS
cp .env.example .env    # set FLOW_DB_PASSWORD
docker compose up -d
```

Open <http://localhost:8020> and create the admin account. Settings, a reverse
proxy, a subpath and the Data Lineage sources are in
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Credits

lineOS started from the **Flow Editor** by **David** ([@uD4V1D](https://github.com/uD4V1D)),
who built the diagram editor, accounts, sharing, version history and the MCP
server this project stands on. The Data Lineage module was added on top of it by
Diogo Padoveis ([@dpadoveis](https://github.com/dpadoveis)).

## License

[MIT](LICENSE).

---

## The Flow Editor

A visual flow editor on a cartesian plane — drag tools from a search box onto
the plane, connect them with directed arrows, store them on the server with a
version history, and export the result as PNG or JSON.

Frontend in React + Vite (from the prototype created in Claude Design, kept in
[`design/`](design/)) and backend in Python (FastAPI) with a Postgres of its own
in a container.

## Developing

Backend (Postgres + API in Docker):

```bash
cp .env.example .env          # set FLOW_DB_PASSWORD
docker compose up -d --build  # postgres :5433 · api :8010 · frontend :8020
curl localhost:8010/api/health
```

Frontend with hot reload (Vite; it reaches the API through the `/api` proxy):

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # unit tests (Vitest)
npm run build    # production bundle in dist/
npm run preview  # serves the build
```

Backend tests need a Postgres: see *Tests* in [`AGENT.md`](AGENT.md). CI runs
everything on each push. End-to-end coverage of accounts and sharing
(Playwright) **really registers and really saves**, so it runs against a
disposable API — the steps are in [`e2e/README.md`](e2e/README.md).

**The application opens on the sign-in screen**: diagrams belong to accounts.
On a server with no account yet it opens on **Set up lineOS**, and the account
created there is the admin (it also adopts any flow created before accounts
existed). Who may sign up after that is `FLOW_REGISTRATION` — `invite` by
default: a share link is the invitation.

Deployment is in [`docs/DEPLOY.md`](docs/DEPLOY.md). Details of the API, the schema and the
resource limits are in [`docs/BACKEND.md`](docs/BACKEND.md); the project's
general context is in [`AGENT.md`](AGENT.md).

## Features

### Accounts and sharing

- **Sign-up and sign-in** (email + password). The first account is the admin; after it, registration is `invite` (a share link is the invitation), `open` or `closed`. The password becomes a PBKDF2-SHA256 hash and the session is an `httpOnly` cookie holding an opaque token — the database keeps only its sha256.
- **Password change** in the account menu (top-right of the home): it asks for the current password and signs every other session out. There is no "forgot my password" — whoever loses theirs needs an operator reset (`docs/BACKEND.md` §8.1).
- **Homepage**: on entering, that account's diagrams, newest first, split between *Created by you* and *Shared with you*, with search, rename and a trash. Opening a diagram is navigation (`#/flow/<slug>`), so the browser's Back button works.
- **Diagrams belong to an account.** Only the owner and the people they invited see each one.
- **Share** (*Actions ▾ → Share diagram*, in the header, left of Save): a dropdown with the three ways to share —
  - **with a user**, by the email of their account: the diagram shows up on their home and both work on the same document;
  - **by link**, copied on the spot: whoever opens the link gets in, with or without an account;
  - **by email**: the server sends the invitation when SMTP is configured; without SMTP, it opens the user's own mail client with the link ready.
- **Three permissions on all of them** — `Can view` (open only), `Can edit` (edits and saves versions) and `Full control` (also shares and deletes). Only full control manages the sharing; links can be revoked at any time.

### Editor

- **A cartesian plane** with pan (drag the background), zoom (scroll or the `−` / `+` buttons) and a readout of the cursor position.
- **A tool sidebar** with search — 18 built-in tools (Airflow, dbt, Kafka, Snowflake, …); clicking adds the node to the plane. The sidebar is **collapsible** (it folds into a narrow rail) and **resizable** from its right edge — a double click on the handle returns it to the default width; both states live in `localStorage`.
- **Registering a tool** (*New tool*): when the tool you are looking for does not exist, a centred modal registers yours, with a name, a **category chosen from a list** (the built-in catalog's, plus the ones you already created, plus *Other…* to invent one), initials, a colour, search terms and, **optionally, an icon image** (downscaled in the browser to a 64×64 PNG). The catalog lives on the server, so the tool shows up in every browser.
- **Editing a tool** (*Edit tool*, right below *New tool*): the same form, opened on a tool that already exists — a dropdown at the top says which one, and the fields come filled with what the catalog holds. **Every** tool is in that list, the built-in ones included: editing a built-in registers a copy on the server that takes its place in the sidebar. Editing changes the **catalog**: nodes already on a plane keep the look they were created with, and only the icon, resolved live, follows the tool.
- **Deleting a tool** (*Danger zone*, at the bottom of *Edit tool*): a tool is deleted **only when no diagram uses it**. The editor asks the server where it is used and, when the answer is not empty, names the diagrams and keeps the button locked. What counts is the current content of every diagram, the ones in the trash included; older versions in the history do not, since a node whose tool is gone keeps every visual field and only stops resolving its icon. Deleting a built-in takes it out of the sidebar for everyone on this server (an operator brings it back with one `DELETE` in `custom_tools` — see `docs/BACKEND.md` §4.2).
- **Draggable nodes**, snapped to a 24 px grid.
- **Resizable nodes**: drag the handle in the bottom-right corner to change width and height (168–720 × 120–900); a double click on the handle — or *Reset size*, in the context menu — returns the node to its default size. With a fixed height, the excess content scrolls inside the card and the footer stays pinned at the bottom. The size goes into the JSON, into the PNG and into *Arrange*, which reserves each column's width by its widest node.
- **Renameable nodes**: a double click on the name (or `F2` with the node selected) opens the edit in place. The nickname becomes the card's title and **the technical stack name moves to just below it**, tinted with the tool's colour, before the category — renaming does not erase the tool's identity. Clearing the field, or typing the stack name again, undoes the nickname.
- **Directed arrows**: pull the yellow dot on the right of a node onto another node; the arrow points at the node you drop it on.
- **A label on the arrow**: a double click creates a text box centred on the arrow (input, output…). Clearing it removes the label.
- **Undo/redo** (Ctrl+Z / Ctrl+Y, or the two header buttons): a whole drag is one step, and typing text groups by 1.5 s.
- **A description per node** (the `≡` button in its header).
- **Metadata per node** as a key/value list **hanging below the card** (the `+` button in the footer; the arrow in the bottom-left corner opens and closes it). Sitting outside the card, it does not change where the arrows stop.
- **Groups**: `Ctrl+click` piles nodes into a selection and the context menu (or `Ctrl+G`) draws a **box behind them**. The box is renamed by a double click on its title, recoloured from the palette on its swatch, resized by the corner and **moved by dragging it — everything inside travels with it**. Inside the box each node still moves on its own, and **a node dragged out of the box leaves the group**: belonging is decided by position, not by a list, so dropping a node inside is all it takes to join. The plane's menu also creates an **empty box**, which is what a group is by default: a region that may or may not hold nodes. Boxes are saved with the flow and drawn in the exported PNG.
- **A context menu** (right click):
  - on a node — *create group*, rename, *reset size*, duplicate, *copy metadata*, paste, delete;
  - on a group — rename, *group colour*, *fit to nodes*, *delete group* (the nodes stay), *delete group and nodes*;
  - on an arrow — *edit description*, *delete edge*;
  - on the background — *create empty group*, paste a node here, copy the flow (JSON), centre the origin.
- **Arrange**: spreads the nodes into layers by barycentre, reserving room for arrows that cross layers, with no overlap.
- **Save**: a PNG of the rendered plane, JSON to download, or JSON to the clipboard (pasteable into another editor).
- **Actions**: a dropdown, left of Save, gathering *Import from JSON* (opens a `flow.json` from the computer) and *Share diagram* (only with full control).
- **Flows** (the flows on the server): a library with search, open, rename, a trash (with restore) and permanent deletion.
- **Immutable versions**: every `Save version` (Ctrl+S) enters the history; restoring an old version creates a new one holding that content, erasing nothing. The **history opens by clicking the document name**, in the top-left corner — it is a dropdown, not a panel.
- **Automatic draft**: 3 s after the last change the document is autosaved on the server without creating a version — reloading the page recovers the work.
- **Attachments**: the rendered PNG can be uploaded to the server and is listed in the flow's history.
- **Light / dark theme**, with the preference kept in `localStorage`.

### Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + C` | copies the selected node as JSON |
| `Ctrl/Cmd + V` | pastes a node (accepts JSON from another editor) |
| `Ctrl/Cmd + D` | duplicates the selected node |
| `Ctrl/Cmd + click` | adds a node to the selection (several at a time) |
| `Ctrl/Cmd + G` | boxes the selected nodes into a group |
| `F2` | renames the selected node (the stack name moves below), or the selected group |
| `Delete` / `Backspace` | removes the selected node or arrow — a selected group loses its box, never its nodes |
| `Ctrl/Cmd + S` | saves a version of the flow on the server |
| `Esc` | closes menus, cancels the arrow in progress and abandons a rename |

## MCP

The editor is also reachable from an MCP client — Claude Code, Claude Desktop —
so an agent can list, read, build and version diagrams **in the name of one
account**. The server lives in [`backend/mcp/`](backend/mcp/README.md), talks to
the API over HTTP like any other client (so it respects permissions, validation
and the 409 on concurrency) and uses no dependency beyond the standard library.

```bash
# credentials in .env: FLOW_MCP_EMAIL and FLOW_MCP_PASSWORD
python3 backend/mcp/server.py --check   # checks the API, the account and the tools
```

The `.mcp.json` at the root already declares the server, so Claude Code opened in
this project finds it. There are 16 tools; `FLOW_MCP_READ_ONLY=true` leaves only
the 7 that read. The one that makes the difference is `build_graph`: it takes a
list of tools and connections and returns the finished payload — with ids,
palette colours, a layered layout and the `y` axis already inverted.

## Structure

```
src/
├── main.jsx, App.jsx
└── flow/
    ├── FlowEditor.jsx      screen composition and the arrow/label geometry
    ├── useFlowEditor.js    state, interactions and server persistence
    ├── Header.jsx          top bar (document, flows, zoom, theme, save on the right)
    ├── HistoryMenu.jsx     dropdown of versions and attachments, on the document name
    ├── Sidebar.jsx         the collapsible, resizable tool sidebar
    ├── ToolModal.jsx       the tool registration modal
    ├── toolIcon.js         downscaling the chosen image to a 64×64 PNG icon
    ├── FlowLibrary.jsx     the library of server-side flows, and the trash
    ├── Node.jsx            the node card (description, metadata, ports)
    ├── EdgeSvg.jsx         the SVG layer holding the arrows
    ├── ContextMenu.jsx     the right-click menu
    ├── api.js              the API client (/api)
    ├── constants.js        tools, colours and dimensions
    ├── geometry.js         border clipping, curves and arrow midpoints
    ├── organize.js         the automatic layered layout
    ├── payload.js          node/flow serialisation and deserialisation
    ├── exportPng.js        rendering the plane onto a canvas (download and upload)
    ├── theme.css           theme tokens (light/dark)
    └── FlowEditor.css      component styles

backend/
└── app/
    ├── main.py             the FastAPI application, startup and the body limit
    ├── config.py           configuration from the environment
    ├── database.py         engine, session and the Postgres schema
    ├── models.py           flows, flow_versions, flow_assets, custom_tools
    ├── schemas.py          flow-graph payload validation and the DTOs
    ├── service.py          versioning, drafts and building the responses
    ├── slug.py             a slug from the name
    ├── storage.py          attachments on the volume, addressed by sha256
    ├── migrations.py       idempotent schema changes
    └── routers/            health, flows, versions, files, tools

backend/mcp/                the MCP server (stdio, standard library only)
├── server.py               the JSON-RPC loop, configuration and --check
├── toolset.py              the 16 tools exposed
├── client.py               the API's HTTP client, with the session cookie
├── catalog.py              the palette: built-ins from constants.js + registered ones
├── graph.py                spec → flow-graph payload (ids, layout, y axis)
└── selftest.py             drives the server over stdio, like a client

docker/
├── frontend.Dockerfile           the SPA build + the nginx serving it (LINEOS_BASE: / or a subpath)
├── frontend-nginx.conf.template  the static SPA, the /api proxy and the sign-in rate limit
└── lineos-base.envsh             derives the nginx locations from LINEOS_BASE at startup
```

The document is serialised by the same `payload.js` used for the file export, so
what goes into the database is the format described below. `useFlowEditor.js`
concentrates the server actions (open, save a version, draft, history) and
`api.js` is the only place that speaks HTTP.

## JSON format

A whole flow is exported as:

```json
{
  "kind": "flow-graph",
  "version": 1,
  "nodes": [
    { "id": 1, "name": "Airflow", "label": "Daily ingestion", "category": "ORCHESTRATION",
      "initials": "AF", "color": "#7dd3a0", "x": -432, "y": 24,
      "width": null, "height": null, "description": null, "metadata": {},
      "tool": null, "group": 1 }
  ],
  "edges": [{ "id": 1, "from": 1, "to": 2, "label": "trigger" }],
  "groups": [
    { "id": 1, "name": "Ingestion", "x": -480, "y": 120,
      "width": 520, "height": 320, "color": "#6fb8d3" }
  ]
}
```

A single node (*copy metadata* / `Ctrl+C`) uses `"kind": "flow-node"` with the
same format under `node`. The `y` axis is inverted on serialisation, so positive
values sit above the origin.

`label` is the name the user gave the node (`null` while it still uses the
tool's): `name` stays the technical stack name, and the editor prints it
**below** the nickname, so renaming does not erase the tool's identity.
`width`/`height` hold the size of a node resized by hand (`null` = the default:
232 wide, height dictated by the content); the limits are 168–720 and 120–900.

`groups` holds the boxes drawn behind the nodes (`[]` in a flow without any —
the field arrived after the first flows were saved, so it is optional on the way
in). A node's `group` is the id of the box holding it, or `null`. It is a cache
of geometry, not a second source of truth: the editor recomputes it from the
coordinates on every move (a node belongs to the box its centre falls in), which
is why dragging a node out of the box is all it takes to leave the group. The
API only checks that the id points at a group that exists.

`tool` is the slug of the registered tool the node came from (`null` for the
built-in catalog) and serves only to resolve the icon at draw time: name,
category, initials and colour are already copied into the node itself, so a node
stays correct even if the tool is deleted from the catalog.

That is also the format the API accepts and returns, validating `kind`,
`version`, id uniqueness, colours, group membership and the consistency of the
arrows (existing source and target, no self-loop, no duplicate) — see
[`docs/BACKEND.md`](docs/BACKEND.md). `Ctrl+V` of a whole `flow.json` replaces
the open document; of a single node, it appends the node to the plane.

## The original design

The [`design/`](design/) folder holds the prototype exported from Claude Design —
the `Editor de Fluxo.dc.html` artboard, the `support.js` runtime, the transcript
of the design conversation (`chats/`) and the original handoff instructions
(`HANDOFF.md`). It is a visual reference; it is not part of the build.
