"""Writing attachments to the volume, addressed by content.

A file is stored as <sha256>.<ext> under two levels of fanout (ab/cd/...),
which keeps directories from holding thousands of entries and deduplicates
identical uploads.
"""
import hashlib
from pathlib import Path

from .config import settings

_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/svg+xml": ".svg",
    "application/json": ".json",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
}


def extension_for(content_type: str, filename: str) -> str:
    if content_type in _EXTENSIONS:
        return _EXTENSIONS[content_type]
    suffix = Path(filename).suffix.lower()
    return suffix if 1 < len(suffix) <= 8 else ".bin"


def store(content: bytes, content_type: str, filename: str) -> tuple[str, str]:
    """Writes the content and returns `(relative_path, sha256)`.

    Content already on disk is reused instead of written again.
    """
    digest = hashlib.sha256(content).hexdigest()
    relative = f"{digest[:2]}/{digest[2:4]}/{digest}{extension_for(content_type, filename)}"
    target = settings.storage_dir / relative
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temporary file, then rename: an interrupted upload must not
        # leave a truncated file sitting where a valid sha256 should be.
        temporary = target.with_suffix(target.suffix + ".partial")
        temporary.write_bytes(content)
        temporary.replace(target)
    return relative, digest


def path_for(relative: str) -> Path:
    return settings.storage_dir / relative


def remove_if_orphan(db, relative: str) -> None:
    """Deletes the file from disk when no flow_assets row references it."""
    from sqlalchemy import select

    from .models import FlowAsset

    still_used = db.execute(
        select(FlowAsset.id).where(FlowAsset.storage_path == relative).limit(1)
    ).first()
    if still_used:
        return
    target = path_for(relative)
    if target.exists():
        target.unlink()
