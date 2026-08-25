from pathlib import Path
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.base import Base
from app.main import create_app
from app.core.config import Settings


USER = AuthenticatedUser(
    id=UUID("2174d050-8d01-4174-a5c5-9cf7762b0a09"),
    email="analyst@example.com",
    display_name="Fleet Analyst",
    roles=frozenset({"analyst"}),
)
OTHER_USER = AuthenticatedUser(
    id=UUID("0d88d1b0-0b47-44b2-a95a-636317ab3bce"),
    email="other@example.com",
    display_name="Other Analyst",
    roles=frozenset({"analyst"}),
)


def client_with_database(database_path: Path, user: AuthenticatedUser) -> TestClient:
    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
    engine = create_engine(database_url)
    Base.metadata.create_all(engine)
    app = create_app(Settings(environment="test", database_url=database_url))
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def test_create_list_and_get_user_conversation(tmp_path: Path) -> None:
    with client_with_database(tmp_path / "conversations.db", USER) as client:
        create_response = client.post("/api/v1/conversations", json={"title": "Fleet review", "context": {"country": "Germany"}})
        list_response = client.get("/api/v1/conversations")
        conversation_id = create_response.json()["id"]
        detail_response = client.get(f"/api/v1/conversations/{conversation_id}")

    assert create_response.status_code == 201
    assert list_response.status_code == 200
    assert len(list_response.json()) == 1
    assert detail_response.status_code == 200
    assert detail_response.json()["context"] == {"country": "Germany"}


def test_conversation_is_not_visible_to_another_user(tmp_path: Path) -> None:
    database_path = tmp_path / "ownership.db"
    with client_with_database(database_path, USER) as client:
        conversation_id = client.post("/api/v1/conversations", json={"title": "Private analysis"}).json()["id"]

    with client_with_database(database_path, OTHER_USER) as other_client:
        response = other_client.get(f"/api/v1/conversations/{conversation_id}")

    assert response.status_code == 404


def test_analysis_run_is_idempotent_and_can_be_cancelled(tmp_path: Path) -> None:
    with client_with_database(tmp_path / "runs.db", USER) as client:
        conversation_id = client.post("/api/v1/conversations", json={"title": "Run analysis"}).json()["id"]
        request_id = str(uuid4())
        first_response = client.post(
            f"/api/v1/conversations/{conversation_id}/analysis-runs",
            json={"client_request_id": request_id},
        )
        repeated_response = client.post(
            f"/api/v1/conversations/{conversation_id}/analysis-runs",
            json={"client_request_id": request_id},
        )
        run_id = first_response.json()["id"]
        cancel_response = client.post(f"/api/v1/analysis-runs/{run_id}/cancel")

    assert first_response.status_code == 201
    assert repeated_response.status_code == 201
    assert repeated_response.json()["id"] == run_id
    assert cancel_response.status_code == 200
    assert cancel_response.json()["run"]["status"] == "cancelled"


def test_conversation_api_requires_configured_persistence() -> None:
    app = create_app(Settings(environment="test"))
    app.dependency_overrides[get_current_user] = lambda: USER

    with TestClient(app) as client:
        response = client.get("/api/v1/conversations")

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/problem+json")
