import logging

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from . import migrations
from .config import settings
from .database import Base, engine
from .models import (  # noqa: F401 -- registers the tables
    CustomTool,
    Flow,
    FlowAsset,
    FlowShare,
    FlowShareLink,
    FlowVersion,
    User,
    UserSession,
)
from .models_ops import (  # noqa: F401 -- registers the tables
    InventoryObject,
    ObjectCheck,
    ObjectRun,
    Pipeline,
    PipelineBinding,
)
from .routers import auth, files, flows, health, inventory, pipelines, sharing, tools, users, versions

logger = logging.getLogger("flow.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    with engine.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{settings.db_schema}"'))
    Base.metadata.create_all(engine)
    # A light migration after create_all: create_all only creates missing
    # tables, it never alters existing ones. See migrations.py.
    migrations.apply(engine)
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    logger.info("API ready (schema=%s, files=%s)", settings.db_schema, settings.storage_dir)
    yield


app = FastAPI(
    title="Flow Editor - API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)


@app.middleware("http")
async def limit_body(request: Request, call_next):
    """Refuses large bodies before loading them into memory.

    The API container runs with 384 MB; without this barrier a POST of tens of
    megabytes would be read whole before Pydantic's validation rejected the
    graph.
    """
    if request.method in ("POST", "PUT", "PATCH"):
        raw = request.headers.get("content-length")
        content_type = request.headers.get("content-type", "")
        # Multipart uploads have their own ceiling (settings.max_upload_mb),
        # checked in the files router.
        if raw and raw.isdigit() and not content_type.startswith("multipart/"):
            if int(raw) > settings.max_graph_bytes:
                return JSONResponse(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    content={
                        "detail": (
                            "body above the "
                            f"{settings.max_graph_bytes // 1024} KB limit"
                        )
                    },
                )
    return await call_next(request)


if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        # With accounts, the session cookie has to travel with the request.
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

for router in (
    health.router,
    auth.router,
    users.router,
    sharing.router,
    flows.router,
    versions.router,
    files.router,
    tools.router,
    inventory.router,
    pipelines.router,
):
    app.include_router(router, prefix="/api")
