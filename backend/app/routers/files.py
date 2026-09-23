from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import access, storage
from ..config import settings
from ..database import get_db
from ..models import PERMISSION_RANK, Flow, FlowAsset, User
from ..schemas import AssetItem

router = APIRouter(tags=["files"])

_ACCEPTED_TYPES = {
    "image/png",
    "image/jpeg",
    "image/svg+xml",
    "application/json",
    "application/pdf",
    "text/plain",
}

KINDS = ("png", "attachment")


def _allowed_asset(
    asset_id: int,
    minimum: str,
    db: Session,
    user: User | None,
    token: str | None,
) -> FlowAsset:
    """An asset addressed by its own id: the permission comes from the flow it
    belongs to, or any id would leak someone else's content."""
    asset = db.get(FlowAsset, asset_id)
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "file not found")
    flow = db.get(Flow, asset.flow_id)
    level = access.permission_for(db, flow, user, token) if flow else None
    if level is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "file not found")
    if PERMISSION_RANK.get(level, 0) < PERMISSION_RANK[minimum]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"'{minimum}' is required")
    return asset


@router.get("/flows/{reference}/files", response_model=list[AssetItem])
def list_files(flow: Flow = Depends(access.RequireFlow("view"))):
    return sorted(flow.assets, key=lambda a: a.created_at, reverse=True)


@router.post(
    "/flows/{reference}/files", response_model=AssetItem, status_code=status.HTTP_201_CREATED
)
async def upload_file(
    file: UploadFile = File(...),
    kind: str = Form("attachment"),
    flow_version: int | None = Form(None),
    flow: Flow = Depends(access.RequireFlow("edit")),
    db: Session = Depends(get_db),
):
    """Takes the PNG the editor exported, or any other attachment of the flow."""
    if kind not in KINDS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "kind must be 'png' or 'attachment'"
        )

    content = await file.read()
    limit = settings.max_upload_mb * 1024 * 1024
    if not content:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "empty file")
    if len(content) > limit:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"file above {settings.max_upload_mb} MB",
        )

    content_type = file.content_type or "application/octet-stream"
    if content_type not in _ACCEPTED_TYPES:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, f"type not accepted: {content_type}"
        )

    relative, digest = storage.store(content, content_type, file.filename or "file")
    asset = FlowAsset(
        flow_id=flow.id,
        flow_version=flow_version if flow_version is not None else flow.current_version,
        kind=kind,
        filename=file.filename or f"{flow.slug}.png",
        content_type=content_type,
        size_bytes=len(content),
        sha256=digest,
        storage_path=relative,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset


@router.get("/files/{asset_id}")
def download_file(
    asset_id: int,
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
):
    asset = _allowed_asset(asset_id, "view", db, user, token)
    target = storage.path_for(asset.storage_path)
    if not target.exists():
        # Metadata without content: the volume was recreated without the database.
        raise HTTPException(status.HTTP_410_GONE, "content missing from the files volume")
    return FileResponse(
        target,
        media_type=asset.content_type,
        filename=asset.filename,
    )


@router.delete("/files/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_file(
    asset_id: int,
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
    token: str | None = Depends(access.share_token_header),
):
    asset = _allowed_asset(asset_id, "edit", db, user, token)
    relative = asset.storage_path
    db.delete(asset)
    db.flush()
    storage.remove_if_orphan(db, relative)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
