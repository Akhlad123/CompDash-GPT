from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.config import Settings
from app.db.base import Base
from app.main import create_app


STEWARD = AuthenticatedUser(id=UUID("8c76b7c6-1ce3-4916-a45b-7fd4a43f3280"), email="steward@example.com", display_name="Steward", roles=frozenset({"data_steward"}))
VIEWER = AuthenticatedUser(id=UUID("ac9033f2-6d34-4e42-896e-d0325fa42e7c"), email="viewer@example.com", display_name="Viewer", roles=frozenset({"viewer"}))


def app_with_database(database_path: Path, user: AuthenticatedUser):
    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
    Base.metadata.create_all(create_engine(database_url))
    app = create_app(Settings(environment="test", database_url=database_url))
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def test_approved_document_is_searchable_with_provenance(tmp_path: Path) -> None:
    database_path = tmp_path / "knowledge.db"
    with app_with_database(database_path, STEWARD) as steward_client:
        ingest = steward_client.post("/api/v1/documents/ingestions", json={"source_type": "manual", "title": "IQ8 Installation Manual", "content": "The IQ8 microinverter installation requires approved PV module compatibility.", "checksum": "a" * 64, "version": "1.0", "approved": True})
    with app_with_database(database_path, VIEWER) as viewer_client:
        search = viewer_client.get("/api/v1/documents/search", params={"query": "IQ8 compatibility"})

    assert ingest.status_code == 201
    assert search.status_code == 200
    citation = search.json()["citations"][0]
    assert citation["title"] == "IQ8 Installation Manual"
    assert citation["version"] == "1.0"
    assert citation["chunk_id"]


def test_unapproved_document_is_not_searchable(tmp_path: Path) -> None:
    database_path = tmp_path / "unapproved.db"
    with app_with_database(database_path, STEWARD) as steward_client:
        steward_client.post("/api/v1/documents/ingestions", json={"source_type": "manual", "title": "Draft", "content": "IQ8 restricted draft guidance.", "checksum": "b" * 64, "approved": False})
    with app_with_database(database_path, VIEWER) as viewer_client:
        search = viewer_client.get("/api/v1/documents/search", params={"query": "IQ8 guidance"})

    assert search.status_code == 200
    assert search.json()["citations"] == []
