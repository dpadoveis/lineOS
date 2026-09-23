"""Sign up, sign in, sign out.

Who may sign up is `settings.registration` (open, invite or closed); the first
account on a server always may, and becomes its admin -- that is the first-run
setup. Under "invite", the invitation is a live share link: whoever received a
diagram by link or by email can create an account, nobody else can. The
session is an httpOnly cookie holding an opaque token -- no JWT, nothing
readable by page scripts, and revoking it is a DELETE on one row.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import access, mailer
from ..config import settings
from ..database import get_db
from ..models import User
from ..schemas import LoginRequest, PasswordChange, RegisterRequest, SessionInfo, UserItem
from ..security import hash_password, verify_password

logger = logging.getLogger("flow.auth")

router = APIRouter(prefix="/auth", tags=["auth"])


def registration_state(db: Session) -> str:
    """`first_run` while the server has no account, else the configured policy."""
    if db.execute(select(User.id).limit(1)).first() is None:
        return "first_run"
    return settings.registration


def _session_info(db: Session, user: User | None) -> SessionInfo:
    return SessionInfo(
        user=UserItem.model_validate(user) if user else None,
        smtp_ready=mailer.configured(),
        registration=registration_state(db),
    )


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        settings.session_cookie,
        token,
        max_age=settings.session_days * 24 * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )


@router.post("/register", response_model=SessionInfo, status_code=status.HTTP_201_CREATED)
def register(data: RegisterRequest, response: Response, db: Session = Depends(get_db)):
    policy = registration_state(db)
    if policy == "closed":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "registration is closed on this server")
    if policy == "invite" and access.live_link(db, data.invite) is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "registration needs an invitation -- open a diagram someone shared with you first",
        )

    email = data.email.strip().lower()
    existing = db.execute(select(User).where(func.lower(User.email) == email)).first()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "an account with this email already exists")

    user = User(
        email=email,
        name=data.name.strip(),
        password_hash=hash_password(data.password),
        is_admin=policy == "first_run",
    )
    db.add(user)
    db.flush()

    # Flows created before accounts existed have no owner and would be invisible
    # to everyone; the first account to appear adopts them. Later registrations
    # find nothing left to adopt.
    adopted = access.adopt_orphan_flows(db, user)
    if adopted:
        logger.info("%s adopted %d ownerless flow(s)", user.email, adopted)

    token = access.open_session(db, user)
    db.commit()
    db.refresh(user)
    _set_cookie(response, token)
    return _session_info(db, user)


@router.post("/login", response_model=SessionInfo)
def login(data: LoginRequest, response: Response, db: Session = Depends(get_db)):
    email = data.email.strip().lower()
    user = db.execute(select(User).where(func.lower(User.email) == email)).scalar_one_or_none()
    # Same answer for "no such account" and "wrong password": telling them apart
    # turns the login form into an account-enumeration oracle.
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "email or password is incorrect")
    token = access.open_session(db, user)
    db.commit()
    db.refresh(user)
    _set_cookie(response, token)
    return _session_info(db, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    access.close_session(db, request.cookies.get(settings.session_cookie))
    db.commit()
    response.delete_cookie(settings.session_cookie, path="/")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/password", response_model=SessionInfo)
def change_password(
    data: PasswordChange,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user: User = Depends(access.current_user),
):
    """Changes the password of one's own account.

    Every old session is closed -- changing a password exists precisely to throw
    out whoever should not be inside -- and a new one is opened for whoever did
    the change, so the current tab does not drop to the login screen midway.
    """
    if not verify_password(data.current_password, user.password_hash):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "the current password is incorrect")
    if data.new_password == data.current_password:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "the new password must be different")

    user.password_hash = hash_password(data.new_password)
    access.close_all_sessions(db, user)
    token = access.open_session(db, user)
    db.commit()
    db.refresh(user)
    _set_cookie(response, token)
    return _session_info(db, user)


@router.get("/me", response_model=SessionInfo)
def me(db: Session = Depends(get_db), user: User | None = Depends(access.current_user_optional)):
    """Called on boot. Answers 200 with `user: null` when nobody is signed in --
    not 401, because "no session yet" is the normal first visit."""
    return _session_info(db, user)
