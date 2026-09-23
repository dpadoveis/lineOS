import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from .. import access, service, storage
from ..database import get_db
from ..models import Flow, User
from ..schemas import (
    DraftSave,
    FlowCreate,
    FlowDetail,
    FlowListItem,
    FlowPatch,
)
from ..slug import unique_slug

router = APIRouter(prefix="/flows", tags=["flows"])


@router.get("", response_model=list[FlowListItem])
def list_flows(
    q: str | None = Query(None, description="filters by name or description"),
    trashed: bool = Query(False, description="lists the trash instead of the active flows"),
    limit: int | None = Query(None, ge=1, le=200, description="cuts the list (used by the home)"),
    db: Session = Depends(get_db),
    user: User = Depends(access.current_user),
):
    """This user's flows: the ones they created and the ones shared with them."""
    return service.list_flows(db, q, trashed, user, limit)


@router.post("", response_model=FlowDetail, status_code=status.HTTP_201_CREATED)
def create_flow(
    data: FlowCreate,
    db: Session = Depends(get_db),
    user: User = Depends(access.current_user),
):
    """Creates the flow and writes version 1 with the graph received."""
    flow = Flow(
        owner_id=user.id,
        slug=unique_slug(db, data.name),
        name=data.name,
        description=data.description,
        current_version=0,
    )
    db.add(flow)
    db.flush()
    service.create_version(db, flow, data.graph, data.note, base_version=0, author=user.name)
    db.commit()
    db.refresh(flow)
    return service.build_detail(db, flow, user, permission="full")


@router.get("/{reference}", response_model=FlowDetail)
def open_flow(
    flow: Flow = Depends(access.RequireFlow("view")),
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
):
    """Metadata plus the graph to load (the draft when it is newer than the
    version).

    Opening through a share link while signed in also records the visit as a
    share, so the flow shows up on the homepage of whoever got the link.
    """
    access.attach_link_share(db, flow, user, token)
    return service.build_detail(db, flow, user, token)


@router.patch("/{reference}", response_model=FlowListItem)
def rename_flow(
    data: FlowPatch,
    flow: Flow = Depends(access.RequireFlow("edit")),
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
):
    """Changes name and description without creating a version -- metadata is
    not content."""
    if data.name is not None and data.name != flow.name:
        flow.name = data.name
        flow.slug = unique_slug(db, data.name, ignore_id=flow.id)
    if data.description is not None:
        flow.description = data.description or None
    db.commit()
    db.refresh(flow)
    return service.build_item(db, flow, user)


@router.put("/{reference}/draft", response_model=FlowListItem)
def save_draft(
    data: DraftSave,
    flow: Flow = Depends(access.RequireFlow("edit")),
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
):
    """Autosave: overwrites the draft, leaving the history alone.

    This is what the editor calls, debounced, while someone works. No
    flow_versions row is created -- only "Save version" does that.
    """
    flow.draft_graph = data.graph.to_json()
    flow.draft_updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(flow)
    return service.build_item(db, flow, user, token)


@router.delete("/{reference}", status_code=status.HTTP_204_NO_CONTENT)
def delete_flow(
    purge: bool = Query(False, description="removes for good, with versions and attachments"),
    flow: Flow = Depends(access.RequireFlow("full", include_deleted=True)),
    db: Session = Depends(get_db),
):
    if purge:
        # Keep the paths before the cascade, so the volume can be cleaned after.
        paths = [a.storage_path for a in flow.assets]
        db.delete(flow)
        db.flush()
        for relative in paths:
            storage.remove_if_orphan(db, relative)
        db.commit()
    else:
        if flow.deleted_at is None:
            flow.deleted_at = datetime.now(timezone.utc)
            db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{reference}/restore", response_model=FlowListItem)
def restore_flow(
    flow: Flow = Depends(access.RequireFlow("full", include_deleted=True)),
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
):
    """Takes the flow out of the trash."""
    if flow.deleted_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "flow is not in the trash")
    flow.deleted_at = None
    db.commit()
    db.refresh(flow)
    return service.build_item(db, flow, user)


@router.get("/{reference}/export")
def export_flow(
    version: int | None = Query(None, description="version to export; defaults to the current one"),
    flow: Flow = Depends(access.RequireFlow("view")),
    db: Session = Depends(get_db),
):
    """Downloads the JSON in the same format the "JSON (download)" button
    produces."""
    graph = (
        service.get_version(db, flow, version).graph
        if version is not None
        else service.build_detail(db, flow).graph
    )
    body = json.dumps(graph, ensure_ascii=False, indent=2)
    return Response(
        content=body,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{flow.slug}.json"'},
    )
