"""The API's input and output contracts.

`GraphPayload` is a faithful Pydantic translation of the format produced by
`flowPayload()` in src/flow/payload.js (documented in the README, "JSON
format"). The fields are declared in the order the frontend emits them, so
`model_dump(by_alias=True)` reproduces the original JSON field for field -- the
editor -> database -> editor round trip changes no value.
"""
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .config import settings

Color = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{3,8}$")]
Text = Annotated[str, Field(min_length=1, max_length=160)]


class NodePayload(BaseModel):
    """One node of the graph. Mirrors `nodePayload().node` on the frontend."""

    model_config = ConfigDict(extra="forbid")

    id: int = Field(gt=0)
    name: Text
    # The name the user gave this node. `name` stays the technical stack name,
    # which the editor prints below it -- renaming never erases the tool's
    # identity.
    label: Text | None = None
    category: Text
    initials: Annotated[str, Field(min_length=1, max_length=8)]
    color: Color
    x: int
    # y arrives already inverted from the frontend (positive = above the
    # origin). The API does not reinterpret the sign; it stores what it got.
    y: int
    # Explicit size, when the node was resized by hand. null = the default
    # (232 wide, height dictated by the content). The limits are the editor's
    # own (src/flow/constants.js).
    width: Annotated[int, Field(ge=168, le=720)] | None = None
    height: Annotated[int, Field(ge=120, le=900)] | None = None
    description: Annotated[str, Field(max_length=4000)] | None = None
    metadata: dict[str, Annotated[str, Field(max_length=2000)]] = Field(default_factory=dict)
    # Slug of the custom tool this node came from, or null for a built-in one.
    # Only the icon is resolved through it at render time; every other visual
    # field is already copied into the node, so a deleted tool degrades to the
    # initials instead of breaking the graph.
    tool: Annotated[str, Field(max_length=140)] | None = None
    # Id of the group box holding this node, or null. The frontend derives it
    # from the coordinates (a node belongs to the box its centre falls in), so
    # it is a cache of geometry, not a second source of truth -- the API only
    # checks that it points at a group that exists.
    group: Annotated[int, Field(gt=0)] | None = None
    # Stable identity across versions. `id` is max(id)+1 on the client
    # (src/flow/geometry.js) and is REUSED after a deletion, so an operational
    # binding must not anchor on it. Optional: diagrams saved before this field
    # existed have no uid, and promoting one to a pipeline stamps the missing
    # ones once (see service_ops.promote).
    uid: Annotated[str, Field(min_length=8, max_length=64)] | None = None

    @field_validator("metadata")
    @classmethod
    def _limit_metadata(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) > 60:
            raise ValueError("a node accepts at most 60 metadata pairs")
        return v


class EdgePayload(BaseModel):
    """A directed arrow. `from` is a Python keyword, hence the alias."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: int = Field(gt=0)
    origin: int = Field(alias="from", gt=0)
    target: int = Field(alias="to", gt=0)
    label: Annotated[str, Field(max_length=200)] | None = None


class GroupPayload(BaseModel):
    """A group box: a rectangle drawn behind the nodes. Mirrors
    `groupPayload()` on the frontend."""

    model_config = ConfigDict(extra="forbid")

    id: int = Field(gt=0)
    name: Text
    x: int
    # Inverted like a node's y, so the whole document shares one axis.
    y: int
    # The editor's own limits (src/flow/constants.js).
    width: Annotated[int, Field(ge=160, le=6000)]
    height: Annotated[int, Field(ge=120, le=6000)]
    color: Color


class GraphPayload(BaseModel):
    """The whole document: `{kind: 'flow-graph', version: 1, nodes, edges}`."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["flow-graph"]
    version: Literal[1]
    nodes: list[NodePayload]
    edges: list[EdgePayload]
    # Groups arrived after the first flows were saved: a document without them
    # is still a valid document, so the field defaults to empty instead of
    # being required.
    groups: list[GroupPayload] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_graph(self) -> "GraphPayload":
        if len(self.nodes) > settings.max_nodes:
            raise ValueError(f"at most {settings.max_nodes} nodes per flow")
        if len(self.edges) > settings.max_edges:
            raise ValueError(f"at most {settings.max_edges} edges per flow")
        if len(self.groups) > settings.max_groups:
            raise ValueError(f"at most {settings.max_groups} groups per flow")

        ids = [n.id for n in self.nodes]
        if len(set(ids)) != len(ids):
            raise ValueError("repeated node ids")

        # Edge ids run independently of node ids (nextId runs separately for
        # each collection on the frontend), but must be unique within their own
        # list.
        eids = [e.id for e in self.edges]
        if len(set(eids)) != len(eids):
            raise ValueError("repeated edge ids")

        gids = [g.id for g in self.groups]
        if len(set(gids)) != len(gids):
            raise ValueError("repeated group ids")
        boxes = set(gids)
        for n in self.nodes:
            if n.group is not None and n.group not in boxes:
                raise ValueError(f"node {n.id} points at a group that does not exist")

        known = set(ids)
        pairs: set[tuple[int, int]] = set()
        for e in self.edges:
            if e.origin not in known or e.target not in known:
                raise ValueError(f"edge {e.id} points at a node that does not exist")
            if e.origin == e.target:
                raise ValueError(f"edge {e.id} links a node to itself")
            pair = (e.origin, e.target)
            if pair in pairs:
                raise ValueError(f"duplicate edge between nodes {e.origin} and {e.target}")
            pairs.add(pair)
        return self

    def to_json(self) -> dict[str, Any]:
        """A dict ready for jsonb, in the frontend's field order."""
        return self.model_dump(by_alias=True)


# ── Requests ─────────────────────────────────────────────────────────


class FlowCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Text
    description: Annotated[str, Field(max_length=2000)] | None = None
    graph: GraphPayload
    note: Annotated[str, Field(max_length=500)] | None = None


class FlowPatch(BaseModel):
    """Rename / redescribe. Creates no version."""

    model_config = ConfigDict(extra="forbid")

    name: Text | None = None
    description: Annotated[str, Field(max_length=2000)] | None = None


class VersionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    graph: GraphPayload
    note: Annotated[str, Field(max_length=500)] | None = None
    # Optimistic locking: must equal flows.current_version, or the answer is
    # 409. Keeps two tabs open on the same flow from silently overwriting each
    # other.
    base_version: int = Field(ge=0)


class DraftSave(BaseModel):
    model_config = ConfigDict(extra="forbid")

    graph: GraphPayload


# ── Responses ────────────────────────────────────────────────────────


class FlowListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    name: str
    description: str | None
    current_version: int
    node_count: int
    edge_count: int
    has_draft: bool
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    # ── Ownership and sharing ──
    # `permission` is what the caller may do with this flow ('view' | 'edit' |
    # 'full'); `is_owner` separates the owner from someone holding full control.
    owner_id: int | None = None
    owner_name: str | None = None
    permission: str = "full"
    is_owner: bool = True
    shared_count: int = 0


class FlowDetail(FlowListItem):
    graph: dict[str, Any]
    # 'version' when the graph came from the last saved version; 'draft' when
    # the autosave is newer than it.
    graph_source: Literal["version", "draft"]


class VersionListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    version: int
    node_count: int
    edge_count: int
    note: str | None
    author: str | None
    created_at: datetime


class VersionDetail(VersionListItem):
    graph: dict[str, Any]


class AssetItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    flow_id: int
    flow_version: int | None
    kind: str
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime


# ── Custom tools ─────────────────────────────────────────────────────
# The user-registered side of the sidebar catalog; the built-in one lives in
# src/flow/constants.js.

ToolName = Annotated[str, Field(min_length=1, max_length=80)]
ToolCategory = Annotated[str, Field(min_length=1, max_length=40)]
ToolInitials = Annotated[str, Field(min_length=1, max_length=8)]
ToolTags = Annotated[str, Field(max_length=300)]

_ICON_PREFIXES = ("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,")


def _check_icon(value: str | None) -> str | None:
    """Accept only a raster data URL, within the configured size ceiling.

    The browser always sends a downscaled PNG. SVG is rejected on purpose: it is
    markup, and the icon is rendered straight into the page.
    """
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if not value.startswith(_ICON_PREFIXES):
        raise ValueError("icon must be a base64 data URL of a PNG, JPEG or WebP image")
    if len(value.encode()) > settings.max_tool_icon_bytes:
        raise ValueError(f"icon above the {settings.max_tool_icon_bytes // 1024} KB limit")
    return value


# The name of a built-in tool, as written in `TOOLS` (src/flow/constants.js).
# It is the client's word: the server keeps no copy of that list, and an
# unknown name simply produces a row nothing hides.
BuiltinName = Annotated[str, Field(min_length=1, max_length=80)]


class CustomToolCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ToolName
    category: ToolCategory = "CUSTOM"
    # Derived from the name when the client leaves it out.
    initials: ToolInitials | None = None
    color: Color = "#9aa4b0"
    tags: ToolTags = ""
    icon: str | None = None
    # Name of the built-in tool this row stands for, when the client is
    # materialising one to edit or to remove it. Null for a tool registered
    # from scratch.
    builtin: BuiltinName | None = None
    # Created straight into the "removed from the catalog" state. Only makes
    # sense for a built-in: anything else is removed by deleting its row.
    hidden: bool = False

    @field_validator("icon")
    @classmethod
    def _validate_icon(cls, v: str | None) -> str | None:
        return _check_icon(v)

    @model_validator(mode="after")
    def _hidden_needs_a_builtin(self) -> "CustomToolCreate":
        if self.hidden and not self.builtin:
            raise ValueError("only a built-in tool is registered as hidden")
        return self


class CustomToolPatch(BaseModel):
    """Partial edit. `icon` set to "" clears the image; omitted keeps it."""

    model_config = ConfigDict(extra="forbid")

    name: ToolName | None = None
    category: ToolCategory | None = None
    initials: ToolInitials | None = None
    color: Color | None = None
    tags: ToolTags | None = None
    icon: str | None = None

    @field_validator("icon")
    @classmethod
    def _validate_icon(cls, v: str | None) -> str | None:
        return _check_icon(v)


class CustomToolItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    name: str
    category: str
    initials: str
    color: str
    tags: str
    icon: str | None
    # The built-in this row replaces, and whether it was taken out of the
    # catalog. The sidebar needs both: a row with `builtin` replaces the source
    # entry it stands for, and a hidden one replaces it with nothing.
    builtin: str | None
    hidden: bool
    created_at: datetime
    updated_at: datetime


class ToolUsageFlow(BaseModel):
    """One diagram holding a node made from the tool."""

    id: int
    name: str
    # In the trash: still counts, since restoring brings the nodes back.
    deleted: bool


class ToolUsage(BaseModel):
    """Where a tool is used. `count` is the whole tally; `flows` is capped, so
    a tool used in 200 diagrams does not answer with 200 names."""

    count: int
    flows: list[ToolUsageFlow]


# ── Accounts ─────────────────────────────────────────────────────────

# Deliberately loose: an address the mail server accepts is the real test, and a
# strict regex here would only reject valid addresses. Kept as a plain str so
# the project stays free of the email-validator dependency.
Email = Annotated[str, Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")]
Permission = Literal["view", "edit", "full"]


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1, max_length=120)]
    email: Email
    password: Annotated[str, Field(min_length=1, max_length=200)]
    # A share-link token: the invitation when `registration` is "invite".
    invite: Annotated[str | None, Field(max_length=200)] = None

    @field_validator("password")
    @classmethod
    def _long_enough(cls, v: str) -> str:
        if len(v) < settings.password_min_length:
            raise ValueError(f"password must have at least {settings.password_min_length} characters")
        return v


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email
    password: Annotated[str, Field(min_length=1, max_length=200)]


class PasswordChange(BaseModel):
    """A signed-in user changing their own password.

    The current password is required even with a valid session: without it, one
    forgotten open tab would be enough to take the account over.
    """

    model_config = ConfigDict(extra="forbid")

    current_password: Annotated[str, Field(min_length=1, max_length=200)]
    new_password: Annotated[str, Field(min_length=1, max_length=200)]

    @field_validator("new_password")
    @classmethod
    def _long_enough(cls, v: str) -> str:
        if len(v) < settings.password_min_length:
            raise ValueError(f"password must have at least {settings.password_min_length} characters")
        return v


class UserItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    is_admin: bool = False
    created_at: datetime


class SessionInfo(BaseModel):
    """What the SPA needs on boot: who is signed in, whether the server can
    send email itself (otherwise the share menu falls back to mailto:) and who
    may sign up -- `first_run` while the server has no account at all."""

    user: UserItem | None = None
    smtp_ready: bool = False
    registration: Literal["first_run", "open", "invite", "closed"] = "open"


# ── Sharing ──────────────────────────────────────────────────────────


class ShareWithUser(BaseModel):
    """Share with an existing account, found by email."""

    model_config = ConfigDict(extra="forbid")

    email: Email
    permission: Permission = "view"


class SharePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    permission: Permission


class ShareLinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    permission: Permission = "view"
    label: Annotated[str, Field(max_length=120)] | None = None
    # Null never expires. The ceiling keeps a forgotten link from outliving the
    # reason it was created.
    expires_days: Annotated[int, Field(ge=1, le=365)] | None = None


class ShareEmail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    to: Email
    permission: Permission = "view"
    message: Annotated[str, Field(max_length=2000)] | None = None
    # The address of the SPA as the browser sees it; the server falls back to
    # settings.public_base_url when the client leaves it out.
    base_url: Annotated[str, Field(max_length=300)] | None = None


class ShareItem(BaseModel):
    """One account this flow is shared with."""

    id: int
    user_id: int
    name: str
    email: str
    permission: str
    created_at: datetime


class ShareLinkItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    permission: str
    label: str | None
    created_at: datetime
    expires_at: datetime | None
    revoked: bool
    # Only filled in on creation: the raw token is never stored, so it cannot be
    # shown again. Losing it means creating another link.
    token: str | None = None


class SharingState(BaseModel):
    """Everything the Share menu shows for one flow."""

    flow_id: int
    flow_name: str
    permission: str
    is_owner: bool
    owner_name: str | None
    shares: list[ShareItem]
    links: list[ShareLinkItem]
    smtp_ready: bool


class ShareEmailResult(BaseModel):
    sent: bool
    to: str
    url: str
    # Ready-to-open mailto: URL, so the editor can fall back to the visitor's own
    # mail client when the server has no SMTP.
    mailto: str
