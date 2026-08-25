from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict

from app.core.config import Settings

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    service: str
    release: str
    timestamp: datetime


class ReadinessResponse(HealthResponse):
    environment: str


def settings_from_request(request: Request) -> Settings:
    return request.app.state.settings


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    settings = settings_from_request(request)
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        release=settings.release,
        timestamp=datetime.now(UTC),
    )


@router.get("/ready", response_model=ReadinessResponse)
async def readiness(request: Request) -> ReadinessResponse:
    settings = settings_from_request(request)
    return ReadinessResponse(
        status="ready",
        service=settings.app_name,
        release=settings.release,
        timestamp=datetime.now(UTC),
        environment=settings.environment,
    )
