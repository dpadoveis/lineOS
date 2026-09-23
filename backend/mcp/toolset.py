"""The tools this MCP server exposes, and what each one does.

One entry per tool: JSON Schema for the arguments, a handler, and a `write`
flag -- the read-only mode (FLOW_MCP_READ_ONLY) simply drops every tool marked
as writing, so an agent cannot touch a diagram it was only meant to read.
"""
import json
from urllib.parse import urlencode

import graph as graph_module
from catalog import initials_from
from client import ApiError

PERMISSIONS = ("view", "edit", "full")


class Context:
    def __init__(self, client, catalog, read_only: bool = False):
        self.client = client
        self.catalog = catalog
        self.read_only = read_only


# ── Argument helpers ─────────────────────────────────────────────────


def _reference(args: dict) -> str:
    reference = str(args.get("reference", "")).strip()
    if not reference:
        raise ValueError("`reference` is required: the flow slug or its numeric id")
    return reference


def _graph_argument(args: dict, context: Context) -> dict:
    """The graph to send: a full payload, or a spec to build one from."""
    payload = args.get("graph")
    if payload is not None:
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError as exc:
                raise ValueError(f"`graph` is not valid JSON: {exc}") from None
        return graph_module.validate(payload)
    if args.get("nodes") is not None:
        return graph_module.build(args.get("nodes"), args.get("edges"), context.catalog)
    raise ValueError(
        "send either `graph` (a full flow-graph payload) or `nodes`/`edges` "
        "(a spec, built here the way build_graph does it)"
    )


def _graph_view(detail: dict, mode: str) -> dict:
    """Trims the graph out of an answer, or down to a summary."""
    result = dict(detail)
    payload = result.get("graph")
    if mode == "none":
        result.pop("graph", None)
    elif mode == "summary" and isinstance(payload, dict):
        result["graph"] = graph_module.summarize(payload)
    return result


# ── Handlers ─────────────────────────────────────────────────────────


def server_status(context: Context, args: dict):
    status = {"api": context.client.health()}
    try:
        status.update(context.client.whoami())
    except ApiError as exc:
        status["signed_in"] = False
        status["error"] = exc.message()
    status["read_only"] = context.read_only
    try:
        status["builtin_tools"] = len(context.catalog.builtin())
    except RuntimeError as exc:
        status["builtin_tools"] = str(exc)
    return status


def list_catalog(context: Context, args: dict):
    term = str(args.get("query", "") or "").strip().lower()
    tools = context.catalog.all(with_custom=args.get("custom", True))
    if term:
        tools = [
            t
            for t in tools
            if term in t["name"].lower()
            or term in t["category"].lower()
            or term in (t.get("tags") or "").lower()
        ]
    return {"count": len(tools), "tools": tools}


def create_custom_tool(context: Context, args: dict):
    name = str(args.get("name", "")).strip()
    if not name:
        raise ValueError("`name` is required")
    body = {
        "name": name,
        "category": str(args.get("category") or "CUSTOM").strip().upper(),
        "initials": str(args.get("initials") or initials_from(name)).strip().upper(),
        "color": args.get("color") or "#9aa4b0",
        "tags": str(args.get("tags") or "").strip(),
    }
    return context.client.request("POST", "/api/tools", body=body)


def delete_custom_tool(context: Context, args: dict):
    tool_id = args.get("id")
    if tool_id is None:
        raise ValueError("`id` is required: the numeric id list_catalog shows for a custom tool")
    context.client.request("DELETE", f"/api/tools/{tool_id}")
    return {
        "id": tool_id,
        "deleted": True,
        "note": "catalog only: nodes created from this tool keep their name, colour and "
        "category, and fall back to their initials once the icon is gone",
    }


def tool_usage(context: Context, args: dict):
    """Which diagrams hold a node made from a tool -- the question
    delete_custom_tool answers to."""
    name = str(args.get("name", "")).strip()
    slug = str(args.get("slug") or "").strip()
    if not name and not slug:
        raise ValueError("give `name` (built-in or registered) or `slug` (registered)")
    query = []
    if slug:
        query.append(("slug", slug))
    if name:
        query.append(("name", name))
    path = "/api/tools/usage?" + urlencode(query)
    return context.client.request("GET", path)

def build_graph(context: Context, args: dict):
    payload = graph_module.build(args.get("nodes"), args.get("edges"), context.catalog)
    return {
        "graph": payload,
        "hint": "pass this object as `graph` to create_flow, save_version or save_draft",
    }


def list_flows(context: Context, args: dict):
    rows = context.client.request(
        "GET",
        "/api/flows",
        params={
            "q": args.get("query"),
            "trashed": "true" if args.get("trashed") else None,
            "limit": args.get("limit"),
        },
    )
    return {"count": len(rows), "flows": rows}


def get_flow(context: Context, args: dict):
    reference = _reference(args)
    version = args.get("version")
    detail = context.client.request("GET", f"/api/flows/{reference}")
    if version is not None:
        # An explicit version bypasses the draft: the caller asked for history,
        # not for whatever the editor last autosaved.
        stored = context.client.request("GET", f"/api/flows/{reference}/versions/{version}")
        detail["graph"] = stored["graph"]
        detail["graph_source"] = f"version {version}"
    return _graph_view(detail, str(args.get("graph") or "full"))


def create_flow(context: Context, args: dict):
    name = str(args.get("name", "")).strip()
    if not name:
        raise ValueError("`name` is required")
    body = {
        "name": name,
        "description": args.get("description"),
        "graph": _graph_argument(args, context),
        "note": args.get("note"),
    }
    return _graph_view(context.client.request("POST", "/api/flows", body=body), "summary")


def save_version(context: Context, args: dict):
    reference = _reference(args)
    payload = _graph_argument(args, context)
    base = args.get("base_version")
    if base is None:
        # Optimistic locking is the point of base_version (AGENT.md, trap 9), so
        # skipping it means "whatever is current" -- read it now and say so.
        base = context.client.request("GET", f"/api/flows/{reference}")["current_version"]
    version = context.client.request(
        "PUT",
        f"/api/flows/{reference}/versions",
        body={"graph": payload, "note": args.get("note"), "base_version": base},
    )
    return _graph_view(version, "none") | {"base_version": base}


def save_draft(context: Context, args: dict):
    reference = _reference(args)
    payload = _graph_argument(args, context)
    saved = context.client.request(
        "PUT", f"/api/flows/{reference}/draft", body={"graph": payload}
    )
    return saved | {
        "note": "saved as a draft, so no version was created; the editor shows it on open"
    }


def rename_flow(context: Context, args: dict):
    reference = _reference(args)
    body = {}
    if args.get("name") is not None:
        body["name"] = str(args["name"]).strip()
    if args.get("description") is not None:
        body["description"] = args["description"]
    if not body:
        raise ValueError("nothing to change: send `name`, `description`, or both")
    return context.client.request("PATCH", f"/api/flows/{reference}", body=body)


def list_versions(context: Context, args: dict):
    reference = _reference(args)
    rows = context.client.request("GET", f"/api/flows/{reference}/versions")
    return {"count": len(rows), "versions": rows}


def get_version(context: Context, args: dict):
    reference = _reference(args)
    number = args.get("version")
    if number is None:
        raise ValueError("`version` is required")
    stored = context.client.request("GET", f"/api/flows/{reference}/versions/{number}")
    return _graph_view(stored, str(args.get("graph") or "full"))


def restore_version(context: Context, args: dict):
    reference = _reference(args)
    number = args.get("version")
    if number is None:
        raise ValueError("`version` is required")
    created = context.client.request(
        "POST", f"/api/flows/{reference}/versions/{number}/restore"
    )
    return _graph_view(created, "none") | {
        "note": f"version {created.get('version')} is a new copy of version {number}; "
        "nothing was overwritten"
    }


def trash_flow(context: Context, args: dict):
    reference = _reference(args)
    permanent = bool(args.get("permanent"))
    if permanent and str(args.get("confirm", "")).strip().lower() != reference.lower():
        raise ValueError(
            "deleting permanently drops the flow with every version and attachment. "
            "Repeat the reference in `confirm` to go ahead, or leave `permanent` off "
            "to send it to the trash instead."
        )
    context.client.request(
        "DELETE", f"/api/flows/{reference}", params={"purge": "true" if permanent else None}
    )
    return {
        "reference": reference,
        "deleted": "permanently" if permanent else "moved to the trash",
        "restorable": not permanent,
    }


def restore_flow(context: Context, args: dict):
    reference = _reference(args)
    return context.client.request("POST", f"/api/flows/{reference}/restore")


# ── Definitions ──────────────────────────────────────────────────────

_NODE_SPEC = {
    "type": "object",
    "description": "One node. `tool` picks the palette entry; everything else is optional.",
    "properties": {
        "tool": {
            "type": "string",
            "description": "Catalog tool name or slug (see list_catalog), e.g. 'Airflow'.",
        },
        "name": {
            "type": "string",
            "description": "Free stack name, for a node that comes from no tool. "
            "Overrides the tool's name when both are given.",
        },
        "label": {
            "type": "string",
            "description": "What this node is called on the plane. The stack name stays "
            "visible underneath it.",
        },
        "key": {
            "type": "string",
            "description": "Short handle, only so edges can point at this node by name.",
        },
        "description": {"type": "string", "maxLength": 4000},
        "metadata": {
            "type": "object",
            "description": "Key/value pairs shown in the panel below the card.",
            "additionalProperties": {"type": "string"},
        },
        "category": {"type": "string"},
        "initials": {"type": "string", "maxLength": 8},
        "color": {"type": "string", "description": "#rrggbb; defaults to the tool's colour."},
        "width": {"type": "integer", "minimum": 168, "maximum": 720},
        "height": {"type": "integer", "minimum": 120, "maximum": 900},
        "x": {"type": "integer", "description": "Position on the plane. Give x and y on every "
              "node, or on none and let them be laid out automatically. y grows upwards."},
        "y": {"type": "integer"},
    },
    "additionalProperties": False,
}

_EDGE_SPEC = {
    "type": "object",
    "description": "A directed arrow. Endpoints are node numbers (1 = first node in "
    "`nodes`) or a node's `key`, `label` or name.",
    "properties": {
        "from": {"type": ["integer", "string"]},
        "to": {"type": ["integer", "string"]},
        "label": {"type": "string", "maxLength": 200, "description": "Text on the arrow."},
    },
    "required": ["from", "to"],
    "additionalProperties": False,
}

_GRAPH_ARGUMENTS = {
    "graph": {
        "type": "object",
        "description": "A complete flow-graph payload, as build_graph or get_flow returns it.",
    },
    "nodes": {
        "type": "array",
        "items": _NODE_SPEC,
        "description": "Spec form, instead of `graph`: the graph is built here, "
        "exactly as build_graph would.",
    },
    "edges": {"type": "array", "items": _EDGE_SPEC},
}

_REFERENCE = {
    "type": "string",
    "description": "Flow slug (e.g. 'ingestao-diaria') or its numeric id.",
}

_GRAPH_VIEW = {
    "type": "string",
    "enum": ["full", "summary", "none"],
    "description": "How much of the graph to return. 'full' is what you need before "
    "editing; 'summary' lists nodes and edges by name.",
}

TOOLS = [
    {
        "name": "server_status",
        "description": "Which API this server talks to, which account it is signed in as, "
        "and whether it is read-only. Start here when something fails.",
        "write": False,
        "handler": server_status,
        "schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "list_catalog",
        "description": "The tool palette: the 18 built-in tools plus the ones users "
        "registered. Use it to learn the names build_graph accepts.",
        "write": False,
        "handler": list_catalog,
        "schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Filters by name, category or tags."},
                "custom": {
                    "type": "boolean",
                    "default": True,
                    "description": "Include the user-registered tools.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "build_graph",
        "description": "Builds a valid flow-graph payload from a short spec: names the "
        "tools, and this assigns ids, resolves colours and initials, lays the nodes out "
        "in layers and inverts the y axis. Touches no server -- pass the result to "
        "create_flow or save_version.",
        "write": False,
        "handler": build_graph,
        "schema": {
            "type": "object",
            "properties": {"nodes": _GRAPH_ARGUMENTS["nodes"], "edges": _GRAPH_ARGUMENTS["edges"]},
            "required": ["nodes"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_flows",
        "description": "Diagrams this account can see: its own and the ones shared with it.",
        "write": False,
        "handler": list_flows,
        "schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Filters by name or description."},
                "trashed": {
                    "type": "boolean",
                    "description": "Lists the trash instead of the active flows.",
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 200},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_flow",
        "description": "Opens a flow: metadata and the graph to work from. Without "
        "`version` it returns what the editor would open -- the draft when the autosave "
        "is newer than the last version, which `graph_source` tells apart.",
        "write": False,
        "handler": get_flow,
        "schema": {
            "type": "object",
            "properties": {
                "reference": _REFERENCE,
                "version": {"type": "integer", "minimum": 1, "description": "Reads this "
                            "version's graph instead of the current one."},
                "graph": _GRAPH_VIEW,
            },
            "required": ["reference"],
            "additionalProperties": False,
        },
    },
    {
        "name": "create_flow",
        "description": "Creates a diagram and writes version 1 with the graph given. "
        "It shows up on the account's homepage right away.",
        "write": True,
        "handler": create_flow,
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "maxLength": 160},
                "description": {"type": "string", "maxLength": 2000},
                "note": {"type": "string", "maxLength": 500, "description": "History note."},
                **_GRAPH_ARGUMENTS,
            },
            "required": ["name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "save_version",
        "description": "Writes a new version of an existing flow -- the equivalent of "
        "Ctrl+S in the editor. Pass `base_version` (from get_flow) to be refused with a "
        "409 if someone else saved meanwhile; omit it to save over whatever is current.",
        "write": True,
        "handler": save_version,
        "schema": {
            "type": "object",
            "properties": {
                "reference": _REFERENCE,
                "note": {"type": "string", "maxLength": 500},
                "base_version": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "The version this edit started from.",
                },
                **_GRAPH_ARGUMENTS,
            },
            "required": ["reference"],
            "additionalProperties": False,
        },
    },
    {
        "name": "save_draft",
        "description": "Overwrites the flow's draft without touching the history -- the "
        "same autosave the editor does. Good for handing work over for a person to look "
        "at before it becomes a version.",
        "write": True,
        "handler": save_draft,
        "schema": {
            "type": "object",
            "properties": {"reference": _REFERENCE, **_GRAPH_ARGUMENTS},
            "required": ["reference"],
            "additionalProperties": False,
        },
    },
    {
        "name": "rename_flow",
        "description": "Changes a flow's name or description. Creates no version; "
        "renaming also changes the slug.",
        "write": True,
        "handler": rename_flow,
        "schema": {
            "type": "object",
            "properties": {
                "reference": _REFERENCE,
                "name": {"type": "string", "maxLength": 160},
                "description": {"type": "string", "maxLength": 2000},
            },
            "required": ["reference"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_versions",
        "description": "A flow's history, newest first, without the graphs.",
        "write": False,
        "handler": list_versions,
        "schema": {
            "type": "object",
            "properties": {"reference": _REFERENCE},
            "required": ["reference"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_version",
        "description": "One stored version, with its graph.",
        "write": False,
        "handler": get_version,
        "schema": {
            "type": "object",
            "properties": {
                "reference": _REFERENCE,
                "version": {"type": "integer", "minimum": 1},
                "graph": _GRAPH_VIEW,
            },
            "required": ["reference", "version"],
            "additionalProperties": False,
        },
    },
    {
        "name": "restore_version",
        "description": "Goes back to an old state by writing a NEW version holding that "
        "graph. The history is immutable, so nothing is erased or rewritten.",
        "write": True,
        "handler": restore_version,
        "schema": {
            "type": "object",
            "properties": {"reference": _REFERENCE, "version": {"type": "integer", "minimum": 1}},
            "required": ["reference", "version"],
            "additionalProperties": False,
        },
    },
    {
        "name": "trash_flow",
        "description": "Sends a flow to the trash, where restore_flow brings it back. "
        "With `permanent`, drops it for good along with its versions and attachments -- "
        "that needs the reference repeated in `confirm`.",
        "write": True,
        "handler": trash_flow,
        "schema": {
            "type": "object",
            "properties": {
                "reference": _REFERENCE,
                "permanent": {"type": "boolean", "default": False},
                "confirm": {
                    "type": "string",
                    "description": "Required with `permanent`: repeat the reference.",
                },
            },
            "required": ["reference"],
            "additionalProperties": False,
        },
    },
    {
        "name": "restore_flow",
        "description": "Takes a flow out of the trash.",
        "write": True,
        "handler": restore_flow,
        "schema": {
            "type": "object",
            "properties": {"reference": _REFERENCE},
            "required": ["reference"],
            "additionalProperties": False,
        },
    },
    {
        "name": "create_custom_tool",
        "description": "Registers a tool in the shared catalog, so it appears in every "
        "browser's sidebar. No icon here -- that is an image, and the editor's New tool "
        "modal is where it belongs.",
        "write": True,
        "handler": create_custom_tool,
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "maxLength": 80},
                "category": {"type": "string", "maxLength": 40, "default": "CUSTOM"},
                "initials": {"type": "string", "maxLength": 8},
                "color": {"type": "string", "description": "#rrggbb"},
                "tags": {"type": "string", "maxLength": 300, "description": "Search terms."},
            },
            "required": ["name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "tool_usage",
        "description": "Which diagrams hold a node made from this tool. Answers for a "
        "built-in tool too, which has no id: pass its name. A tool is only deleted when "
        "the count is zero.",
        "write": False,
        "handler": tool_usage,
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Tool name, as list_catalog shows it."},
                "slug": {"type": "string", "description": "Slug of a registered tool."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "delete_custom_tool",
        "description": "Removes a tool from the shared catalog. REFUSED (409) while any "
        "diagram still holds a node made from it -- ask tool_usage first. Graphs are "
        "untouched: a node keeps the name, colour and category copied into it when it "
        "was placed.",
        "write": True,
        "handler": delete_custom_tool,
        "schema": {
            "type": "object",
            "properties": {"id": {"type": "integer", "description": "From list_catalog."}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
]

BY_NAME = {tool["name"]: tool for tool in TOOLS}


def listing(read_only: bool) -> list[dict]:
    """The tools/list answer: MCP wants name, description and inputSchema."""
    return [
        {
            "name": tool["name"],
            "description": tool["description"],
            "inputSchema": tool["schema"],
        }
        for tool in TOOLS
        if not (read_only and tool["write"])
    ]
