import json
from pathlib import Path
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.config import Settings
from app.db.base import Base
from app.main import create_app
from app.services.catalog import seed_catalog


USER = AuthenticatedUser(
    id=UUID("c7119ae8-50aa-4227-9637-83390eb9bb13"),
    email="analyst@example.com",
    display_name="Fleet Analyst",
    roles=frozenset({"analyst"}),
)
OTHER_USER = AuthenticatedUser(
    id=UUID("d21b0f58-d520-4cc4-9210-6bf3df34e6c4"),
    email="other@example.com",
    display_name="Other Analyst",
    roles=frozenset({"analyst"}),
)


def event_client(database_path: Path, user: AuthenticatedUser) -> TestClient:
    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
    engine = create_engine(database_url)
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE IF NOT EXISTS fleet_snapshot_data (site_id TEXT, country TEXT, region_bundle TEXT, product_type TEXT, quarter_first_interval TEXT, unit_count INTEGER, dc_ac_ratio FLOAT, irr_ann_kwh_m2_month FLOAT, stc_rating2 FLOAT)"))
        connection.execute(text("INSERT INTO fleet_snapshot_data VALUES ('DE-1', 'Germany', 'Europe', 'IQ8P', '2026 - Q1', 100, 1.25, 110.0, 450.0)"))
    factory = sessionmaker(bind=engine)
    with factory() as session:
        seed_catalog(session)
    app = create_app(Settings(environment="test", database_url=database_url))
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def create_completed_run(client: TestClient) -> str:
    conversation_id = client.post("/api/v1/conversations", json={"title": "SSE test"}).json()["id"]
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/questions",
        json={"question": "Total units in Germany for 2026 - Q1", "scope": {"timezone": "UTC"}, "client_request_id": str(uuid4())},
    )
    assert response.status_code == 201
    return response.json()["id"]


def parse_sse_events(content: str) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for block in content.strip().split("\n\n"):
        data_line = next(line for line in block.splitlines() if line.startswith("data: "))
        events.append(json.loads(data_line.removeprefix("data: ")))
    return events


def test_events_stream_in_durable_lifecycle_order(tmp_path: Path) -> None:
    with event_client(tmp_path / "events.db", USER) as client:
        run_id = create_completed_run(client)
        response = client.get(f"/api/v1/analysis-runs/{run_id}/events")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = parse_sse_events(response.text)
    assert [event["event_type"] for event in events] == ["accepted", "planning", "artifact", "complete"]
    assert [event["sequence"] for event in events] == [1, 2, 3, 4]


def test_event_stream_replays_only_after_last_event_id(tmp_path: Path) -> None:
    with event_client(tmp_path / "replay.db", USER) as client:
        run_id = create_completed_run(client)
        response = client.get(f"/api/v1/analysis-runs/{run_id}/events", headers={"Last-Event-ID": "2"})

    events = parse_sse_events(response.text)
    assert [event["sequence"] for event in events] == [3, 4]


def test_artifact_metadata_is_retrievable(tmp_path: Path) -> None:
    with event_client(tmp_path / "artifact.db", USER) as client:
        run_id = create_completed_run(client)
        response = client.get(f"/api/v1/analysis-runs/{run_id}/artifacts")

    assert response.status_code == 200
    assert response.json()[0]["artifact_type"] == "fleet_result"
    assert response.json()[0]["payload"]["metric_unit"] == "units"


def test_events_and_artifacts_are_not_visible_to_other_users(tmp_path: Path) -> None:
    database_path = tmp_path / "ownership.db"
    with event_client(database_path, USER) as owner_client:
        run_id = create_completed_run(owner_client)
    with event_client(database_path, OTHER_USER) as other_client:
        event_response = other_client.get(f"/api/v1/analysis-runs/{run_id}/events")
        artifact_response = other_client.get(f"/api/v1/analysis-runs/{run_id}/artifacts")

    assert event_response.status_code == 404
    assert artifact_response.status_code == 404
