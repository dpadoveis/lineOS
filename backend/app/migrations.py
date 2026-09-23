"""Light, idempotent migrations, run at startup AFTER create_all.

`Base.metadata.create_all` only CREATES missing tables -- it never alters an
existing one. Every schema change against an already populated database goes
here as an IF EXISTS / IF NOT EXISTS statement, safe to run N times and a no-op
on a fresh database.

Until the project adopts Alembic (see docs/BACKEND.md), this is the migration
mechanism.
"""
import logging

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger("flow.migrations")

_STATEMENTS: list[str] = [
    # Accounts: `flows` already existed without an owner. The column arrives
    # nullable and the first registration adopts the orphans
    # (access.adopt_orphan_flows), so no flow created before accounts existed
    # becomes unreachable.
    "ALTER TABLE flows ADD COLUMN IF NOT EXISTS owner_id BIGINT",
    """
    DO $$ BEGIN
      ALTER TABLE flows
        ADD CONSTRAINT fk_flows_owner
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
    """,
    "CREATE INDEX IF NOT EXISTS ix_flows_owner_id ON flows (owner_id)",
    # Editing a built-in tool materialises it as a row that stands for it, and
    # `hidden` is how a built-in leaves the catalog. Both arrive on a table
    # that already holds the tools registered from scratch, where they are
    # null / false.
    "ALTER TABLE custom_tools ADD COLUMN IF NOT EXISTS builtin VARCHAR(80)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_tools_builtin ON custom_tools (builtin)",
    "ALTER TABLE custom_tools ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false",
    # The asset kind used to be the Portuguese 'anexo'. Rows are rewritten
    # first, then the CHECK constraint that still allows the old value is
    # replaced -- doing it the other way round would reject the UPDATE.
    "ALTER TABLE flow_assets DROP CONSTRAINT IF EXISTS ck_flow_assets_kind",
    "UPDATE flow_assets SET kind = 'attachment' WHERE kind = 'anexo'",
    """
    DO $$ BEGIN
      ALTER TABLE flow_assets
        ADD CONSTRAINT ck_flow_assets_kind CHECK (kind IN ('png', 'attachment'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
    """,
]


def apply(engine: Engine) -> None:
    """Runs each statement on its own; one failure does not stop startup."""
    for sql in _STATEMENTS:
        try:
            with engine.begin() as conn:
                conn.execute(text(sql))
        except Exception:  # noqa: BLE001 -- a migration must never block boot
            logger.exception("Migration failed and was skipped: %s", sql)
