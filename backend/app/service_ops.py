"""Promoting a diagram and reading its bindings.

The module deliberately holds no health logic -- that lives in app/health.py as
pure functions. This file is the part that needs a session.
"""
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import service
from .models import Flow, FlowVersion, User
from .models_ops import InventoryObject, ObjectEdge, Pipeline, PipelineBinding
from .slug import slugify, unique_slug

# Category and styling per inventory object kind.
KIND_CONFIG = {
    "airflow_dag": {
        "category": "ORCHESTRATION",
        "initials": "AF",
        "color": "#7dd3a0",  # green
    },
    "cron_job": {
        "category": "SCHEDULING",
        "initials": "CR",
        "color": "#e8956a",  # orange
    },
    "table": {
        "category": "STORAGE",
        "initials": "TBL",
        "color": "#6fb8d3",  # blue
    },
}


def unique_pipeline_slug(db: Session, text: str) -> str:
    """A slug free among pipelines, appending -2, -3... on collision.

    `slug.unique_slug` cannot be reused: it queries Flow.slug specifically, and
    pipelines have their own namespace.
    """
    base = slugify(text)
    candidate = base
    n = 1
    while db.execute(select(Pipeline.id).where(Pipeline.slug == candidate)).first():
        n += 1
        suffix = f"-{n}"
        candidate = f"{base[: 120 - len(suffix)]}{suffix}"
    return candidate


def current_graph(db: Session, flow: Flow) -> tuple[dict, int]:
    """The flow's current VERSION and its number -- never the draft.

    An ops view must not follow somebody's half-finished edit, so this ignores
    `flows.draft_graph` even when there is one. That is the opposite of what
    the editor does, and it is deliberate.
    """
    version = db.execute(
        select(FlowVersion)
        .where(FlowVersion.flow_id == flow.id)
        .order_by(FlowVersion.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    if version is None:
        return {"kind": "flow-graph", "version": 1, "nodes": [], "edges": [], "groups": []}, 0
    return version.graph, version.version


def stamp_uids(db: Session, flow: Flow, user: User | None) -> int:
    """Gives a uid to every node that lacks one, as ONE new version.

    Diagrams predate the field, and a binding needs something stable to hold
    on to. This is the only time this module writes a version of a diagram: a
    one-off at promotion, never a cost paid per binding.
    """
    graph, _ = current_graph(db, flow)
    nodes = graph.get("nodes") or []
    missing = [n for n in nodes if not n.get("uid")]
    if not missing:
        return 0
    for n in missing:
        n["uid"] = str(uuid.uuid4())
    # Signature is (db, flow, graph, note, base_version, author) -- `author` is
    # a free label string, not a User (backend/app/service.py:51).
    service.create_version(
        db,
        flow,
        graph=graph,
        note="uid stamped for pipeline ops",
        base_version=flow.current_version,
        author=user.name if user is not None else None,
    )
    return len(missing)


def promote(db: Session, flow: Flow, name: str, user: User | None) -> Pipeline:
    """Turns a diagram into something watched."""
    stamp_uids(db, flow, user)
    # An archived (deleted) pipeline does not count: promoting its diagram again
    # starts a new one, under a fresh slug, instead of handing back the deleted.
    existing = db.execute(
        select(Pipeline).where(Pipeline.flow_id == flow.id, Pipeline.archived_at.is_(None))
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    pipeline = Pipeline(
        slug=unique_pipeline_slug(db, name),
        name=name,
        flow_id=flow.id,
    )
    db.add(pipeline)
    db.commit()
    db.refresh(pipeline)
    return pipeline


def _compute_stage_columns(object_ids: list[int], db: Session) -> dict[int, int]:
    """Column (stage) per object, left to right, from the declared edges.

    A producer sits left of what it produces. Objects nothing feeds start at
    column 0.

    **The graph is not acyclic, and that is not a mistake in it.** A DAG whose
    one task writes silver.table_a while another reads it declares both
    edges truthfully, and dag_silver_a does exactly that for
    silver.table_a and silver.table_c. Layering by longest
    path over a cycle never settles: it walked the column count into the
    thousands and put nodes at x=37800.

    So cycles are broken for the purpose of LAYOUT only, by a depth-first pass
    that drops back edges. The dropped edges are still drawn -- the picture
    keeps the truth, and only the column assignment pretends the graph is
    acyclic.
    """
    columns = {oid: 0 for oid in object_ids}
    if not object_ids:
        return columns

    wanted = set(object_ids)
    edges = db.execute(
        select(ObjectEdge).where(
            ObjectEdge.from_object_id.in_(object_ids),
            ObjectEdge.to_object_id.in_(object_ids),
        )
    ).scalars().all()

    adjacency: dict[int, list[int]] = {oid: [] for oid in object_ids}
    for edge in edges:
        if edge.from_object_id in wanted and edge.to_object_id in wanted:
            adjacency[edge.from_object_id].append(edge.to_object_id)

    # Depth-first, iterative (a deep chain must not blow the Python stack).
    # An edge reaching a node still on the stack closes a cycle: it is a back
    # edge, and it is the one we leave out of the layering.
    WHITE, GREY, BLACK = 0, 1, 2
    colour = {oid: WHITE for oid in object_ids}
    back_edges: set[tuple[int, int]] = set()

    for root in object_ids:
        if colour[root] != WHITE:
            continue
        stack = [(root, iter(adjacency[root]))]
        colour[root] = GREY
        while stack:
            node, children = stack[-1]
            advanced = False
            for child in children:
                if colour[child] == GREY:
                    back_edges.add((node, child))
                elif colour[child] == WHITE:
                    colour[child] = GREY
                    stack.append((child, iter(adjacency[child])))
                    advanced = True
                    break
            if not advanced:
                colour[node] = BLACK
                stack.pop()

    forward = [
        (e.from_object_id, e.to_object_id)
        for e in edges
        if e.from_object_id in wanted
        and e.to_object_id in wanted
        and (e.from_object_id, e.to_object_id) not in back_edges
    ]

    # Relaxation over an acyclic edge set now terminates on its own; the bound
    # stays as a seatbelt rather than as the thing that stops it.
    for _ in range(len(object_ids) + 1):
        changed = False
        for producer, consumer in forward:
            if columns[consumer] < columns[producer] + 1:
                columns[consumer] = columns[producer] + 1
                changed = True
        if not changed:
            break

    return columns


def bindings_by_uid(db: Session, pipeline: Pipeline) -> dict[str, PipelineBinding]:
    rows = db.execute(
        select(PipelineBinding).where(PipelineBinding.pipeline_id == pipeline.id)
    ).scalars().all()
    return {b.node_uid: b for b in rows}


def get_pipeline(db: Session, slug: str) -> Pipeline | None:
    return db.execute(
        select(Pipeline).where(Pipeline.slug == slug, Pipeline.archived_at.is_(None))
    ).scalar_one_or_none()


def create_empty_flow(db: Session, name: str, user: User | None) -> Flow:
    """Creates a flow with an empty diagram.

    Used when promoting a pipeline without an existing diagram.
    """
    slug_str = unique_slug(db, name)
    empty_graph = {
        "kind": "flow-graph",
        "version": 1,
        "nodes": [],
        "edges": [],
        "groups": [],
    }
    flow = Flow(
        slug=slug_str,
        name=name,
        owner_id=user.id if user else None,
    )
    db.add(flow)
    db.flush()
    service.create_version(
        db,
        flow,
        graph=empty_graph,
        note="created empty flow for pipeline ops",
        base_version=None,
        author=user.name if user is not None else None,
    )
    db.refresh(flow)
    return flow


def missing_edges(db: Session, pipeline: Pipeline, graph: dict) -> list[tuple[int, int]]:
    """Object edges whose both endpoints are bound in this pipeline's current graph.

    Returns [(from_node_id, to_node_id), ...] for edges not yet on the diagram.
    Ignores edges where either endpoint is not bound, self-loops, and deduplicates.
    """
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    existing_edge_set = {(e.get("from"), e.get("to")) for e in edges}
    node_id_by_uid = {n.get("uid"): n.get("id") for n in nodes if n.get("uid")}

    # Map object_id to node_id through bindings.
    bindings = bindings_by_uid(db, pipeline)
    object_to_node_id = {}
    for binding in bindings.values():
        uid = binding.node_uid
        if uid in node_id_by_uid:
            object_to_node_id[binding.object_id] = node_id_by_uid[uid]

    # Collect all object_ids in the map.
    object_ids_in_graph = set(object_to_node_id.keys())

    # Query declared edges where both endpoints are in the map.
    declared_edges = db.execute(
        select(ObjectEdge).where(
            ObjectEdge.from_object_id.in_(object_ids_in_graph),
            ObjectEdge.to_object_id.in_(object_ids_in_graph),
        )
    ).scalars().all()

    # Build result: (from_node_id, to_node_id) for edges not on the diagram.
    result = []
    seen = set()
    for edge_row in declared_edges:
        from_node_id = object_to_node_id.get(edge_row.from_object_id)
        to_node_id = object_to_node_id.get(edge_row.to_object_id)
        if from_node_id and to_node_id and from_node_id != to_node_id:
            key = (from_node_id, to_node_id)
            if key not in existing_edge_set and key not in seen:
                result.append(key)
                seen.add(key)

    return sorted(result)


def add_nodes_to_graph(
    db: Session, flow: Flow, object_ids: list[int], user: User | None
) -> list[tuple[int, str]]:
    """Adds nodes for objects to a flow's graph, with stage-based column layout.

    Returns [(object_id, node_uid), ...] for newly created nodes.

    Object already bound in this pipeline is skipped (idempotent).
    Nonexistent object raises KeyError before any change.
    """
    # Check all objects exist first (fail fast, atomically).
    objects = {}
    for oid in object_ids:
        obj = db.get(InventoryObject, oid)
        if obj is None:
            raise KeyError(f"object {oid} not found")
        objects[oid] = obj

    graph, _ = current_graph(db, flow)
    nodes = graph.get("nodes") or []
    edges_list = graph.get("edges") or []

    # Get existing bindings to check for duplicates.
    pipeline = db.execute(
        select(Pipeline).where(Pipeline.flow_id == flow.id)
    ).scalar_one_or_none()

    if pipeline:
        existing_bindings = bindings_by_uid(db, pipeline)
        already_bound_oids = {b.object_id for b in existing_bindings.values()}
        existing_node_uids = {b.node_uid: n["id"] for b in existing_bindings.values()
                              for n in nodes if n.get("uid") == b.node_uid}
    else:
        already_bound_oids = set()
        existing_node_uids = {}

    # Filter to only new objects.
    new_object_ids = [oid for oid in object_ids if oid not in already_bound_oids]
    if not new_object_ids:
        return []

    # Compute stage columns for all objects being added.
    stage_columns = _compute_stage_columns(new_object_ids, db)

    # Build a map from uid to node_id for existing nodes.
    node_uid_to_id = {n.get("uid"): n.get("id") for n in nodes if n.get("uid")}
    next_node_id = max((n.get("id", 0) for n in nodes), default=0) + 1

    # Sort objects by stage, then by (kind, layer, external_id) for determinism.
    sorted_objects = sorted(
        ((oid, objects[oid]) for oid in new_object_ids),
        key=lambda x: (
            stage_columns[x[0]],
            x[1].kind,
            x[1].attrs.get("layer", ""),
            x[1].external_id,
        ),
    )

    # Group by stage for layout.
    objects_by_stage = {}
    for oid, obj in sorted_objects:
        stage = stage_columns[oid]
        if stage not in objects_by_stage:
            objects_by_stage[stage] = []
        objects_by_stage[stage].append((oid, obj))

    # Find the last position to continue from.
    max_x = max((n.get("x", 0) for n in nodes), default=0)
    max_y = max((n.get("y", 0) for n in nodes), default=0)

    # Start positioning after existing nodes.
    base_x = max_x + 280 if max_x != 0 else 0
    base_y = max_y

    new_nodes = []  # [(object_id, node_uid), ...]
    oid_to_node_id = {}  # For edges: {object_id: node_id}

    # Place nodes by stage.
    for stage in sorted(objects_by_stage.keys()):
        stage_objs = objects_by_stage[stage]
        for row_in_stage, (oid, obj) in enumerate(stage_objs):
            uid = str(uuid.uuid4())
            config = KIND_CONFIG.get(obj.kind, KIND_CONFIG["airflow_dag"])

            node = {
                "id": next_node_id,
                "uid": uid,
                "name": obj.external_id,
                "label": obj.display_name if obj.display_name != obj.external_id else None,
                "category": config["category"],
                "initials": config["initials"],
                "color": config["color"],
                "x": base_x + stage * 280,
                "y": base_y + row_in_stage * 200,
                "width": None,
                "height": None,
                "description": None,
                "metadata": {},
                "tool": None,
                "group": None,
            }
            nodes.append(node)
            new_nodes.append((oid, uid))
            oid_to_node_id[oid] = next_node_id
            next_node_id += 1

    # Create edges between newly added objects that have declared edges.
    edge_rows = db.execute(
        select(ObjectEdge).where(
            ObjectEdge.from_object_id.in_(new_object_ids),
            ObjectEdge.to_object_id.in_(new_object_ids),
        )
    ).scalars().all()

    next_edge_id = max((e.get("id", 0) for e in edges_list), default=0) + 1
    for edge_row in edge_rows:
        from_node_id = oid_to_node_id.get(edge_row.from_object_id)
        to_node_id = oid_to_node_id.get(edge_row.to_object_id)
        if from_node_id and to_node_id:
            edges_list.append({
                "id": next_edge_id,
                "from": from_node_id,
                "to": to_node_id,
                "label": None,
            })
            next_edge_id += 1

    # Write exactly one new version for the batch.
    graph["nodes"] = nodes
    graph["edges"] = edges_list
    service.create_version(
        db,
        flow,
        graph=graph,
        note=f"added {len(new_nodes)} nodes from inventory",
        base_version=flow.current_version,
        author=user.name if user is not None else None,
    )

    return new_nodes
