from uuid import UUID

from fastapi.testclient import TestClient
from starlette.status import HTTP_401_UNAUTHORIZED, HTTP_403_FORBIDDEN

from app.api.v1.identity import get_current_user
from app.core.auth import AuthenticatedUser, require_roles, unauthorized_error
from app.core.errors import ApiError
from app.core.config import Settings
from app.main import create_app


TEST_USER = AuthenticatedUser(
    id=UUID("7b0a32d3-9572-46ee-80be-d683ad121c4b"),
    email="analyst@example.com",
    display_name="Fleet Analyst",
    roles=frozenset({"analyst"}),
)


def test_me_returns_authenticated_identity() -> None:
    app = create_app(Settings(environment="test"))
    app.dependency_overrides[get_current_user] = lambda: TEST_USER

    with TestClient(app) as client:
        response = client.get("/api/v1/me")

    assert response.status_code == 200
    assert response.json() == {
        "id": "7b0a32d3-9572-46ee-80be-d683ad121c4b",
        "email": "analyst@example.com",
        "display_name": "Fleet Analyst",
        "roles": ["analyst"],
    }


def test_me_requires_bearer_token_when_no_override() -> None:
    app = create_app(Settings(environment="test"))

    with TestClient(app) as client:
        response = client.get("/api/v1/me")

    assert response.status_code == HTTP_401_UNAUTHORIZED
    assert response.headers["WWW-Authenticate"] == "Bearer"
    assert response.headers["content-type"].startswith("application/problem+json")


def test_role_guard_rejects_unassigned_role() -> None:
    guard = require_roles("admin")

    try:
        import asyncio

        asyncio.run(guard(TEST_USER))
    except ApiError as error:
        assert error.status_code == HTTP_403_FORBIDDEN
    else:
        raise AssertionError("Expected an ApiError for insufficient permissions")


def test_missing_bearer_token_maps_to_401() -> None:
    error = unauthorized_error("A bearer access token is required.")

    assert error.status_code == HTTP_401_UNAUTHORIZED
    assert error.headers == {"WWW-Authenticate": "Bearer"}
