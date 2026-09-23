"""Finding an account to share a flow with.

Deliberately narrow: it answers only to a signed-in caller, needs at least three
characters, and returns at most ten rows. Sharing needs a way to reach the other
person, but the user table must not double as a directory anyone can page
through.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import access
from ..database import get_db
from ..models import User
from ..schemas import UserItem

router = APIRouter(prefix="/users", tags=["users"])

MIN_QUERY = 3
MAX_RESULTS = 10


@router.get("", response_model=list[UserItem])
def search_users(
    q: str = Query("", description="name or email fragment, at least 3 characters"),
    db: Session = Depends(get_db),
    me: User = Depends(access.current_user),
):
    needle = q.strip().lower()
    if len(needle) < MIN_QUERY:
        return []
    stmt = (
        select(User)
        .where(
            User.id != me.id,
            or_(
                func.lower(User.email).like(f"%{needle}%"),
                func.lower(User.name).like(f"%{needle}%"),
            ),
        )
        .order_by(User.name)
        .limit(MAX_RESULTS)
    )
    return list(db.execute(stmt).scalars())
