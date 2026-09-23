# MCP server

Exposes the Editor de Fluxo to an MCP client — Claude Code, Claude Desktop, any
other — so an agent can list, read, build and version the diagrams of one
account, in that account's name.

Everything goes through the HTTP API, never straight to Postgres, so the rules
that guard the editor guard this too: sharing permissions, payload validation
and the optimistic locking that answers 409 when two writers race.

Standard library only, and no install step. The host runs a bare `python3`
without pip or virtualenv, and a server that needs an install is a server that
is not running when the client tries to start it. The protocol is a small
line-delimited JSON-RPC loop in `server.py` — `initialize`, `tools/list`,
`tools/call`, `ping`.

## Files

| File | Role |
| --- | --- |
| `server.py` | protocol loop, configuration, `--check` |
| `toolset.py` | the 16 tools: schema, handler, and whether each one writes |
| `client.py` | HTTP client with the session cookie, and one retry on 401 |
| `catalog.py` | the palette: built-ins read from `src/flow/constants.js`, plus `GET /api/tools` |
| `graph.py` | spec → `flow-graph` payload: ids, layout, y inversion, validation |
| `selftest.py` | drives the server over stdio the way a client does |

## Configuring

Credentials live in the project's `.env` (already gitignored), because the MCP
client starts this process itself — exporting a password in a shell first would
not reach it. Only `FLOW_MCP_*` keys are read from that file, and a real
environment variable always wins.

```ini
FLOW_MCP_BASE_URL=http://127.0.0.1:8010   # which API to talk to
FLOW_MCP_EMAIL=you@example.com            # an account on that API
FLOW_MCP_PASSWORD=...
FLOW_MCP_READ_ONLY=false                  # true drops every writing tool
```

The account is an ordinary one, created through the app's sign-up screen. It
sees exactly what that person sees: their own diagrams and the ones shared with
them. Giving the agent an account of its own, and sharing individual diagrams
with it, is the narrow way to do this.

Check the wiring without a client involved:

```bash
python3 backend/mcp/server.py --check
```

## Connecting a client

`.mcp.json` at the repository root already declares the server, so **Claude Code
started in this project finds it** — approve it once when asked, then `/mcp` to
confirm.

Elsewhere (Claude Desktop, another client), the entry is the same shape, with
absolute paths:

```json
{
  "mcpServers": {
    "flow-editor": {
      "command": "python3",
      "args": ["/path/to/lineOS/backend/mcp/server.py"]
    }
  }
}
```

The server reads `src/flow/constants.js` for the built-in palette, so it expects
to sit in the repository. Point `FLOW_MCP_CONSTANTS` at that file if it does
not.

## Tools

Reading:

| Tool | Answers |
| --- | --- |
| `server_status` | which API, which account, read-only or not |
| `list_catalog` | the palette: 18 built-in tools plus the registered ones |
| `build_graph` | a spec turned into a valid payload — touches no server |
| `list_flows` | the account's diagrams, and the ones shared with it |
| `get_flow` | one diagram with the graph the editor would open |
| `list_versions` / `get_version` | the history, and one version's graph |

Writing (all hidden by `FLOW_MCP_READ_ONLY`):

| Tool | Does |
| --- | --- |
| `create_flow` | new diagram, with version 1 |
| `save_version` | new version — the editor's Ctrl+S |
| `save_draft` | autosave, no version created |
| `rename_flow` | name and description; the slug follows the name |
| `restore_version` | writes a *new* version holding an old graph |
| `trash_flow` / `restore_flow` | the trash, and permanent deletion behind a confirmation |
| `create_custom_tool` / `delete_custom_tool` | the shared catalog, without icons. The delete is refused (409) while a diagram still uses the tool |
| `tool_usage` | which diagrams hold a node made from a tool — built-in tools included, by name |

The intended order is `list_catalog` → `build_graph` → `create_flow`, and
`get_flow` → edit → `save_version` for changes.

### Why `build_graph` exists

Three things about the payload are easy to get wrong and silent when wrong: the
y axis is inverted on the way out (a mirrored diagram), node ids and edge ids
are separate sequences that the edges point through, and the API validates ids,
colours, self-loops and duplicate arrows. So the spec names tools and nodes, and
`build_graph` assigns the ids, copies the palette's colour and initials into
each node, lays the nodes out in layers and negates y:

```json
{
  "nodes": [
    { "tool": "Kafka", "key": "in", "label": "Orders topic" },
    { "tool": "Airflow", "key": "run", "metadata": { "schedule": "0 3 * * *" } },
    { "tool": "Snowflake", "key": "out" }
  ],
  "edges": [
    { "from": "in", "to": "run", "label": "events" },
    { "from": "run", "to": "out", "label": "load" }
  ]
}
```

`create_flow`, `save_version` and `save_draft` accept the same `nodes`/`edges`
spec directly, as a shortcut for building and sending in one call.

The layout is a simplified `organizeLayout()` (`src/flow/organize.js`): layers
by longest path, columns packed vertically, no crossing reduction. It produces a
readable starting point; the editor's **Arrange** button does the real job.

## Testing

```bash
python3 backend/mcp/selftest.py
```

The protocol half — handshake, `tools/list`, `build_graph`, error reporting,
read-only mode — needs no server and runs anywhere.

The round trip half **writes for real**: it creates a flow, versions it,
restores it and deletes it permanently. It only runs with credentials set, and
it refuses a `:8010` target unless `FLOW_MCP_ALLOW_PROD=1`, because that is the
production API of this host. Use a disposable one, as `e2e/README.md` does:

```bash
docker exec flow-postgres psql -U flow -d postgres -c "CREATE DATABASE flows_mcp OWNER flow"
docker run -d --rm --name flow-api-mcp --network flow-net -p 127.0.0.1:8011:8000 \
  -e DATABASE_URL="postgresql+psycopg://flow:$(grep FLOW_DB_PASSWORD .env | cut -d= -f2)@postgres:5432/flows_mcp" \
  -e DB_SCHEMA=flow flow-editor-api

curl -s -X POST http://127.0.0.1:8011/api/auth/register -H 'Content-Type: application/json' \
  -d '{"name":"MCP Selftest","email":"mcp@teste.local","password":"selftest-1234"}'

FLOW_MCP_BASE_URL=http://127.0.0.1:8011 FLOW_MCP_EMAIL=mcp@teste.local \
FLOW_MCP_PASSWORD=selftest-1234 python3 backend/mcp/selftest.py

docker rm -f flow-api-mcp
```

## Worth knowing

- **A draft is not a version.** `save_draft` changes what the editor opens next
  without adding to the history; only `save_version` writes to `flow_versions`.
- **`save_version` without `base_version` overwrites whatever is current.** Pass
  the `current_version` that `get_flow` returned to get the 409 instead — that
  refusal is the point of the field.
- **Restoring never erases.** `restore_version` inserts a new version holding
  the old graph, exactly as the editor does.
- **A flow the account cannot reach answers 404, not 403** — the API does not
  confirm that other people's flows exist.
- **Deleting a custom tool does not touch any graph.** Name, colour, category
  and initials were copied into the node when it was placed; only the icon is
  resolved through the slug at draw time.
