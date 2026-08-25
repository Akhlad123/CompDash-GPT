from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from app.api.v1.analytics import router as analytics_router
from app.api.v1.analysis_events import router as analysis_event_router
from app.api.v1.capabilities import router as capabilities_router
from app.api.v1.catalog import router as catalog_router
from app.api.v1.conversations import router as conversations_router
from app.api.v1.engineering import router as engineering_router
from app.api.v1.fleet_queries import router as fleet_query_router
from app.api.v1.telemetry_queries import router as telemetry_query_router
from app.api.v1.knowledge import router as knowledge_router
from app.api.v1.health import router as health_router
from app.api.v1.identity import router as identity_router
from app.core.config import Settings, get_settings
from app.db.session import create_session_factory
from app.services.query_cache import QueryCache
from app.core.errors import (
    ApiError,
    api_error_handler,
    problem_response,
    unhandled_error_handler,
    validation_error_detail,
)
from app.core.logging import configure_logging

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    app_settings = settings or get_settings()
    configure_logging(app_settings.log_level)

    app = FastAPI(
        title=app_settings.app_name,
        version=app_settings.release,
        docs_url=None if app_settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=f"{app_settings.api_v1_prefix}/openapi.json",
    )

    app.state.settings = app_settings
    app.state.query_cache = QueryCache(app_settings.redis_url, app_settings.query_cache_ttl_seconds)
    app.state.analytics_jobs = {}

    if app_settings.database_url:
        app.state.session_factory = create_session_factory(app_settings.database_url)

    if app_settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[str(origin) for origin in app_settings.allowed_origins],
            allow_credentials=True,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Correlation-ID"],
            expose_headers=["X-Correlation-ID"],
        )

    @app.middleware("http")
    async def add_correlation_id(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        supplied_id = request.headers.get("X-Correlation-ID")
        correlation_id = supplied_id if supplied_id and len(supplied_id) <= 200 else str(uuid4())
        request.state.correlation_id = correlation_id
        response = await call_next(request)
        response.headers["X-Correlation-ID"] = correlation_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(ApiError)
    async def handle_api_error(request: Request, error: ApiError) -> Response:
        return await api_error_handler(request, error)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, error: RequestValidationError) -> Response:
        return problem_response(
            request,
            status_code=422,
            error_type="https://compdash.internal/problems/validation-error",
            title="Request validation failed",
            detail=validation_error_detail(error.errors()),
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, error: Exception) -> Response:
        logger.exception("Unhandled API exception", extra={"correlation_id": request.state.correlation_id})
        return await unhandled_error_handler(request, error)

    app.include_router(health_router, prefix=app_settings.api_v1_prefix)
    app.include_router(identity_router, prefix=app_settings.api_v1_prefix)
    app.include_router(conversations_router, prefix=app_settings.api_v1_prefix)
    app.include_router(catalog_router, prefix=app_settings.api_v1_prefix)
    app.include_router(fleet_query_router, prefix=app_settings.api_v1_prefix)
    app.include_router(telemetry_query_router, prefix=app_settings.api_v1_prefix)
    app.include_router(analysis_event_router, prefix=app_settings.api_v1_prefix)
    app.include_router(capabilities_router, prefix=app_settings.api_v1_prefix)
    app.include_router(analytics_router, prefix=app_settings.api_v1_prefix)
    app.include_router(knowledge_router, prefix=app_settings.api_v1_prefix)
    app.include_router(engineering_router, prefix=app_settings.api_v1_prefix)
    return app


app = create_app()
