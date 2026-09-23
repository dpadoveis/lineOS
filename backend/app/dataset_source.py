"""Read-only sessions on the dataset source, for the dataset tabs.

The source is the Postgres whose tables the lineages observe. Its role should be
read-only and time-limited at the server; the options below repeat both limits
so a misconfigured role still cannot write or run long.
"""
from contextlib import contextmanager

import psycopg

from .config import settings


class SourceUnavailable(Exception):
    """No source configured, or the database cannot be reached."""


def _password() -> str:
    path = settings.dataset_source_password_file
    if not path:
        raise SourceUnavailable("dataset source not configured")
    try:
        return path.read_text().strip()
    except OSError as exc:
        raise SourceUnavailable("dataset source password file unreadable") from exc


@contextmanager
def connect():
    if not settings.dataset_source_host:
        raise SourceUnavailable("dataset source not configured")
    try:
        conn = psycopg.connect(
            host=settings.dataset_source_host,
            port=settings.dataset_source_port,
            dbname=settings.dataset_source_db,
            user=settings.dataset_source_user,
            password=_password(),
            connect_timeout=5,
            options="-c default_transaction_read_only=on -c statement_timeout=15000",
        )
    except psycopg.OperationalError as exc:
        raise SourceUnavailable("dataset source unreachable") from exc
    try:
        yield conn
    finally:
        conn.close()
