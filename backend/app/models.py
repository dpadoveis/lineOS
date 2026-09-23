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


"""The editor's tables."""

# Permission levels, weakest to strongest. They are plain strings in the
# database (checked by CHECK constraints) so a new level is a migration, not a
# type change. `full` is "full control": it can share and delete the flow, i.e.
# everything the owner can do except being the owner.
PERMISSIONS = ("view", "edit", "full")
PERMISSION_RANK = {"view": 1, "edit": 2, "full": 3}


class User(Base):
    """An account. Registration is open: anyone reaching the API can create one.

    The password is never stored, only a PBKDF2-SHA256 digest produced by
    `security.hash_password` (the iteration count travels inside the string, so
    raising it later does not invalidate existing hashes).
    """

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Lowercased on the way in: the email is the login, and case must not create
    # a second account.
    email: Mapped[str] = mapped_column(String(254), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    sessions: Mapped[list["UserSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )

    __table_args__ = (Index("ix_users_email", "email"),)


class UserSession(Base):
    """One signed-in browser. The cookie carries the raw token; this table keeps
    only its sha256, so a database dump does not hand over live sessions."""

    __tablename__ = "user_sessions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="sessions")

    __table_args__ = (Index("ix_user_sessions_user_id", "user_id"),)


class Flow(Base):
    """A flow -- the "file" the editor opens and saves.

    Holds metadata and the current draft only; the versioned content lives in
    FlowVersion. `current_version` is the number of the last version written (0
    never happens in practice, since creating a flow already inserts version 1).
    """

    __tablename__ = "flows"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Owner of the flow. Null only for flows created before accounts existed --
    # the first registration adopts them (see access.adopt_orphan_flows).
    owner_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    slug: Mapped[str] = mapped_column(String(140), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    current_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Autosave: overwritten on every draft save, with no history. Only an
    # explicit "Save version" inserts into flow_versions -- without that
    # separation the autosave would produce hundreds of useless versions.
    draft_graph: Mapped[dict | None] = mapped_column(JSONB)
    draft_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    # Trash: DELETE marks this column; ?purge=true really removes the flow.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    versions: Mapped[list["FlowVersion"]] = relationship(
        back_populates="flow", cascade="all, delete-orphan", passive_deletes=True
    )
    assets: Mapped[list["FlowAsset"]] = relationship(
        back_populates="flow", cascade="all, delete-orphan", passive_deletes=True
    )
    owner: Mapped[User | None] = relationship()
    shares: Mapped[list["FlowShare"]] = relationship(
        back_populates="flow", cascade="all, delete-orphan", passive_deletes=True
    )
    share_links: Mapped[list["FlowShareLink"]] = relationship(
        back_populates="flow", cascade="all, delete-orphan", passive_deletes=True
    )

    __table_args__ = (
        Index("ix_flows_deleted_at", "deleted_at"),
        Index("ix_flows_owner_id", "owner_id"),
    )


class FlowVersion(Base):
    """An immutable snapshot of the graph. INSERT and SELECT only -- never
    UPDATE, never DELETE.

    `graph` holds the `flow-graph` payload exactly as the frontend produces it
    in src/flow/payload.js (flowPayload), y axis already inverted, so the
    content returns to the editor identical. (The key order inside each object
    is normalised by jsonb; that is irrelevant to the client, which reads by
    key, and jsonb is what makes the GIN index for tool search possible.)
    """

    __tablename__ = "flow_versions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    flow_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("flows.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    graph: Mapped[dict] = mapped_column(JSONB, nullable=False)
    node_count: Mapped[int] = mapped_column(Integer, nullable=False)
    edge_count: Mapped[int] = mapped_column(Integer, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    author: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    flow: Mapped[Flow] = relationship(back_populates="versions")

    __table_args__ = (
        UniqueConstraint("flow_id", "version", name="uq_flow_versions_flow_version"),
        Index("ix_flow_versions_flow_id", "flow_id"),
        # Answers "which flows use Kafka?" through @> over the graph.
        Index(
            "ix_flow_versions_graph",
            "graph",
            postgresql_using="gin",
            postgresql_ops={"graph": "jsonb_path_ops"},
        ),
    )


class FlowAsset(Base):
    """A binary file attached to a flow: the exported PNG, or any attachment.

    The content lives on the volume (settings.storage_dir); only the metadata
    and the relative path are here. `sha256` deduplicates: two uploads identical
    byte for byte point at the same file on disk.
    """

    __tablename__ = "flow_assets"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    flow_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("flows.id", ondelete="CASCADE"), nullable=False
    )
    # The version this file corresponds to (a PNG is a picture of one version).
    # Not a foreign key: it holds the version number, not the row id.
    flow_version: Mapped[int | None] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    flow: Mapped[Flow] = relationship(back_populates="assets")

    __table_args__ = (
        CheckConstraint("kind IN ('png', 'attachment')", name="ck_flow_assets_kind"),
        Index("ix_flow_assets_flow_id", "flow_id"),
        Index("ix_flow_assets_sha256", "sha256"),
    )


class CustomTool(Base):
    """A tool registered by the user, listed in the editor sidebar alongside the
    built-in catalog (`TOOLS` in src/flow/constants.js).

    Exists so the sidebar is not a dead end when the tool someone needs is not
    in the built-in list. It is catalog data only: dropping a tool on the plane
    copies its visual fields into the node, so deleting the tool later never
    changes a stored graph.

    `icon` holds a small square PNG as a data URL, already downscaled by the
    browser before upload; it is optional, and a tool without one falls back to
    `initials` exactly like a built-in tool. Nodes reference a tool by `slug`
    (see `tool` in NodePayload), never by id.
    """

    __tablename__ = "custom_tools"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    slug: Mapped[str] = mapped_column(String(140), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    initials: Mapped[str] = mapped_column(String(8), nullable=False)
    color: Mapped[str] = mapped_column(String(9), nullable=False)
    # Free-text search terms, matched by the sidebar box the same way the
    # built-in `tags` field is.
    tags: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    icon: Mapped[str | None] = mapped_column(Text)

    # Set when this row STANDS FOR a built-in tool -- its name in `TOOLS`
    # (src/flow/constants.js), e.g. "Airflow". Built-in tools live in the
    # frontend source, so editing one materialises it here and the sidebar then
    # serves the row instead of the source entry. Null for a tool registered
    # from scratch.
    builtin: Mapped[str | None] = mapped_column(String(80), unique=True)
    # A built-in taken out of the catalog. Only ever true alongside `builtin`:
    # a registered tool is removed by deleting its row, but a built-in cannot be
    # deleted from the source at runtime, so the row is what says it is gone.
    # Deleting the row is what brings the built-in back (see docs/BACKEND.md).
    hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (Index("ix_custom_tools_name", "name"),)


class FlowShare(Base):
    """A flow shared with one account, at one permission level.

    This is the co-working table: the flow shows up on the other person's
    homepage and they open it in the same editor, subject to `permission`.
    Sharing is idempotent per pair -- re-sharing with someone updates the level
    instead of adding a second row.
    """

    __tablename__ = "flow_shares"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    flow_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("flows.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    permission: Mapped[str] = mapped_column(String(8), nullable=False, default="view")
    created_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    flow: Mapped[Flow] = relationship(back_populates="shares")
    user: Mapped[User] = relationship(foreign_keys=[user_id])

    __table_args__ = (
        UniqueConstraint("flow_id", "user_id", name="uq_flow_shares_flow_user"),
        CheckConstraint("permission IN ('view', 'edit', 'full')", name="ck_flow_shares_permission"),
        Index("ix_flow_shares_user_id", "user_id"),
    )


class FlowShareLink(Base):
    """A shareable URL. Whoever holds the link gets `permission` on the flow,
    with or without an account -- that is the point of a link.

    Only the sha256 of the token is stored, like a session: the raw token is
    shown once, when the link is created. A signed-in visitor who opens the link
    also gets a FlowShare row, so the flow lands on their homepage instead of
    depending on the URL forever.
    """

    __tablename__ = "flow_share_links"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    flow_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("flows.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    permission: Mapped[str] = mapped_column(String(8), nullable=False, default="view")
    label: Mapped[str | None] = mapped_column(String(120))
    created_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    flow: Mapped[Flow] = relationship(back_populates="share_links")

    __table_args__ = (
        CheckConstraint(
            "permission IN ('view', 'edit', 'full')", name="ck_flow_share_links_permission"
        ),
        Index("ix_flow_share_links_flow_id", "flow_id"),
    )
