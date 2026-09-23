"""Read-only sessions on the ERP database, for the dataset tabs.

The role is read-only and time-limited at the server; the options below repeat
both limits so a misconfigured role still cannot write or run long.
"""
from contextlib import contextmanager

import psycopg

from .config import settings


class SourceUnavailable(Exception):
    """No password file configured, or the database cannot be reached."""


def _password() -> str:
    path = settings.erp_ro_password_file
    if not path:
        raise SourceUnavailable("dataset source not configured")
    try:
        return path.read_text().strip()
    except OSError as exc:
        raise SourceUnavailable("dataset source password file unreadable") from exc


@contextmanager
def connect():
    try:
        conn = psycopg.connect(
            host=settings.erp_ro_host,
            port=settings.erp_ro_port,
            dbname=settings.erp_ro_db,
            user=settings.erp_ro_user,
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
