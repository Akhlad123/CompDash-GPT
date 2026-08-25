from collections.abc import Generator

from fastapi import Request
from sqlalchemy.orm import Session, sessionmaker
from starlette.status import HTTP_503_SERVICE_UNAVAILABLE

from app.core.errors import ApiError


def get_db_session(request: Request) -> Generator[Session, None, None]:
    factory = getattr(request.app.state, "session_factory", None)
    if not isinstance(factory, sessionmaker):
        raise ApiError(
            status_code=HTTP_503_SERVICE_UNAVAILABLE,
            error_type="https://compdash.internal/problems/persistence-unavailable",
            title="Persistence is unavailable",
            detail="The conversation database is not configured for this environment.",
        )
    with factory() as session:
        yield session
