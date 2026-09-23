from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import access, service
from ..database import get_db
from ..models import Flow, FlowVersion, User
from ..schemas import VersionCreate, VersionDetail, VersionListItem

router = APIRouter(prefix="/flows", tags=["versions"])


@router.get("/{reference}/versions", response_model=list[VersionListItem])
def list_versions(
    flow: Flow = Depends(access.RequireFlow("view")),
    db: Session = Depends(get_db),
):
    """The flow's history, newest first, without the graphs."""
    stmt = (
        select(FlowVersion)
        .where(FlowVersion.flow_id == flow.id)
        .order_by(FlowVersion.version.desc())
    )
    return list(db.execute(stmt).scalars())


@router.put("/{reference}/versions", response_model=VersionDetail, status_code=status.HTTP_201_CREATED)
def save_version(
    data: VersionCreate,
    flow: Flow = Depends(access.RequireFlow("edit")),
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
):
    """Writes a new version. 409 when `base_version` is not the current one."""
    version = service.create_version(
        db, flow, data.graph, data.note, data.base_version, author=user.name if user else None
    )
    db.commit()
    db.refresh(version)
    return version


@router.get("/{reference}/versions/{number}", response_model=VersionDetail)
def open_version(
    number: int,
    flow: Flow = Depends(access.RequireFlow("view")),
    db: Session = Depends(get_db),
):
    return service.get_version(db, flow, number)


@router.post(
    "/{reference}/versions/{number}/restore",
    response_model=VersionDetail,
    status_code=status.HTTP_201_CREATED,
)
def restore_version(
    number: int,
    flow: Flow = Depends(access.RequireFlow("edit")),
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
):
    """Goes back to an old state by creating a NEW version with that graph.

    The history stays immutable: nothing is deleted or rewritten, a version is
    only appended whose content is a copy of version `number`.
    """
    old = service.get_version(db, flow, number)
    new = service.create_version(
        db,
        flow,
        old.graph,
        note=f"restored from version {number}",
        base_version=None,
        author=user.name if user else None,
    )
    db.commit()
    db.refresh(new)
    return new
