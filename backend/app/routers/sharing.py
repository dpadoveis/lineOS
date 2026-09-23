"""Sharing a flow: with a person, by link, or by email.

The three options the Share menu offers are three ways of writing the same two
tables -- `flow_shares` (an account) and `flow_share_links` (a URL) -- and every
one of them carries a permission level: `view`, `edit` or `full` (full control).

Managing shares needs full control on the flow, which the owner always has. That
is why sharing is not self-service: someone given `edit` can work on the diagram
but cannot hand it to a fourth person.
"""
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import access, mailer
from ..config import settings
from ..database import get_db
from ..models import Flow, FlowShare, FlowShareLink, User
from ..schemas import (
    ShareEmail,
    ShareEmailResult,
    ShareItem,
    ShareLinkCreate,
    ShareLinkItem,
    SharePatch,
    ShareWithUser,
    SharingState,
)
from ..security import new_token, token_hash

router = APIRouter(prefix="/shares", tags=["sharing"])

# Managing who else can see the flow is itself a full-control action.
_manager = access.RequireFlow("full")


def _share_items(db: Session, flow: Flow) -> list[ShareItem]:
    rows = db.execute(
        select(FlowShare, User)
        .join(User, User.id == FlowShare.user_id)
        .where(FlowShare.flow_id == flow.id)
        .order_by(User.name)
    ).all()
    return [
        ShareItem(
            id=share.id,
            user_id=user.id,
            name=user.name,
            email=user.email,
            permission=share.permission,
            created_at=share.created_at,
        )
        for share, user in rows
    ]


def _link_items(db: Session, flow: Flow) -> list[ShareLinkItem]:
    rows = db.execute(
        select(FlowShareLink)
        .where(FlowShareLink.flow_id == flow.id, FlowShareLink.revoked.is_(False))
        .order_by(FlowShareLink.created_at.desc())
    ).scalars()
    return [ShareLinkItem.model_validate(link) for link in rows]


def _share_url(flow: Flow, token: str, base_url: str | None = None) -> str:
    """The link the other person opens. Hash routing keeps it a pure SPA URL --
    nginx never has to know about /flow/... paths."""
    # A base carrying "{token}" is a full link template (the Data Lineage screen
    # sends one, so the email lands on the lineage instead of the editor).
    if base_url and "{token}" in base_url:
        return base_url.replace("{token}", quote(token))
    base = (base_url or settings.public_base_url or "/").rstrip("/")
    return f"{base}/#/share/{quote(token)}"


class OpenedLink(BaseModel):
    """What the SPA needs to open a pasted link: which flow it is, and at what
    permission. The token keeps travelling on every request after that."""

    flow_id: int
    slug: str
    name: str
    permission: str


@router.get("/open/{token}", response_model=OpenedLink)
def open_link(
    token: str,
    db: Session = Depends(get_db),
    user: User | None = Depends(access.current_user_optional),
):
    """Resolves a link token. No account required -- that is the point of a link.

    While signed in, the visit also becomes a real share, so the flow starts
    showing up on the homepage of whoever received the link.
    """
    flow = access.flow_by_token(db, token)
    if flow is None or flow.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "this link is invalid or was revoked")
    permission = access.permission_for(db, flow, user, token)
    if permission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "this link is invalid or was revoked")
    access.attach_link_share(db, flow, user, token)
    return OpenedLink(flow_id=flow.id, slug=flow.slug, name=flow.name, permission=permission)


@router.get("/{reference}", response_model=SharingState)
def sharing_state(
    flow: Flow = Depends(_manager),
    db: Session = Depends(get_db),
    me: User = Depends(access.current_user),
):
    """Everything the Share dropdown needs for one flow."""
    return SharingState(
        flow_id=flow.id,
        flow_name=flow.name,
        permission="full",
        is_owner=access.is_owner(flow, me),
        owner_name=flow.owner.name if flow.owner else None,
        shares=_share_items(db, flow),
        links=_link_items(db, flow),
        smtp_ready=mailer.configured(),
    )


@router.post("/{reference}/users", response_model=ShareItem, status_code=status.HTTP_201_CREATED)
def share_with_user(
    data: ShareWithUser,
    flow: Flow = Depends(_manager),
    db: Session = Depends(get_db),
    me: User = Depends(access.current_user),
):
    """Shares with an existing account. Re-sharing updates the level instead of
    creating a second row."""
    email = data.email.strip().lower()
    target = db.execute(select(User).where(func.lower(User.email) == email)).scalar_one_or_none()
    if target is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "no account with this email — ask them to sign up, or share a link instead",
        )
    if flow.owner_id == target.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "this person already owns the flow")

    share = db.execute(
        select(FlowShare).where(FlowShare.flow_id == flow.id, FlowShare.user_id == target.id)
    ).scalar_one_or_none()
    if share is None:
        share = FlowShare(
            flow_id=flow.id, user_id=target.id, permission=data.permission, created_by=me.id
        )
        db.add(share)
    else:
        share.permission = data.permission
    db.commit()
    db.refresh(share)
    return ShareItem(
        id=share.id,
        user_id=target.id,
        name=target.name,
        email=target.email,
        permission=share.permission,
        created_at=share.created_at,
    )


@router.patch("/{reference}/users/{share_id}", response_model=ShareItem)
def change_permission(
    share_id: int,
    data: SharePatch,
    flow: Flow = Depends(_manager),
    db: Session = Depends(get_db),
):
    share = db.get(FlowShare, share_id)
    if share is None or share.flow_id != flow.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "share not found")
    share.permission = data.permission
    db.commit()
    user = db.get(User, share.user_id)
    return ShareItem(
        id=share.id,
        user_id=user.id,
        name=user.name,
        email=user.email,
        permission=share.permission,
        created_at=share.created_at,
    )


@router.delete("/{reference}/users/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_share(
    share_id: int,
    flow: Flow = Depends(_manager),
    db: Session = Depends(get_db),
):
    share = db.get(FlowShare, share_id)
    if share is None or share.flow_id != flow.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "share not found")
    db.delete(share)
    db.commit()
    return None


@router.post("/{reference}/links", response_model=ShareLinkItem, status_code=status.HTTP_201_CREATED)
def create_link(
    data: ShareLinkCreate,
    flow: Flow = Depends(_manager),
    db: Session = Depends(get_db),
    me: User = Depends(access.current_user),
):
    """Creates a link at one permission level.

    The raw token comes back exactly once -- only its sha256 is stored -- so the
    editor copies it to the clipboard right away.
    """
    token = new_token()
    expires = (
        datetime.now(timezone.utc) + timedelta(days=data.expires_days)
        if data.expires_days
        else None
    )
    link = FlowShareLink(
        flow_id=flow.id,
        token_hash=token_hash(token),
        permission=data.permission,
        label=data.label,
        created_by=me.id,
        expires_at=expires,
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    item = ShareLinkItem.model_validate(link)
    item.token = token
    return item


@router.delete("/{reference}/links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_link(
    link_id: int,
    flow: Flow = Depends(_manager),
    db: Session = Depends(get_db),
):
    """Revokes instead of deleting: the row stays as the record that the link
    existed, and every copy of it stops working at once."""
    link = db.get(FlowShareLink, link_id)
    if link is None or link.flow_id != flow.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "link not found")
    link.revoked = True
    db.commit()
    return None


@router.post("/{reference}/email", response_model=ShareEmailResult)
def share_by_email(
    data: ShareEmail,
    flow: Flow = Depends(_manager),
    db: Session = Depends(get_db),
    me: User = Depends(access.current_user),
):
    """Creates a link at the chosen level and mails it.

    Always returns the URL and a ready `mailto:`, so a server without SMTP still
    lets the editor open the visitor's own mail client instead of failing.
    """
    token = new_token()
    link = FlowShareLink(
        flow_id=flow.id,
        token_hash=token_hash(token),
        permission=data.permission,
        label=f"email to {data.to}",
        created_by=me.id,
    )
    db.add(link)
    db.commit()

    url = _share_url(flow, token, data.base_url)
    levels = {"view": "view it", "edit": "view and edit it", "full": "edit and share it"}
    body = (
        f"{me.name} shared the diagram \"{flow.name}\" with you on lineOS.\n\n"
        f"{('Message: ' + data.message) if data.message else ''}"
        f"\n\nOpen it here:\n{url}\n\n"
        f"This link lets you {levels.get(data.permission, 'view it')}. "
        "Anyone holding it gets the same access, so pass it on carefully.\n"
    )
    subject = f'"{flow.name}" was shared with you'

    mailto = (
        f"mailto:{quote(data.to)}?subject={quote(subject)}&body={quote(body)}"
    )
    if not mailer.configured():
        # 200 with sent=false: the client falls back to `mailto`, which is a
        # working path, not an error.
        return ShareEmailResult(sent=False, to=data.to, url=url, mailto=mailto)
    mailer.send(data.to, subject, body)
    return ShareEmailResult(sent=True, to=data.to, url=url, mailto=mailto)
