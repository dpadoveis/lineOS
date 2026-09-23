"""Turning a short spec into a valid `flow-graph` payload.

Hand-writing the payload is the error-prone part of driving this API from an
agent, for three reasons that are easy to get wrong and silent when wrong:

* **the y axis is inverted in the payload** -- in the editor y grows downwards,
  in the JSON it grows upwards (AGENT.md, trap 1). Miss it and the diagram
  opens mirrored;
* **node ids and edge ids are separate sequences**, local to the document, and
  the edges point through them (trap 2);
* the API validates ids, colours, self-loops and duplicate edges, so a graph
  assembled by hand tends to come back 422 several times before it lands.

So the spec here names nodes by tool and edges by node, and this module assigns
the ids, resolves the palette, lays the nodes out in layers and negates y on the
way out. `validate()` then applies the same rules as `schemas.GraphPayload`,
locally, to fail with a sentence instead of a 422.
"""
import math
import re

from catalog import DEFAULT_CATEGORY, DEFAULT_COLOR, initials_from

MAX_NODES = 500
MAX_EDGES = 2000
MAX_GROUPS = 200
GROUP_MIN_WIDTH, GROUP_MAX_WIDTH = 160, 6000
GROUP_MIN_HEIGHT, GROUP_MAX_HEIGHT = 120, 6000
NODE_WIDTH = 232
NODE_MIN_WIDTH, NODE_MAX_WIDTH = 168, 720
NODE_MIN_HEIGHT, NODE_MAX_HEIGHT = 120, 900
GRID = 24
GAP_X, GAP_Y = 150, 52
# Metadata hangs below the card (META_* in src/flow/constants.js), so the layout
# has to reserve it even though it is not part of the node height.
META_GAP, META_HEAD, META_ROW = 6, 22, 26

COLOR = re.compile(r"^#[0-9a-fA-F]{3,8}$")

EMPTY_GRAPH = {"kind": "flow-graph", "version": 1, "nodes": [], "edges": []}


class SpecError(ValueError):
    """The spec cannot be turned into a graph. Message is for the agent."""


def snap(value: float) -> int:
    return int(round(value / GRID) * GRID)


# ── Building ─────────────────────────────────────────────────────────


def build(nodes_spec: list[dict], edges_spec: list[dict] | None, catalog) -> dict:
    """`{nodes: [...], edges: [...]}` in spec form -> a `flow-graph` payload."""
    if not isinstance(nodes_spec, list) or not nodes_spec:
        raise SpecError("at least one node is required")
    if len(nodes_spec) > MAX_NODES:
        raise SpecError(f"at most {MAX_NODES} nodes per flow")

    nodes = [_node(spec, index, catalog) for index, spec in enumerate(nodes_spec)]
    edges = _edges(edges_spec or [], nodes)

    positioned = all(n["_x"] is not None and n["_y"] is not None for n in nodes)
    if not positioned:
        _layout(nodes, edges)

    graph = {
        "kind": "flow-graph",
        "version": 1,
        # Field order mirrors flowPayload() in src/flow/payload.js, so a graph
        # built here reads the same as one exported from the editor.
        "nodes": [
            {
                "id": n["id"],
                "name": n["name"],
                "label": n["label"],
                "category": n["category"],
                "initials": n["initials"],
                "color": n["color"],
                "x": n["_x"],
                # The only place the inversion happens.
                "y": -n["_y"],
                "width": n["width"],
                "height": n["height"],
                "description": n["description"],
                "metadata": n["metadata"],
                "tool": n["tool"],
            }
            for n in nodes
        ],
        "edges": edges,
    }
    validate(graph)
    return graph


def _node(spec: dict, index: int, catalog) -> dict:
    if not isinstance(spec, dict):
        raise SpecError(f"node {index + 1} is not an object")

    term = _text(spec.get("tool") or spec.get("name"))
    if not term:
        raise SpecError(f"node {index + 1} needs a `tool` (or a free `name`)")

    found = catalog.find(term) if catalog is not None else None
    if found is None and not spec.get("name"):
        raise SpecError(
            f"node {index + 1}: no tool named {term!r} in the catalog. "
            "Call list_catalog to see the palette, or pass `name` to place a "
            "node that does not come from a tool."
        )

    base = found or {}
    name = _text(spec.get("name")) or base.get("name") or term
    category = _text(spec.get("category")) or base.get("category") or DEFAULT_CATEGORY
    initials = _text(spec.get("initials")) or base.get("initials") or initials_from(name)
    color = _text(spec.get("color")) or base.get("color") or DEFAULT_COLOR

    metadata = spec.get("metadata") or {}
    if not isinstance(metadata, dict):
        raise SpecError(f"node {index + 1}: `metadata` must be an object of key/value strings")
    metadata = {str(k): str(v) for k, v in metadata.items() if str(k).strip()}
    if len(metadata) > 60:
        raise SpecError(f"node {index + 1}: at most 60 metadata pairs")

    width = _size(spec.get("width"), NODE_MIN_WIDTH, NODE_MAX_WIDTH, "width", index)
    height = _size(spec.get("height"), NODE_MIN_HEIGHT, NODE_MAX_HEIGHT, "height", index)

    x, y = spec.get("x"), spec.get("y")
    return {
        # Ids are the node's position in the spec, so edges can point by number.
        "id": index + 1,
        "key": _text(spec.get("key")) or None,
        "name": name[:160],
        "label": (_text(spec.get("label")) or None),
        "category": category[:160].upper() if found is None else category[:160],
        "initials": initials[:8],
        "color": color,
        "width": width,
        "height": height,
        "description": _text(spec.get("description")) or None,
        "metadata": metadata,
        # Only a custom tool leaves a slug behind; built-ins draw from initials.
        "tool": base.get("slug"),
        # Editor coordinates (y downwards); negated on the way into the payload.
        "_x": snap(x) if isinstance(x, (int, float)) else None,
        "_y": -snap(y) if isinstance(y, (int, float)) else None,
    }


def _edges(specs: list, nodes: list[dict]) -> list[dict]:
    if not isinstance(specs, list):
        raise SpecError("`edges` must be a list")
    if len(specs) > MAX_EDGES:
        raise SpecError(f"at most {MAX_EDGES} edges per flow")

    edges = []
    for index, spec in enumerate(specs):
        if not isinstance(spec, dict):
            raise SpecError(f"edge {index + 1} is not an object")
        origin = _resolve(spec.get("from"), nodes, index, "from")
        target = _resolve(spec.get("to"), nodes, index, "to")
        label = _text(spec.get("label")) or None
        edges.append(
            # Edge ids run in their own sequence: node 1 and edge 1 coexist.
            {"id": index + 1, "from": origin, "to": target, "label": label}
        )
    return edges


def _resolve(reference, nodes: list[dict], index: int, field: str) -> int:
    """A node number (1-based, as listed) or a name/key/label that matches one."""
    if isinstance(reference, bool) or reference is None:
        raise SpecError(f"edge {index + 1}: `{field}` is required")
    if isinstance(reference, int):
        if 1 <= reference <= len(nodes):
            return reference
        raise SpecError(
            f"edge {index + 1}: `{field}` is node {reference}, but the spec has "
            f"{len(nodes)} node(s)"
        )
    term = _text(reference)
    if not term:
        raise SpecError(f"edge {index + 1}: `{field}` is required")
    if term.isdigit():
        return _resolve(int(term), nodes, index, field)

    lowered = term.lower()
    hits = [
        n["id"]
        for n in nodes
        if lowered in {(n["key"] or "").lower(), (n["label"] or "").lower(), n["name"].lower()}
    ]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise SpecError(f"edge {index + 1}: `{field}` names no node in this spec ({term!r})")
    raise SpecError(
        f"edge {index + 1}: {term!r} matches {len(hits)} nodes; give the node number, "
        "or a distinct `key` or `label`"
    )


# ── Layout ───────────────────────────────────────────────────────────


def _layout(nodes: list[dict], edges: list[dict]) -> None:
    """Layers by longest path from the sources, columns packed vertically.

    A smaller cousin of `organizeLayout()` in src/flow/organize.js -- no
    barycenter pass, no dummy slots for edges that skip layers. It only has to
    produce a readable, non-overlapping starting point; the editor's Arrange
    button does the crossing-reduction properly.
    """
    by_id = {n["id"]: n for n in nodes}
    layer = {n["id"]: 0 for n in nodes}
    for _ in range(len(nodes) + 1):
        moved = False
        for edge in edges:
            if layer[edge["to"]] < layer[edge["from"]] + 1 <= len(nodes):
                layer[edge["to"]] = layer[edge["from"]] + 1
                moved = True
        if not moved:
            break

    columns: dict[int, list[dict]] = {}
    for node in nodes:
        columns.setdefault(layer[node["id"]], []).append(node)

    keys = sorted(columns)
    widths = [max((n["width"] or NODE_WIDTH) for n in columns[k]) for k in keys]
    total_width = sum(w + GAP_X for w in widths) - GAP_X
    x = -total_width / 2
    for column_index, key in enumerate(keys):
        column = columns[key]
        heights = [_height(n) for n in column]
        total_height = sum(h + GAP_Y for h in heights) - GAP_Y
        y = -total_height / 2
        for node, height in zip(column, heights):
            node["_x"] = snap(x + (widths[column_index] - (node["width"] or NODE_WIDTH)) / 2)
            node["_y"] = snap(y)
            y += height + GAP_Y
        x += widths[column_index] + GAP_X


def _height(node: dict) -> int:
    """Rough card height, plus the metadata panel hanging below it.

    Only the layout uses this. Being generous is the safe direction: too much
    space is tidy, too little overlaps.
    """
    if node["height"]:
        card = node["height"]
    else:
        card = 100
        description = node["description"]
        if description:
            # ~34 characters per line at the default width.
            card += 24 + 18 * math.ceil(len(description) / 34)
    panel = META_GAP + META_HEAD + META_ROW * len(node["metadata"]) if node["metadata"] else 0
    return card + panel


# ── Validation ───────────────────────────────────────────────────────


def validate(graph) -> dict:
    """The rules of `schemas.GraphPayload`, checked here to fail readably."""
    if not isinstance(graph, dict):
        raise SpecError("the graph must be an object")
    if graph.get("kind") != "flow-graph" or graph.get("version") != 1:
        raise SpecError('the graph must carry {"kind": "flow-graph", "version": 1}')
    nodes, edges = graph.get("nodes"), graph.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise SpecError("`nodes` and `edges` must be lists")
    if len(nodes) > MAX_NODES:
        raise SpecError(f"at most {MAX_NODES} nodes per flow")
    if len(edges) > MAX_EDGES:
        raise SpecError(f"at most {MAX_EDGES} edges per flow")

    ids = []
    for position, node in enumerate(nodes):
        where = f"node {position + 1}"
        if not isinstance(node, dict):
            raise SpecError(f"{where} is not an object")
        node_id = node.get("id")
        if not isinstance(node_id, int) or isinstance(node_id, bool) or node_id <= 0:
            raise SpecError(f"{where}: `id` must be a positive integer")
        for field in ("name", "category", "initials"):
            value = node.get(field)
            if not isinstance(value, str) or not value.strip():
                raise SpecError(f"{where}: `{field}` is required")
        if not COLOR.match(str(node.get("color", ""))):
            raise SpecError(f"{where}: `color` must look like #rrggbb")
        ids.append(node_id)
    if len(set(ids)) != len(ids):
        raise SpecError("repeated node ids")

    known = set(ids)
    pairs = set()
    edge_ids = []
    for position, edge in enumerate(edges):
        where = f"edge {position + 1}"
        if not isinstance(edge, dict):
            raise SpecError(f"{where} is not an object")
        edge_id, origin, target = edge.get("id"), edge.get("from"), edge.get("to")
        if not isinstance(edge_id, int) or isinstance(edge_id, bool) or edge_id <= 0:
            raise SpecError(f"{where}: `id` must be a positive integer")
        if origin not in known or target not in known:
            raise SpecError(f"{where} points at a node that does not exist")
        if origin == target:
            raise SpecError(f"{where} links a node to itself")
        if (origin, target) in pairs:
            raise SpecError(f"duplicate edge between nodes {origin} and {target}")
        pairs.add((origin, target))
        edge_ids.append(edge_id)
    if len(set(edge_ids)) != len(edge_ids):
        raise SpecError("repeated edge ids")

    # Groups are optional: a graph built here has none, and a graph fetched
    # from a flow carries whatever boxes the editor drew. They are checked so
    # that a hand-written one fails here, with a readable message, instead of
    # coming back as a 422 from the API.
    groups = graph.get("groups", [])
    if not isinstance(groups, list):
        raise SpecError("`groups` must be a list")
    if len(groups) > MAX_GROUPS:
        raise SpecError(f"at most {MAX_GROUPS} groups per flow")
    group_ids = []
    for position, box in enumerate(groups):
        where = f"group {position + 1}"
        if not isinstance(box, dict):
            raise SpecError(f"{where} is not an object")
        box_id = box.get("id")
        if not isinstance(box_id, int) or isinstance(box_id, bool) or box_id <= 0:
            raise SpecError(f"{where}: `id` must be a positive integer")
        if not _text(box.get("name")):
            raise SpecError(f"{where}: `name` is required")
        if not COLOR.match(str(box.get("color", ""))):
            raise SpecError(f"{where}: `color` must look like #rrggbb")
        # A box has no natural size to fall back on, so unlike a node's these
        # two are required.
        for field, low, high in (
            ("width", GROUP_MIN_WIDTH, GROUP_MAX_WIDTH),
            ("height", GROUP_MIN_HEIGHT, GROUP_MAX_HEIGHT),
        ):
            if box.get(field) is None:
                raise SpecError(f"{where}: `{field}` is required")
            _size(box.get(field), low, high, field, position)
        group_ids.append(box_id)
    if len(set(group_ids)) != len(group_ids):
        raise SpecError("repeated group ids")
    boxes = set(group_ids)
    for position, node in enumerate(nodes):
        box_id = node.get("group")
        if box_id is not None and box_id not in boxes:
            raise SpecError(f"node {position + 1} points at a group that does not exist")
    return graph


def summarize(graph: dict) -> dict:
    """A compact view of a graph, for answers that should not carry it whole."""
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    groups = graph.get("groups", [])
    names = {n.get("id"): (n.get("label") or n.get("name")) for n in nodes}
    boxes = {g.get("id"): g.get("name") for g in groups}
    return {
        "node_count": len(nodes),
        "edge_count": len(edges),
        # Only mentioned when the flow actually draws boxes, so a summary of a
        # plain flow reads exactly as it did before.
        **({"group_count": len(groups)} if groups else {}),
        "nodes": [
            {
                "id": n.get("id"),
                "name": n.get("label") or n.get("name"),
                "stack": n.get("name"),
                "category": n.get("category"),
                "x": n.get("x"),
                "y": n.get("y"),
                **({"group": boxes.get(n.get("group"))} if n.get("group") else {}),
            }
            for n in nodes
        ],
        **(
            {
                "groups": [
                    {"id": g.get("id"), "name": g.get("name"), "x": g.get("x"), "y": g.get("y")}
                    for g in groups
                ]
            }
            if groups
            else {}
        ),
        "edges": [
            {
                "id": e.get("id"),
                "from": names.get(e.get("from"), e.get("from")),
                "to": names.get(e.get("to"), e.get("to")),
                "label": e.get("label"),
            }
            for e in edges
        ],
    }


def _text(value) -> str:
    if value is None or isinstance(value, bool):
        return ""
    return str(value).strip()


def _size(value, low: int, high: int, field: str, index: int):
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise SpecError(f"node {index + 1}: `{field}` must be a number")
    value = int(value)
    if not low <= value <= high:
        raise SpecError(f"node {index + 1}: `{field}` must be between {low} and {high}")
    return value
