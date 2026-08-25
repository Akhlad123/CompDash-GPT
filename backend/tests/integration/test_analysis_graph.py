from pathlib import Path
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.config import Settings
from app.db.base import Base
from app.main import create_app
from app.models.conversation import AnalysisArtifact, AnalysisRun
from app.services.catalog import seed_catalog


USER = AuthenticatedUser(
    id=UUID("11cdb5a2-59c8-4f1d-8e89-2d1322a4e4ea"),
    email="analyst@example.com",
    display_name="Fleet Analyst",
    roles=frozenset({"analyst"}),
)


def graph_client(database_path: Path) -> tuple[TestClient, sessionmaker]:
    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
    engine = create_engine(database_url)
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE fleet_snapshot_data (site_id TEXT, country TEXT, region_bundle TEXT, product_type TEXT, quarter_first_interval TEXT, unit_count INTEGER, dc_ac_ratio FLOAT, irr_ann_kwh_m2_month FLOAT, stc_rating2 FLOAT)"))
        connection.execute(text("INSERT INTO fleet_snapshot_data VALUES ('DE-1', 'Germany', 'Europe', 'IQ8P', '2026 - Q1', 100, 1.25, 110.0, 450.0)"))
    factory = sessionmaker(bind=engine)
    with factory() as session:
        seed_catalog(session)
    app = create_app(Settings(environment="test", database_url=database_url))
    app.dependency_overrides[get_current_user] = lambda: USER
    return TestClient(app), factory


def question_payload(question: str, request_id: str) -> dict[str, object]:
    return {
        "question": question,
        "scope": {"timezone": "UTC"},
        "client_request_id": request_id,
    }


def test_question_with_quarter_completes_and_persists_result(tmp_path: Path) -> None:
    client, factory = graph_client(tmp_path / "completed.db")
    with client:
        conversation_id = client.post("/api/v1/conversations", json={"title": "Fleet question"}).json()["id"]
        response = client.post(
            f"/api/v1/conversations/{conversation_id}/questions",
            json=question_payload("Total units in Germany for 2026 - Q1", str(uuid4())),
        )

    assert response.status_code == 201
    assert response.json()["status"] == "completed"
    with factory() as session:
        artifact = session.scalar(select(AnalysisArtifact).where(AnalysisArtifact.analysis_run_id == UUID(response.json()["id"])))
    assert artifact is not None
    assert artifact.artifact_type == "fleet_result"
    assert artifact.payload["rows"] == [{"result": 100}]


def test_question_without_quarter_requires_clarification(tmp_path: Path) -> None:
    client, factory = graph_client(tmp_path / "clarification.db")
    with client:
        conversation_id = client.post("/api/v1/conversations", json={"title": "Fleet question"}).json()["id"]
        response = client.post(
            f"/api/v1/conversations/{conversation_id}/questions",
            json=question_payload("DC AC ratio in Germany", str(uuid4())),
        )

    assert response.status_code == 201
    assert response.json()["status"] == "clarification_required"
    with factory() as session:
        artifact = session.scalar(select(AnalysisArtifact).where(AnalysisArtifact.analysis_run_id == UUID(response.json()["id"])))
    assert artifact is not None
    assert artifact.artifact_type == "clarification"
    assert artifact.payload["field"] == "time_range"


def test_unsupported_question_fails_without_query_execution(tmp_path: Path) -> None:
    client, factory = graph_client(tmp_path / "failure.db")
    with client:
        conversation_id = client.post("/api/v1/conversations", json={"title": "Fleet question"}).json()["id"]
        response = client.post(
            f"/api/v1/conversations/{conversation_id}/questions",
            json=question_payload("Explain warranty claims", str(uuid4())),
        )

    assert response.status_code == 201
    assert response.json()["status"] == "failed"
    with factory() as session:
        run = session.get(AnalysisRun, UUID(response.json()["id"]))
    assert run is not None
    assert run.error_code == "analysis_failed"


def test_question_submission_is_idempotent(tmp_path: Path) -> None:
    client, factory = graph_client(tmp_path / "idempotent.db")
    request_id = str(uuid4())
    with client:
        conversation_id = client.post("/api/v1/conversations", json={"title": "Fleet question"}).json()["id"]
        first = client.post(f"/api/v1/conversations/{conversation_id}/questions", json=question_payload("Total units in Germany for 2026 - Q1", request_id))
        second = client.post(f"/api/v1/conversations/{conversation_id}/questions", json=question_payload("Total units in Germany for 2026 - Q1", request_id))

    assert first.status_code == 201
    assert second.json()["id"] == first.json()["id"]
    with factory() as session:
        artifacts = list(session.scalars(select(AnalysisArtifact).where(AnalysisArtifact.analysis_run_id == UUID(first.json()["id"]))))
    assert len(artifacts) == 1
