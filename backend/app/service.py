"""Business rules shared by the routers."""
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from . import access
from .config import settings
from .models import Flow, FlowShare, FlowVersion, User
from .schemas import FlowDetail, FlowListItem, GraphPayload

EMPTY_GRAPH = {"kind": "flow-graph", "version": 1, "nodes": [], "edges": []}


def get_flow(db: Session, reference: str, include_deleted: bool = False) -> Flow:
    """Looks a flow up by numeric id or by slug. 404 when there is none."""
    stmt = select(Flow)
    if reference.isdigit():
        stmt = stmt.where(Flow.id == int(reference))
    else:
        stmt = stmt.where(Flow.slug == reference)
    flow = db.execute(stmt).scalar_one_or_none()
    if flow is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "flow not found")
    if flow.deleted_at is not None and not include_deleted:
        raise HTTPException(status.HTTP_410_GONE, "flow is in the trash")
    return flow


def latest_version(db: Session, flow: Flow) -> FlowVersion | None:
    return db.execute(
        select(FlowVersion)
        .where(FlowVersion.flow_id == flow.id)
        .order_by(FlowVersion.version.desc())
        .limit(1)
    ).scalar_one_or_none()


def get_version(db: Session, flow: Flow, number: int) -> FlowVersion:
    version = db.execute(
        select(FlowVersion).where(
            FlowVersion.flow_id == flow.id, FlowVersion.version == number
        )
    ).scalar_one_or_none()
    if version is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"version {number} not found")
    return version


def create_version(
    db: Session,
    flow: Flow,
    graph: GraphPayload | dict,
    note: str | None,
    base_version: int | None,
    author: str | None = None,
) -> FlowVersion:
    """Inserts a new version and advances `flows.current_version`.

    `SELECT ... FOR UPDATE` serialises the numbering: two simultaneous saves on
    the same flow cannot be handed the same version number. When `base_version`
    is given and does not match the current version, the answer is 409 rather
    than silently overwriting another tab's work.
    """
    locked = db.execute(
        select(Flow).where(Flow.id == flow.id).with_for_update()
    ).scalar_one()

    if base_version is not None and base_version != locked.current_version:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "stale_version",
                "message": (
                    f"the flow is already at version {locked.current_version}; "
                    f"this save started from {base_version}"
                ),
                "current_version": locked.current_version,
            },
        )

    data = graph.to_json() if isinstance(graph, GraphPayload) else graph
    number = locked.current_version + 1
    version = FlowVersion(
        flow_id=locked.id,
        version=number,
        graph=data,
        node_count=len(data.get("nodes", [])),
        edge_count=len(data.get("edges", [])),
        note=note,
        # With an account, the author is the name of whoever saved; without one
        # (a save arriving through a share link) the free label from settings is
        # all that is left.
        author=author or settings.author or None,
    )
    db.add(version)
    locked.current_version = number
    # The saved version supersedes the draft: clear it, so reopening the flow
    # does not bring old work back.
    locked.draft_graph = None
    locked.draft_updated_at = None
    locked.updated_at = datetime.now(timezone.utc)
    db.flush()
    return version


def counts(db: Session, flow: Flow) -> tuple[int, int]:
    """Node/edge counts of the current version (0/0 when there is none yet)."""
    row = db.execute(
        select(FlowVersion.node_count, FlowVersion.edge_count).where(
            FlowVersion.flow_id == flow.id, FlowVersion.version == flow.current_version
        )
    ).first()
    return (row[0], row[1]) if row else (0, 0)


def build_item(
    db: Session,
    flow: Flow,
    user: User | None = None,
    token: str | None = None,
    permission: str | None = None,
) -> FlowListItem:
    """One list item. `permission` skips recomputing what the router resolved.

    With neither user nor token (internal calls, tests) it reports 'full':
    whoever got this far already passed the access dependency.
    """
    nodes, edges = counts(db, flow)
    level = permission or access.permission_for(db, flow, user, token) or "full"
    shared_count = db.execute(
        select(func.count()).select_from(FlowShare).where(FlowShare.flow_id == flow.id)
    ).scalar_one()
    return FlowListItem(
        id=flow.id,
        slug=flow.slug,
        name=flow.name,
        description=flow.description,
        current_version=flow.current_version,
        node_count=nodes,
        edge_count=edges,
        has_draft=flow.draft_graph is not None,
        created_at=flow.created_at,
        updated_at=flow.updated_at,
        deleted_at=flow.deleted_at,
        owner_id=flow.owner_id,
        owner_name=flow.owner.name if flow.owner else None,
        permission=level,
        is_owner=access.is_owner(flow, user),
        shared_count=shared_count,
    )


def build_detail(
    db: Session,
    flow: Flow,
    user: User | None = None,
    token: str | None = None,
    permission: str | None = None,
) -> FlowDetail:
    """The detail, with the graph to open: the draft when it is the newer one.

    The editor autosaves into `draft_graph`; if someone closed the tab without
    saving a version, that content is what they expect to find on reopening.
    """
    version = latest_version(db, flow)
    if flow.draft_graph is not None:
        graph, source = flow.draft_graph, "draft"
    elif version is not None:
        graph, source = version.graph, "version"
    else:
        graph, source = EMPTY_GRAPH, "version"

    item = build_item(db, flow, user, token, permission)
    if source == "draft":
        item.node_count = len(graph.get("nodes", []))
        item.edge_count = len(graph.get("edges", []))
    return FlowDetail(**item.model_dump(), graph=graph, graph_source=source)


def list_flows(
    db: Session,
    q: str | None,
    trashed: bool,
    user: User | None = None,
    limit: int | None = None,
) -> list[FlowListItem]:
    """The flows this user reaches: the ones they created and the ones shared
    with them. The same query feeds the library and the homepage -- only the
    latter asks for `limit`.
    """
    stmt = select(Flow)
    stmt = stmt.where(Flow.deleted_at.is_not(None)) if trashed else stmt.where(
        Flow.deleted_at.is_(None)
    )
    if user is not None:
        shared = select(FlowShare.flow_id).where(FlowShare.user_id == user.id)
        stmt = stmt.where(or_(Flow.owner_id == user.id, Flow.id.in_(shared)))
        # The trash belongs to the owner alone: a guest does not see what the
        # owner threw away.
        if trashed:
            stmt = stmt.where(Flow.owner_id == user.id)
    if q:
        needle = f"%{q.strip()}%"
        stmt = stmt.where(
            func.concat(Flow.name, " ", func.coalesce(Flow.description, "")).ilike(needle)
        )
    stmt = stmt.order_by(Flow.updated_at.desc())
    if limit:
        stmt = stmt.limit(limit)
    return [build_item(db, f, user) for f in db.execute(stmt).scalars()]
