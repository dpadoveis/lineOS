"""The catalog of real objects the collector found.

Read-only through the API: the collector writes this table straight to
Postgres. `?unbound=true` is the row that matters on the home screen -- the
objects that are running while nobody watches them.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import access
from ..database import get_db
from ..models import User
from ..models_ops import InventoryObject, PipelineBinding
from ..schemas_ops import InventoryItem, InventoryList

router = APIRouter(prefix="/inventory", tags=["inventory"])


@router.get("", response_model=InventoryList)
def list_inventory(
    kind: str | None = Query(None, description="airflow_dag, cron_job or table"),
    unbound: bool = Query(False, description="only objects nobody is watching"),
    db: Session = Depends(get_db),
    user: User = Depends(access.current_user),
) -> InventoryList:
    watchers = (
        select(PipelineBinding.object_id, func.count().label("n"))
        .group_by(PipelineBinding.object_id)
        .subquery()
    )
    stmt = (
        select(InventoryObject, func.coalesce(watchers.c.n, 0))
        .outerjoin(watchers, watchers.c.object_id == InventoryObject.id)
        .order_by(InventoryObject.kind, InventoryObject.display_name)
    )
    if kind:
        stmt = stmt.where(InventoryObject.kind == kind)
    if unbound:
        stmt = stmt.where(watchers.c.n.is_(None))
    items = []
    for obj, n in db.execute(stmt).all():
        item = InventoryItem.model_validate(obj)
        item.watchers = n
        items.append(item)
    return InventoryList(items=items)
