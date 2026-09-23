from sqlalchemy import MetaData, create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    metadata = MetaData(schema=settings.db_schema)


engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    # A lean pool: one uvicorn worker behind a 0.60 CPU ceiling gains nothing
    # from more connections, and Postgres runs with max_connections=50.
    pool_size=5,
    max_overflow=5,
    connect_args={"options": f"-csearch_path={settings.db_schema}"},
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db():
    """FastAPI dependency: one session per request."""
    with SessionLocal() as db:
        yield db
