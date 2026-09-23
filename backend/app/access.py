"""Accounts, sessions and per-flow permissions.

Three ways to reach a flow, checked in this order:

1. **Owner** -- `flows.owner_id`. Always full control.
2. **Share** -- a `flow_shares` row for the signed-in user, at `view`, `edit`
   or `full`.
3. **Share link** -- a token sent in the `X-Share-Token` header (or `?share=`),
   which grants its own level to whoever holds it, account or not. That is what
   makes a link shareable at all.

The strongest of the three wins, so handing someone a view link never demotes
an editor.
"""
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .config import settings
from .database import get_db
from .models import PERMISSION_RANK, Flow, FlowShare, FlowShareLink, User, UserSession
from .security import new_token, token_hash

# ── Sessions ─────────────────────────────────────────────────────────


def open_session(db: Session, user: User) -> str:
    """Creates a session row and returns the raw token for the cookie."""
    token = new_token()
    db.add(
        UserSession(
            user_id=user.id,
            token_hash=token_hash(token),
            expires_at=datetime.now(timezone.utc) + timedelta(days=settings.session_days),
            last_seen_at=datetime.now(timezone.utc),
        )
    )
    user.last_login_at = datetime.now(timezone.utc)
    db.flush()
    return token


def close_session(db: Session, token: str | None) -> None:
    if not token:
        return
    db.execute(
        UserSession.__table__.delete().where(UserSession.token_hash == token_hash(token))
    )


def close_all_sessions(db: Session, user: User) -> int:
    """Closes every session of the account. Used when the password changes."""
    result = db.execute(
        UserSession.__table__.delete().where(UserSession.user_id == user.id)
    )
    return result.rowcount or 0


def _session_user(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    session = db.execute(
        select(UserSession).where(UserSession.token_hash == token_hash(token))
    ).scalar_one_or_none()
    if session is None:
        return None
    expires = session.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= datetime.now(timezone.utc):
        db.delete(session)
        db.commit()
        return None
    return db.get(User, session.user_id)


def current_user_optional(request: Request, db: Session = Depends(get_db)) -> User | None:
    """The signed-in user, or None. Never raises -- routes open to share links
    depend on this one."""
    return _session_user(db, request.cookies.get(settings.session_cookie))


def current_user(user: User | None = Depends(current_user_optional)) -> User:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in to continue")
    return user


def adopt_orphan_flows(db: Session, user: User) -> int:
    """Hands every ownerless flow to `user`, and returns how many moved.

    Called once, on the first registration: the flows created before accounts
    existed have `owner_id IS NULL` and would otherwise be invisible to
    everyone. Later registrations find nothing to adopt.
    """
    result = db.execute(
        update(Flow).where(Flow.owner_id.is_(None)).values(owner_id=user.id)
    )
    return result.rowcount or 0


# ── Share links ──────────────────────────────────────────────────────


def share_token_header(
    x_share_token: str | None = Header(None, alias="X-Share-Token"),
    share: str | None = Query(None, description="share link token"),
) -> str | None:
    """The link token, from the header the SPA sends or from ?share= (which is
    what a pasted URL carries)."""
    return x_share_token or share


def _link_permission(db: Session, flow_id: int, token: str | None) -> str | None:
    if not token:
        return None
    link = db.execute(
        select(FlowShareLink).where(FlowShareLink.token_hash == token_hash(token))
    ).scalar_one_or_none()
    if link is None or link.flow_id != flow_id or link.revoked:
        return None
    if link.expires_at is not None:
        expires = link.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires <= datetime.now(timezone.utc):
            return None
    return link.permission


def flow_by_token(db: Session, token: str) -> Flow | None:
    """The flow a link token points at -- used to open a pasted link before the
    client knows which flow it is."""
    link = db.execute(
        select(FlowShareLink).where(FlowShareLink.token_hash == token_hash(token))
    ).scalar_one_or_none()
    if link is None or link.revoked:
        return None
    return db.get(Flow, link.flow_id)


# ── Permissions ──────────────────────────────────────────────────────


def permission_for(
    db: Session, flow: Flow, user: User | None, token: str | None = None
) -> str | None:
    """Strongest level this caller has on this flow, or None for no access."""
    levels: list[str] = []
    if user is not None:
        if flow.owner_id is not None and flow.owner_id == user.id:
            return "full"
        share = db.execute(
            select(FlowShare).where(
                FlowShare.flow_id == flow.id, FlowShare.user_id == user.id
            )
        ).scalar_one_or_none()
        if share is not None:
            levels.append(share.permission)
    link = _link_permission(db, flow.id, token)
    if link:
        levels.append(link)
    if not levels:
        return None
    return max(levels, key=lambda p: PERMISSION_RANK.get(p, 0))


def is_owner(flow: Flow, user: User | None) -> bool:
    return user is not None and flow.owner_id is not None and flow.owner_id == user.id


def attach_link_share(db: Session, flow: Flow, user: User | None, token: str | None) -> None:
    """A signed-in visitor opening a share link gets a real share row, so the
    flow appears on their homepage instead of living in the URL.

    Never downgrades: someone who already had `edit` keeps it when they follow a
    view link.
    """
    if user is None or token is None:
        return
    level = _link_permission(db, flow.id, token)
    if not level:
        return
    if is_owner(flow, user):
        return
    share = db.execute(
        select(FlowShare).where(FlowShare.flow_id == flow.id, FlowShare.user_id == user.id)
    ).scalar_one_or_none()
    if share is None:
        db.add(
            FlowShare(
                flow_id=flow.id, user_id=user.id, permission=level, created_by=flow.owner_id
            )
        )
        db.commit()
    elif PERMISSION_RANK.get(level, 0) > PERMISSION_RANK.get(share.permission, 0):
        share.permission = level
        db.commit()


class RequireFlow:
    """Dependency: resolves `{reference}` and refuses below `minimum`.

    Used as `flow: Flow = Depends(RequireFlow("edit"))`. FastAPI caches
    sub-dependencies per request, so the `db` session here is the same one the
    route body gets.
    """

    def __init__(self, minimum: str = "view", include_deleted: bool = False):
        self.minimum = minimum
        self.include_deleted = include_deleted

    def __call__(
        self,
        reference: str,
        db: Session = Depends(get_db),
        user: User | None = Depends(current_user_optional),
        token: str | None = Depends(share_token_header),
    ) -> Flow:
        from . import service  # circular import: service imports nothing from here

        flow = service.get_flow(db, reference, include_deleted=self.include_deleted)
        level = permission_for(db, flow, user, token)
        if level is None:
            # 404, not 403: answering "exists but is not yours" would leak the
            # existence of other people's flows to anyone probing slugs.
            if user is None:
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in to continue")
            raise HTTPException(status.HTTP_404_NOT_FOUND, "flow not found")
        if PERMISSION_RANK.get(level, 0) < PERMISSION_RANK.get(self.minimum, 99):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"this flow is shared with you as '{level}'; '{self.minimum}' is required",
            )
        return flow
