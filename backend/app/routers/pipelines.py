"""Pipelines: a diagram, its bindings, and their collected state.

Permission is the diagram's, resolved through the existing access module. There
is no second authorisation concept here: whoever can see the drawing sees its
health, `edit` changes bindings, `full` promotes.
"""
import statistics
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session
import psycopg
from pydantic import BaseModel

from .. import access, health as health_rules, service, service_ops, dataset_source
from .. import dataset_detail as dd
from ..config import settings
from ..database import get_db
from ..models import PERMISSION_RANK, User, FlowVersion
from ..models_ops import InventoryObject, ObjectCheck, ObjectRun, Pipeline, PipelineBinding
from ..schemas_ops import (
    BindingItem,
    BindingWrite,
    CheckItem,
    ColumnInfo,
    HealthItem,
    HistoryOut,
    HistoryPoint,
    InventoryItem,
    NodesCreate,
    OrphanedBinding,
    PipelineCreate,
    PipelineDetail,
    PipelineList,
    PipelineNode,
    PipelineSummary,
    PreviewOut,
    RunItem,
    RunList,
    SchemaOut,
    StatsOut,
)

router = APIRouter(prefix="/pipelines", tags=["pipelines"])


def _require(db: Session, slug: str, user: User | None, minimum: str, token: str | None = None) -> Pipeline:
    """Resolves the pipeline and checks the caller against its DIAGRAM."""
    pipeline = service_ops.get_pipeline(db, slug)
    if pipeline is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "pipeline not found")
    flow = service.get_flow(db, str(pipeline.flow_id))
    level = access.permission_for(db, flow, user, token)
    if level is None:
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in to continue")
        raise HTTPException(status.HTTP_404_NOT_FOUND, "pipeline not found")
    if PERMISSION_RANK.get(level, 0) < PERMISSION_RANK.get(minimum, 99):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"'{minimum}' is required on the diagram"
        )
    return pipeline


def _last_run(db: Session, object_id: int) -> ObjectRun | None:
    return db.execute(
        select(ObjectRun)
        .where(ObjectRun.object_id == object_id)
        .order_by(ObjectRun.started_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def _last_check(db: Session, object_id: int) -> ObjectCheck | None:
    return db.execute(
        select(ObjectCheck)
        .where(ObjectCheck.object_id == object_id)
        .order_by(ObjectCheck.checked_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def _duration_median(db: Session, object_id: int) -> int | None:
    """Median `duration_ms` of the last 20 successful runs, None when empty."""
    durations = db.execute(
        select(ObjectRun.duration_ms)
        .where(ObjectRun.object_id == object_id, ObjectRun.outcome == "success",
               ObjectRun.duration_ms.is_not(None))
        .order_by(ObjectRun.started_at.desc())
        .limit(20)
    ).scalars().all()
    return round(statistics.median(durations)) if durations else None


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _health_of(binding: PipelineBinding, run: ObjectRun | None,
               check: ObjectCheck | None, now: datetime) -> HealthItem:
    obj = binding.obj
    verdict = health_rules.evaluate(
        kind=obj.kind,
        attrs=obj.attrs or {},
        rules=binding.rules or {},
        last_run=(
            health_rules.RunFacts(
                outcome=run.outcome,
                started_at=_aware(run.started_at),
                ended_at=_aware(run.ended_at),
                exit_code=run.exit_code,
                facts=run.facts or {},
            )
            if run
            else None
        ),
        last_check=(
            health_rules.CheckFacts(
                checked_at=_aware(check.checked_at),
                row_count=check.row_count,
                max_ts=_aware(check.max_ts),
                ok=check.ok,
                error=check.error,
            )
            if check
            else None
        ),
        seen_at=_aware(obj.last_seen_at),
        now=now,
    )
    return HealthItem(state=verdict.state, reason=verdict.reason, since=verdict.since)


def _detail(db: Session, pipeline: Pipeline) -> PipelineDetail:
    now = datetime.now(timezone.utc)
    flow = service.get_flow(db, str(pipeline.flow_id))
    graph, version = service_ops.current_graph(db, flow)
    bound = service_ops.bindings_by_uid(db, pipeline)
    seen_uids = set()
    nodes: list[PipelineNode] = []
    states: list[str] = []
    newest: datetime | None = None

    for raw in graph.get("nodes") or []:
        uid = raw.get("uid")
        if not uid:
            continue
        seen_uids.add(uid)
        binding = bound.get(uid)
        item = None
        if binding is not None:
            run = _last_run(db, binding.obj.id)
            check = _last_check(db, binding.obj.id)
            verdict = _health_of(binding, run, check, now)
            states.append(verdict.state)
            expected = None
            if binding.obj.kind in ("airflow_dag", "cron_job"):
                expected = health_rules.expected_window(
                    binding.obj.attrs, binding.rules, _aware(run.started_at) if run else None
                )
            item = BindingItem(
                node_uid=uid,
                object=InventoryItem.model_validate(binding.obj),
                rules=binding.rules or {},
                health=verdict,
                last_run=RunItem.model_validate(run) if run else None,
                last_check=CheckItem.model_validate(check) if check else None,
                expected=expected,
                duration_median_ms=(
                    _duration_median(db, binding.obj.id)
                    if binding.obj.kind in ("airflow_dag", "cron_job")
                    else None
                ),
            )
            seen = _aware(binding.obj.last_seen_at)
            if seen and (newest is None or seen > newest):
                newest = seen
        nodes.append(
            PipelineNode(
                uid=uid,
                title=raw.get("label") or raw.get("name") or "Node",
                name=raw.get("name") or "",
                category=raw.get("category") or "",
                binding=item,
            )
        )

    orphaned = [
        OrphanedBinding(node_uid=uid, object=InventoryItem.model_validate(b.obj))
        for uid, b in bound.items()
        if uid not in seen_uids
    ]
    pending = service_ops.missing_edges(db, pipeline, graph)
    return PipelineDetail(
        id=pipeline.id,
        slug=pipeline.slug,
        name=pipeline.name,
        flow_slug=flow.slug,
        flow_version=version,
        state=health_rules.worst(states),
        collected_age_s=int((now - newest).total_seconds()) if newest else None,
        nodes=nodes,
        orphaned_bindings=orphaned,
        graph=graph,
        pending_edges=len(pending),
    )


@router.post("", response_model=PipelineDetail, status_code=status.HTTP_201_CREATED)
def create_pipeline(
    body: PipelineCreate,
    db: Session = Depends(get_db),
    user: User = Depends(access.current_user),
) -> PipelineDetail:
    if body.flow is None:
        # Create an empty flow for this pipeline
        flow = service_ops.create_empty_flow(db, body.name, user)
    else:
        flow = service.get_flow(db, body.flow)
        level = access.permission_for(db, flow, user, None)
        if level is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "flow not found")
        if PERMISSION_RANK.get(level, 0) < PERMISSION_RANK["full"]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "'full' is required to promote a diagram")
    pipeline = service_ops.promote(db, flow, body.name, user)
    return _detail(db, pipeline)


@router.get("", response_model=PipelineList)
def list_pipelines(
    db: Session = Depends(get_db), user: User = Depends(access.current_user)
) -> PipelineList:
    items: list[PipelineSummary] = []
    for pipeline in db.execute(
        select(Pipeline).where(Pipeline.archived_at.is_(None)).order_by(Pipeline.name)
    ).scalars().all():
        flow = service.get_flow(db, str(pipeline.flow_id))
        if access.permission_for(db, flow, user, None) is None:
            continue
        detail = _detail(db, pipeline)
        items.append(
            PipelineSummary(
                id=detail.id,
                slug=detail.slug,
                name=detail.name,
                flow_slug=detail.flow_slug,
                state=detail.state,
                bound=sum(1 for n in detail.nodes if n.binding),
                total=len(detail.nodes),
                collected_age_s=detail.collected_age_s,
            )
        )
    unwatched = db.execute(
        select(InventoryObject.id).where(
            ~InventoryObject.id.in_(select(PipelineBinding.object_id))
        )
    ).all()
    return PipelineList(items=items, unwatched=len(unwatched))


@router.delete("/{slug}", status_code=status.HTTP_204_NO_CONTENT)
def delete_pipeline(
    slug: str,
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
) -> Response:
    """Deletes a lineage, for good as far as anyone can tell: the row stays with
    `archived_at` set (its slug is not reused), but its bindings are removed, so
    there is nothing to restore. The UI confirms it as irreversible."""
    pipeline = _require(db, slug, user, "full", token)
    pipeline.archived_at = datetime.now(timezone.utc)
    db.execute(
        PipelineBinding.__table__.delete().where(PipelineBinding.pipeline_id == pipeline.id)
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{slug}", response_model=PipelineDetail)
def read_pipeline(
    slug: str,
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
) -> PipelineDetail:
    return _detail(db, _require(db, slug, user, "view", token))


@router.put("/{slug}/bindings/{node_uid}", response_model=PipelineDetail)
def bind_node(
    slug: str,
    node_uid: str,
    body: BindingWrite,
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
) -> PipelineDetail:
    pipeline = _require(db, slug, user, "edit", token)
    flow = service.get_flow(db, str(pipeline.flow_id))
    graph, _ = service_ops.current_graph(db, flow)
    if node_uid not in {n.get("uid") for n in (graph.get("nodes") or [])}:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no node with that uid in this diagram")
    if db.get(InventoryObject, body.object_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such inventory object")
    binding = db.execute(
        select(PipelineBinding).where(
            PipelineBinding.pipeline_id == pipeline.id,
            PipelineBinding.node_uid == node_uid,
        )
    ).scalar_one_or_none()
    if binding is None:
        binding = PipelineBinding(pipeline_id=pipeline.id, node_uid=node_uid)
        db.add(binding)
    binding.object_id = body.object_id
    binding.rules = body.rules
    db.commit()
    return _detail(db, pipeline)


@router.delete("/{slug}/bindings/{node_uid}", status_code=status.HTTP_204_NO_CONTENT)
def unbind_node(
    slug: str,
    node_uid: str,
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
) -> Response:
    pipeline = _require(db, slug, user, "edit", token)
    db.execute(
        PipelineBinding.__table__.delete().where(
            PipelineBinding.pipeline_id == pipeline.id,
            PipelineBinding.node_uid == node_uid,
        )
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{slug}/nodes", response_model=PipelineDetail, status_code=status.HTTP_201_CREATED)
def add_nodes(
    slug: str,
    body: NodesCreate,
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
) -> PipelineDetail:
    pipeline = _require(db, slug, user, "edit", token)
    flow = service.get_flow(db, str(pipeline.flow_id))
    try:
        new_nodes = service_ops.add_nodes_to_graph(db, flow, body.object_ids, user)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "one or more objects not found")

    # Create bindings for the new nodes
    for oid, uid in new_nodes:
        binding = PipelineBinding(pipeline_id=pipeline.id, node_uid=uid, object_id=oid)
        db.add(binding)
    db.commit()

    return _detail(db, pipeline)


@router.get("/{slug}/objects/{object_id}/runs", response_model=RunList)
def read_runs(
    slug: str,
    object_id: int,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
) -> RunList:
    pipeline = _require(db, slug, user, "view", token)
    # Only through a binding of THIS pipeline: permission is the diagram's, so
    # serving any object id would leak telemetry across diagrams the caller
    # cannot see.
    bound = db.execute(
        select(PipelineBinding.id).where(
            PipelineBinding.pipeline_id == pipeline.id,
            PipelineBinding.object_id == object_id,
        )
    ).first()
    if bound is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "this pipeline does not bind that object")
    rows = db.execute(
        select(ObjectRun)
        .where(ObjectRun.object_id == object_id)
        .order_by(ObjectRun.started_at.desc())
        .limit(limit)
    ).scalars().all()
    return RunList(items=[RunItem.model_validate(r) for r in rows])


def _bound_table(db: Session, slug: str, user: User | None, object_id: int, minimum: str, token: str | None = None):
    """The binding of a TABLE in this pipeline, or the error the caller deserves."""
    pipeline = _require(db, slug, user, minimum, token)
    binding = db.execute(
        select(PipelineBinding).where(
            PipelineBinding.pipeline_id == pipeline.id,
            PipelineBinding.object_id == object_id,
        )
    ).scalar_one_or_none()
    if binding is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "this pipeline does not bind that object")
    if binding.obj.kind != "table":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "only a table has a preview")
    try:
        schema, table = dd.split_external_id(binding.obj.external_id)
    except dd.BadRequest as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return binding, schema, table


def _on_source(fn):
    """Runs fn(conn) on the dataset source, mapping its failures to HTTP errors."""
    try:
        with dataset_source.connect() as conn:
            return fn(conn)
    except dd.BadRequest as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except dataset_source.SourceUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))
    except psycopg.errors.QueryCanceled:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "the query took longer than 15 s")
    except psycopg.Error as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"dataset source error: {type(exc).__name__}")


@router.get("/{slug}/objects/{object_id}/schema", response_model=SchemaOut)
def read_schema(slug: str, object_id: int, db: Session = Depends(get_db),
                user: User | None = Depends(access.current_user_optional),
                token: str | None = Depends(access.share_token_header)):
    _, schema, table = _bound_table(db, slug, user, object_id, "view", token)
    return SchemaOut(columns=[ColumnInfo(**col) for col in _on_source(lambda c: dd.columns(c, schema, table))])


@router.get("/{slug}/objects/{object_id}/preview", response_model=PreviewOut)
def read_preview(slug: str, object_id: int, limit: int = 50, order_by: str | None = None,
                 dir: str = "desc", f: list[str] = Query(default=[]),
                 db: Session = Depends(get_db),
                 user: User | None = Depends(access.current_user_optional),
                 token: str | None = Depends(access.share_token_header)):
    binding, schema, table = _bound_table(db, slug, user, object_id, "edit", token)
    limit = max(1, min(100, limit))
    direction = "asc" if dir == "asc" else "desc"
    return PreviewOut(**_on_source(lambda c: dd.preview(
        c, schema, table, binding.rules or {}, order_by, direction, f, limit,
        settings.dataset_source_order_column)))


@router.get("/{slug}/objects/{object_id}/stats", response_model=StatsOut)
def read_stats(slug: str, object_id: int, db: Session = Depends(get_db),
               user: User | None = Depends(access.current_user_optional),
               token: str | None = Depends(access.share_token_header)):
    _, schema, table = _bound_table(db, slug, user, object_id, "edit", token)
    body = _on_source(lambda c: dd.stats(c, schema, table))
    check = _last_check(db, object_id)
    return StatsOut(row_count=check.row_count if check else None, **body)


@router.get("/{slug}/objects/{object_id}/history", response_model=HistoryOut)
def read_history(slug: str, object_id: int, days: int = 30, db: Session = Depends(get_db),
                 user: User | None = Depends(access.current_user_optional),
                 token: str | None = Depends(access.share_token_header)):
    _bound_table(db, slug, user, object_id, "view", token)
    since = datetime.now(timezone.utc) - timedelta(days=max(1, min(90, days)))
    rows = db.execute(
        select(ObjectCheck).where(ObjectCheck.object_id == object_id, ObjectCheck.checked_at >= since)
        .order_by(ObjectCheck.checked_at.asc())
    ).scalars().all()
    return HistoryOut(points=[HistoryPoint(checked_at=r.checked_at, row_count=r.row_count,
                                           ok=r.ok, error=r.error) for r in rows])


class SyncEdgesOut(BaseModel):
    added: int
    version: int


@router.post("/{slug}/sync-edges", response_model=SyncEdgesOut)
def sync_edges(
    slug: str,
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
) -> SyncEdgesOut:
    pipeline = _require(db, slug, user, "edit", token)
    flow = service.get_flow(db, str(pipeline.flow_id))
    graph, current_version = service_ops.current_graph(db, flow)

    edges_to_add = service_ops.missing_edges(db, pipeline, graph)
    if not edges_to_add:
        return SyncEdgesOut(added=0, version=current_version)

    edges_list = graph.get("edges") or []
    next_edge_id = max((e.get("id", 0) for e in edges_list), default=0) + 1

    for from_node_id, to_node_id in edges_to_add:
        edges_list.append({
            "id": next_edge_id,
            "from": from_node_id,
            "to": to_node_id,
            "label": None,
        })
        next_edge_id += 1

    graph["edges"] = edges_list
    service.create_version(
        db,
        flow,
        graph=graph,
        note=f"added {len(edges_to_add)} edges declared in the inventory",
        base_version=current_version,
        author=user.name if user is not None else None,
    )
    db.commit()

    new_version = db.execute(
        select(FlowVersion)
        .where(FlowVersion.flow_id == flow.id)
        .order_by(FlowVersion.version.desc())
        .limit(1)
    ).scalar_one()

    return SyncEdgesOut(added=len(edges_to_add), version=new_version.version)
