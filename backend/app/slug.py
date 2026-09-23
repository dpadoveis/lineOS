"""Slug generation from a flow name (strips accents, so names typed in any
language collapse to a plain ASCII path segment)."""
import re
import unicodedata

from sqlalchemy import select
from sqlalchemy.orm import Session

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    ascii_only = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    base = _NON_ALNUM.sub("-", ascii_only.lower()).strip("-")
    return (base or "flow")[:120]


def unique_slug(db: Session, text: str, ignore_id: int | None = None) -> str:
    """A slug free in the database, appending -2, -3... on collision.

    Trashed flows count too: the slug of a deleted flow stays taken, so
    restoring it never collides.
    """
    from .models import Flow

    base = slugify(text)
    candidate = base
    n = 1
    while True:
        stmt = select(Flow.id).where(Flow.slug == candidate)
        if ignore_id is not None:
            stmt = stmt.where(Flow.id != ignore_id)
        if db.execute(stmt).first() is None:
            return candidate
        n += 1
        suffix = f"-{n}"
        candidate = f"{base[: 120 - len(suffix)]}{suffix}"
