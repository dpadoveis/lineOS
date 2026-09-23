from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import get_db

router = APIRouter(tags=["health"])


@router.get("/health")
def health(db: Session = Depends(get_db)) -> dict:
    """API liveness plus a ping on Postgres (used by the compose healthcheck)."""
    db.execute(text("SELECT 1"))
    return {"status": "ok", "database": "ok"}
