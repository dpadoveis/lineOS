"""DTOs for the Data Lineage routes."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class InventoryItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    source: str
    external_id: str
    display_name: str
    attrs: dict
    first_seen_at: datetime
    last_seen_at: datetime
    # How many bindings point at this object; 0 means nobody is watching it.
    watchers: int = 0


class InventoryList(BaseModel):
    items: list[InventoryItem]


class PipelineCreate(BaseModel):
    # Flow id or slug, the same reference the flows routes accept.
    # If None, an empty flow is created with the pipeline's name.
    flow: str | None = None
    name: str = Field(min_length=1, max_length=160)


class BindingWrite(BaseModel):
    object_id: int
    # sla_minutes, exit_code_map, freshness_column, max_age_minutes,
    # may_be_static. Validated by app/health.py at read time, not here: a rule
    # the rules engine ignores is inert, and refusing it would make adding a
    # rule a schema migration.
    rules: dict = Field(default_factory=dict)


class RunItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    run_key: str
    started_at: datetime
    ended_at: datetime | None = None
    outcome: str
    exit_code: int | None = None
    duration_ms: int | None = None
    facts: dict


class CheckItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    checked_at: datetime
    row_count: int | None = None
    max_ts: datetime | None = None
    ok: bool
    error: str | None = None


# Defined BEFORE BindingItem, which holds one: a forward reference would need
# model_rebuild() and there is no reason to owe that.
class HealthItem(BaseModel):
    state: str
    reason: str
    since: datetime | None = None


class ExpectedItem(BaseModel):
    next_at: datetime
    late_after: datetime


class BindingItem(BaseModel):
    node_uid: str
    object: InventoryItem
    rules: dict
    health: HealthItem | None = None
    # The newest telemetry behind `health`, so the screen can say "3 h ago ·
    # 42 s" instead of parsing `reason`. Null when nothing was collected.
    last_run: RunItem | None = None
    last_check: CheckItem | None = None
    expected: ExpectedItem | None = None
    duration_median_ms: int | None = None


class PipelineNode(BaseModel):
    uid: str
    # What the card shows: the nickname when there is one, else the stack name.
    title: str
    name: str
    category: str
    binding: BindingItem | None = None


class OrphanedBinding(BaseModel):
    node_uid: str
    object: InventoryItem


class PipelineDetail(BaseModel):
    id: int
    slug: str
    name: str
    flow_slug: str
    flow_version: int
    state: str
    # Age of the newest telemetry, in seconds. None when nothing was collected.
    collected_age_s: int | None = None
    nodes: list[PipelineNode]
    orphaned_bindings: list[OrphanedBinding]
    graph: dict
    # Number of declared edges not yet on the diagram.
    pending_edges: int = 0


class PipelineSummary(BaseModel):
    id: int
    slug: str
    name: str
    flow_slug: str
    state: str
    bound: int
    total: int
    collected_age_s: int | None = None


class PipelineList(BaseModel):
    items: list[PipelineSummary]
    # Objects the collector found that no binding points at.
    unwatched: int


class RunList(BaseModel):
    items: list[RunItem]


class NodesCreate(BaseModel):
    object_ids: list[int]


class ColumnInfo(BaseModel):
    name: str
    type: str
    nullable: bool


class SchemaOut(BaseModel):
    columns: list[ColumnInfo]


class PreviewOut(BaseModel):
    columns: list[str]
    rows: list[list[str | None]]
    ordered_by: str | None = None
    direction: str | None = None
    latest: bool
    limit: int


class MostCommon(BaseModel):
    value: str | None
    freq: float


class ColumnStats(BaseModel):
    name: str
    null_frac: float | None = None
    n_distinct: float | None = None
    most_common: list[MostCommon]
    min: str | None = None
    max: str | None = None


class StatsOut(BaseModel):
    row_count: int | None = None
    analyzed_at: datetime | None = None
    columns: list[ColumnStats]


class HistoryPoint(BaseModel):
    checked_at: datetime
    row_count: int | None = None
    ok: bool
    error: str | None = None


class HistoryOut(BaseModel):
    points: list[HistoryPoint]
