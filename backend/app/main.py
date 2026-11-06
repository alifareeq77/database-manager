"""FastAPI application entry point."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from app.adapters.base import AdapterError
from app.api import audit_log, auth, connections, explorer, io, query, schema
from app.config import get_settings
from app.core.ratelimit import limiter
from app.db import init_db
from app.services.connections import NotFound, adapters

log = logging.getLogger("strata")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    await init_db()
    adapters.start()
    yield
    await adapters.stop()


app = FastAPI(title="Strata API", version="0.1.0", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")

settings = get_settings()
if settings.cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["content-type", "x-csrf-token"])


@app.middleware("http")
async def security_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    if request.url.path.startswith("/api/"):
        key = request.cookies.get("strata_session") or (request.client.host if request.client else "anon")
        if not limiter.allow(f"api:{key}", settings.api_rate_per_minute):
            return JSONResponse({"detail": "Rate limit exceeded"}, status_code=429, headers={"Retry-After": str(limiter.retry_after(f"api:{key}"))})
    response: Response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.exception_handler(AdapterError)
async def adapter_error(_request: Request, exc: AdapterError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(NotFound)
async def not_found(_request: Request, exc: NotFound) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


for r in (auth.router, connections.router, explorer.router, query.router, schema.router, io.router, audit_log.router):
    app.include_router(r)
