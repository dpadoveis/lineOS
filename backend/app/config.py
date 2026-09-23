from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """API configuration, read from the environment (see docker-compose.yml)."""

    database_url: str
    # Postgres schema dedicated to this project -- the database may host others.
    db_schema: str = "flow"
    # Directory holding the attachments (exported PNGs and loose files). A
    # Docker volume.
    storage_dir: Path = Path("/data/files")

    # ── Size ceilings ────────────────────────────────────────────────
    # The API container runs with 384 MB; these limits keep a large payload from
    # taking the process down. Applied in schemas.py and in the files router.
    max_nodes: int = 500
    max_edges: int = 2000
    # Group boxes. A box is a handful of numbers, so the ceiling is only there
    # to keep a malformed payload from growing without bound.
    max_groups: int = 200
    max_graph_bytes: int = 2 * 1024 * 1024
    max_upload_mb: int = 10
    # Custom tool icons travel inline as base64 data URLs. The browser
    # downscales them to a small square before sending, so the ceiling only has
    # to catch a client that skipped that step.
    max_tool_icon_bytes: int = 192 * 1024

    # Fallback label for flow_versions.author, used only when a save arrives
    # through a share link (no account). With a signed-in user, the author is
    # that person's name.
    author: str = ""

    # ── Accounts and sessions ────────────────────────────────────────
    # A session is an opaque token in an httpOnly cookie; the database holds
    # only its sha256 (user_sessions.token_hash), so leaking the database does
    # not hand over live sessions.
    session_cookie: str = "flow_session"
    session_days: int = 30
    # Off by default so a plain-HTTP install (localhost, a private network)
    # can sign in at all: a Secure cookie is never sent over HTTP. Turn it on
    # together with HTTPS at the proxy.
    session_cookie_secure: bool = False
    # PBKDF2 cost. It grows over time; old hashes stay valid because the
    # iteration count travels inside the hash itself.
    password_iterations: int = 210_000
    password_min_length: int = 8

    # Public address of the SPA, used to build the share link in the body of an
    # email. The browser builds its own from window.location, but the server has
    # no such information.
    public_base_url: str = "http://localhost:8020/"

    # ── SMTP (optional) ──────────────────────────────────────────────
    # Without smtp_host, sending from the server answers 503 and the editor
    # falls back to a mailto:, which opens the visitor's own mail client.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_starttls: bool = True
    smtp_from: str = ""

    # CORS is only needed when the frontend does not go through the Vite proxy.
    cors_origins: list[str] = []

    # ── Read-only source for dataset previews (Data Lineage) ─────────
    # The Postgres whose tables the lineages observe. Reach it by name (a
    # container on a shared network, see docker-compose.lineage.yml) rather
    # than by an IP Docker may reassign. The password is a mounted file, never
    # an environment variable (docker inspect would print it). No host or no
    # file = the dataset routes answer 503.
    dataset_source_host: str = ""
    dataset_source_port: int = 5432
    dataset_source_db: str = ""
    dataset_source_user: str = ""
    dataset_source_password_file: Path | None = None
    # Column the preview sorts by (newest first) when the binding names no
    # freshness column -- a row id or an insertion timestamp the tables of this
    # source share. Empty, or absent from a table: the primary key, then no
    # ordering at all.
    dataset_source_order_column: str = ""

    # ── Accounts: who may register ───────────────────────────────────
    # The first account (the admin) can always sign up. After it -- open:
    # anyone reaching the API; invite: only someone holding a live share link
    # (a diagram shared by link or by email is the invitation); closed: nobody.
    registration: Literal["open", "invite", "closed"] = "invite"


settings = Settings()
