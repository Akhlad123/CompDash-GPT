from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.status import HTTP_500_INTERNAL_SERVER_ERROR


class ProblemDetails(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = Field(min_length=1, max_length=2_048)
    title: str = Field(min_length=1, max_length=500)
    status: int = Field(ge=400, le=599)
    detail: str | None = Field(default=None, max_length=4_000)
    instance: str | None = Field(default=None, max_length=2_048)
    correlation_id: str | None = Field(default=None, max_length=200)


class ApiError(Exception):
    def __init__(
        self,
        *,
        status_code: int,
        error_type: str,
        title: str,
        detail: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self.error_type = error_type
        self.title = title
        self.detail = detail
        self.headers = headers or {}
        super().__init__(detail or title)


def correlation_id_from_request(request: Request) -> str | None:
    value = getattr(request.state, "correlation_id", None)
    return value if isinstance(value, str) else None


def problem_response(
    request: Request,
    *,
    status_code: int,
    error_type: str,
    title: str,
    detail: str | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    payload = ProblemDetails(
        type=error_type,
        title=title,
        status=status_code,
        detail=detail,
        instance=str(request.url.path),
        correlation_id=correlation_id_from_request(request),
    )
    return JSONResponse(
        content=payload.model_dump(mode="json", exclude_none=True),
        status_code=status_code,
        headers=headers,
        media_type="application/problem+json",
    )


async def api_error_handler(request: Request, error: ApiError) -> JSONResponse:
    return problem_response(
        request,
        status_code=error.status_code,
        error_type=error.error_type,
        title=error.title,
        detail=error.detail,
        headers=error.headers,
    )


async def unhandled_error_handler(request: Request, _: Exception) -> JSONResponse:
    return problem_response(
        request,
        status_code=HTTP_500_INTERNAL_SERVER_ERROR,
        error_type="https://compdash.internal/problems/internal-error",
        title="Internal server error",
        detail="The request could not be completed.",
    )


def validation_error_detail(errors: list[dict[str, Any]]) -> str:
    fields = [".".join(str(item) for item in error.get("loc", ())) for error in errors]
    return f"Invalid request fields: {', '.join(fields)}" if fields else "Invalid request payload."
