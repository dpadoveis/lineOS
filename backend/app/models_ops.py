"""Pipeline Ops tables: what exists out there, and what somebody is watching.

Split from models.py deliberately (see docs/superpowers/specs/
2026-09-18-pipeline-ops-module-design.md §12): this module is additive, so the
eventual pull request upstream touches as few existing files as it can.

The split by writer matters more than the split by file. `inventory_objects`,
`object_runs` and `object_checks` are machine telemetry, written by the
collector straight to Postgres under a restricted role. `pipelines` and
`pipeline_bindings` are human configuration and are written only through the
API. A bug in the collector can corrupt telemetry, which is re-collectable; it
must not be able to reach configuration, which is not.
"""
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base
from .models import Flow

# What the collector can discover. Plain strings checked by a CHECK constraint,
# like PERMISSIONS in models.py, so adding a kind is a migration and not a type
# change.
OBJECT_KINDS = ("airflow_dag", "cron_job", "table")
# `skipped` is not a nicety: the multi-source job's flock can skip a run entirely,
# and a mirror's checksum guard exits 0 having deliberately loaded
# nothing. Without this value both read as a false green or a false red.
RUN_OUTCOMES = ("running", "success", "failed", "skipped", "unknown")


class InventoryObject(Base):
    """One real thing the collector found: a DAG, a cron job, a table.

    Never deleted when it disappears from its source -- `last_seen_at` simply
    stops advancing, and the panel reports "missing from its source for 6 days",
    which is information rather than an error.
    """

    __tablename__ = "inventory_objects"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # Which Airflow, which host, which database -- two instances can hold a DAG
    # of the same name without colliding.
    source: Mapped[str] = mapped_column(String(120), nullable=False)
    # dag_id, job id, or 'schema.table'.
    external_id: Mapped[str] = mapped_column(String(300), nullable=False)
    display_name: Mapped[str] = mapped_column(String(300), nullable=False)
    # Schedule, paused flag, cron expression. Free-form because each kind
    # carries different facts and none of them is queried relationally.
    attrs: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("kind", "source", "external_id", name="uq_inventory_objects_identity"),
        CheckConstraint(
            "kind IN ('airflow_dag', 'cron_job', 'table')", name="ck_inventory_objects_kind"
        ),
    )


class ObjectRun(Base):
    """One execution. Append-only, and idempotent by (object_id, run_key).

    The collector runs every five minutes over an overlapping window; the unique
    constraint is what lets it re-report a run it has already seen. ON CONFLICT
    DO UPDATE finishes a run that was still `running` and never duplicates one
    that already ended, so a missed cycle recovers on the next one with no
    special handling.
    """

    __tablename__ = "object_runs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    object_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("inventory_objects.id", ondelete="CASCADE"), nullable=False
    )
    # dag_run.run_id, or the heartbeat's start stamp for a cron job.
    run_key: Mapped[str] = mapped_column(String(300), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    outcome: Mapped[str] = mapped_column(String(16), nullable=False)
    # The RAW code. Translating it is the binding's job (rules.exit_code_map):
    # the multi-source job means 1=source A failed, 2=source B failed, 3=both, and
    # flattening that to "failed" erases what its wrapper went to the trouble
    # of producing.
    exit_code: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    # Business metrics a job chose to publish: e.g. rows_synced.
    facts: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    collected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("object_id", "run_key", name="uq_object_runs_object_key"),
        CheckConstraint(
            "outcome IN ('running', 'success', 'failed', 'skipped', 'unknown')",
            name="ck_object_runs_outcome",
        ),
        Index("ix_object_runs_object_started", "object_id", "started_at"),
    )


class ObjectCheck(Base):
    """One freshness reading of a bound table. Append-only."""

    __tablename__ = "object_checks"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    object_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("inventory_objects.id", ondelete="CASCADE"), nullable=False
    )
    checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    row_count: Mapped[int | None] = mapped_column(BigInteger)
    # max(rules.freshness_column). Temporal only in this slice: mirrors that
    # watermark on a non-temporal column (bronze.stg_table_* advances on
    # r_e_c_n_o_) get no freshness rule, and take their health from the job
    # that feeds them.
    max_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (Index("ix_object_checks_object_checked", "object_id", "checked_at"),)


class Pipeline(Base):
    """A diagram promoted to something watched.

    It follows the flow's CURRENT version, never a pinned one and never the
    draft: an ops view must not freeze on an old drawing, and must not follow
    somebody's half-finished edit. Bindings anchor on node uid, which survives
    editing, so a node that survives keeps its binding.
    """

    __tablename__ = "pipelines"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    slug: Mapped[str] = mapped_column(String(140), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    flow_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("flows.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    flow: Mapped[Flow] = relationship()
    bindings: Mapped[list["PipelineBinding"]] = relationship(
        back_populates="pipeline", cascade="all, delete-orphan", passive_deletes=True
    )

    __table_args__ = (Index("ix_pipelines_flow_id", "flow_id"),)


class PipelineBinding(Base):
    """A node of the diagram, bound to a real object.

    RESTRICT on object_id, so the inventory can never remove something somebody
    is watching.
    """

    __tablename__ = "pipeline_bindings"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    pipeline_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("pipelines.id", ondelete="CASCADE"), nullable=False
    )
    node_uid: Mapped[str] = mapped_column(String(64), nullable=False)
    object_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("inventory_objects.id", ondelete="RESTRICT"), nullable=False
    )
    # sla_minutes, exit_code_map, freshness_column, max_age_minutes,
    # may_be_static. Read by app/health.py.
    rules: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    pipeline: Mapped[Pipeline] = relationship(back_populates="bindings")
    obj: Mapped[InventoryObject] = relationship()

    __table_args__ = (
        UniqueConstraint("pipeline_id", "node_uid", name="uq_pipeline_bindings_node"),
    )


class ObjectEdge(Base):
    """A declared edge between two objects in the pipeline graph.

    Never deleted when the edge disappears from its source -- `last_seen_at`
    simply stops advancing. Edges are always append-only telemetry.
    """

    __tablename__ = "object_edges"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    from_object_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("inventory_objects.id", ondelete="CASCADE"), nullable=False
    )
    to_object_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("inventory_objects.id", ondelete="CASCADE"), nullable=False
    )
    # 'heartbeat' or 'airflow_dataset'
    declared_by: Mapped[str] = mapped_column(String(24), nullable=False)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "from_object_id", "to_object_id", "declared_by", name="uq_object_edges_identity"
        ),
        CheckConstraint(
            "declared_by IN ('heartbeat', 'airflow_dataset')",
            name="ck_object_edges_declared_by",
        ),
        Index("ix_object_edges_from", "from_object_id"),
        Index("ix_object_edges_to", "to_object_id"),
    )
