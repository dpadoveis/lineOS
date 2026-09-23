"""Custom tool catalog.

A custom tool is catalog data, not graph data. Adding one to the plane copies
its visual fields into the node, so editing or deleting a tool never rewrites a
stored graph -- only the icon is looked up live, through `NodePayload.tool`.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import bindparam, func, or_, select, text
from sqlalchemy.orm import Session

from .. import access
from ..database import get_db
from ..models import CustomTool, User
from ..schemas import (
    CustomToolCreate,
    CustomToolItem,
    CustomToolPatch,
    ToolUsage,
    ToolUsageFlow,
)
from ..slug import slugify

router = APIRouter(prefix="/tools", tags=["tools"])

# How many diagram names an answer carries. The count is always exact.
USAGE_SAMPLE = 20

# A tool is in use when the CURRENT content of some diagram holds a node made
# from it -- the draft (what the editor shows) or, without one, the last
# version. Older versions are not scanned: they are immutable history, and a
# node whose tool is gone keeps every visual field, losing only the icon
# lookup, so restoring one of them never breaks.
#
# Two ways to match, because a node points at its tool in two ways: a
# registered tool leaves its slug in `tool`, while a node made from a built-in
# has `tool: null` and carries the tool's name in `name` (renaming a node
# writes `label`, never `name`). The names include the built-in this row
# stands for, so nodes dropped before it was edited still count.
_USAGE_SQL = text(
    """
    WITH current_graph AS (
      SELECT f.id,
             f.name,
             f.deleted_at,
             COALESCE(f.draft_graph, (
               SELECT v.graph FROM flow_versions v
               WHERE v.flow_id = f.id
               ORDER BY v.version DESC
               LIMIT 1
             )) AS g
      FROM flows f
    )
    SELECT id, name, (deleted_at IS NOT NULL) AS deleted
    FROM current_graph
    WHERE jsonb_typeof(g -> 'nodes') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(g -> 'nodes') AS n
        WHERE (CAST(:slug AS text) IS NOT NULL AND n ->> 'tool' = CAST(:slug AS text))
           OR (n ->> 'tool' IS NULL AND n ->> 'name' IN :names)
      )
    ORDER BY name
    """
).bindparams(bindparam("names", expanding=True))


def _usage(db: Session, slug: str | None, names: list[str]) -> ToolUsage:
    """Every diagram using the tool. `names` is never empty -- an empty IN list
    would make Postgres reject the statement."""
    rows = db.execute(_USAGE_SQL, {"slug": slug, "names": names or [""]}).all()
    return ToolUsage(
        count=len(rows),
        flows=[
            ToolUsageFlow(id=r.id, name=r.name, deleted=r.deleted)
            for r in rows[:USAGE_SAMPLE]
        ],
    )


def _refuse_if_used(db: Session, slug: str | None, names: list[str]) -> None:
    """A tool leaves the catalog only when no diagram holds it."""
    usage = _usage(db, slug, names)
    if usage.count:
        shown = ", ".join(f.name for f in usage.flows[:3])
        more = f" and {usage.count - 3} more" if usage.count > 3 else ""
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"in use in {usage.count} diagram(s): {shown}{more}",
        )


def _unique_slug(db: Session, name: str, ignore_id: int | None = None) -> str:
    """Free slug for a tool name, appending -2, -3... on collision."""
    base = slugify(name)
    candidate = base
    n = 1
    while True:
        stmt = select(CustomTool.id).where(CustomTool.slug == candidate)
        if ignore_id is not None:
            stmt = stmt.where(CustomTool.id != ignore_id)
        if db.execute(stmt).first() is None:
            return candidate
        n += 1
        suffix = f"-{n}"
        candidate = f"{base[: 140 - len(suffix)]}{suffix}"


def _initials_from(name: str) -> str:
    """Same rule the modal shows as a preview: initials of the first two words,
    or the first two letters of a single word."""
    words = [w for w in name.split() if w]
    if not words:
        return "??"
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[1][0]).upper()


def _get(db: Session, tool_id: int) -> CustomTool:
    tool = db.get(CustomTool, tool_id)
    if tool is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "tool not found")
    return tool


@router.get("", response_model=list[CustomToolItem])
def list_tools(
    q: str | None = Query(None, description="filters by name, category or tags"),
    db: Session = Depends(get_db),
):
    """Every custom tool, newest first -- the sidebar loads this once on start."""
    stmt = select(CustomTool).order_by(CustomTool.created_at.desc())
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(CustomTool.name).like(needle),
                func.lower(CustomTool.category).like(needle),
                func.lower(CustomTool.tags).like(needle),
            )
        )
    return list(db.execute(stmt).scalars())


@router.post("", response_model=CustomToolItem, status_code=status.HTTP_201_CREATED)
def create_tool(
    data: CustomToolCreate,
    db: Session = Depends(get_db),
    user: User = Depends(access.current_user),
):
    if data.builtin:
        taken = db.execute(
            select(CustomTool).where(CustomTool.builtin == data.builtin)
        ).scalar_one_or_none()
        if taken is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f'"{data.builtin}" is already registered — edit it instead',
            )
        # Taking a built-in out of the catalog answers to the same rule as
        # deleting a registered one.
        if data.hidden:
            _refuse_if_used(db, None, [data.builtin, data.name.strip()])
    tool = CustomTool(
        slug=_unique_slug(db, data.name),
        name=data.name.strip(),
        category=data.category.strip().upper(),
        initials=(data.initials or _initials_from(data.name)).strip().upper(),
        color=data.color,
        tags=data.tags.strip(),
        icon=data.icon,
        builtin=data.builtin,
        hidden=data.hidden,
    )
    db.add(tool)
    db.commit()
    db.refresh(tool)
    return tool


@router.patch("/{tool_id}", response_model=CustomToolItem)
def update_tool(
    tool_id: int,
    data: CustomToolPatch,
    db: Session = Depends(get_db),
    user: User = Depends(access.current_user),
):
    """Partial edit. The slug follows the name, so nodes already on a plane keep
    pointing at the tool they were created from."""
    tool = _get(db, tool_id)
    sent = data.model_fields_set
    if data.name is not None and data.name.strip() != tool.name:
        tool.name = data.name.strip()
        tool.slug = _unique_slug(db, tool.name, ignore_id=tool.id)
    if data.category is not None:
        tool.category = data.category.strip().upper()
    if data.initials is not None:
        tool.initials = data.initials.strip().upper()
    if data.color is not None:
        tool.color = data.color
    if data.tags is not None:
        tool.tags = data.tags.strip()
    # Distinguishes "icon omitted" (keep) from "icon: null/empty" (clear).
    if "icon" in sent:
        tool.icon = data.icon
    db.commit()
    db.refresh(tool)
    return tool


@router.get("/usage", response_model=ToolUsage)
def tool_usage(
    slug: str | None = Query(None, description="slug of a registered tool"),
    name: list[str] = Query(default_factory=list, description="tool name(s) to look for"),
    db: Session = Depends(get_db),
    user: User = Depends(access.current_user),
):
    """Which diagrams hold a node made from this tool -- what the editor asks
    before offering to delete it. Answers for a built-in too, which has no row
    and therefore no id: pass its name."""
    return _usage(db, slug, [n.strip() for n in name if n.strip()])


@router.delete("/{tool_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tool(
    tool_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(access.current_user),
):
    """Removes the tool from the catalog, and only from the catalog: nodes
    created from it stay as they are, falling back to their initials once the
    icon is gone. Refused while any diagram still holds one of those nodes.

    A row standing for a built-in is HIDDEN rather than deleted -- deleting it
    would only put the source entry back in the sidebar.
    """
    tool = _get(db, tool_id)
    _refuse_if_used(db, tool.slug, [n for n in (tool.name, tool.builtin) if n])
    if tool.builtin:
        tool.hidden = True
    else:
        db.delete(tool)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
