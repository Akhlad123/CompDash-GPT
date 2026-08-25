from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.config import Settings
from app.db.base import Base
from app.main import create_app
from app.services.catalog import seed_catalog


ANALYST = AuthenticatedUser(
    id=UUID("7a7cef82-b9ae-4e7a-a154-8c53c9fe8b21"),
    email="analyst@example.com",
    display_name="Fleet Analyst",
    roles=frozenset({"analyst"}),
)
VIEWER = AuthenticatedUser(
    id=UUID("5d3972b7-8ed7-44cb-8a5f-48f29a4a9445"),
    email="viewer@example.com",
    display_name="Fleet Viewer",
    roles=frozenset({"viewer"}),
)


def fleet_client(database_path: Path, user: AuthenticatedUser) -> TestClient:
    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
    engine = create_engine(database_url)
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE fleet_snapshot_data (site_id TEXT, country TEXT, region_bundle TEXT, product_type TEXT, quarter_first_interval TEXT, unit_count INTEGER, dc_ac_ratio FLOAT, irr_ann_kwh_m2_month FLOAT, stc_rating2 FLOAT)"))
        connection.execute(text("INSERT INTO fleet_snapshot_data VALUES ('DE-1', 'Germany', 'Europe', 'IQ8P', '2026 - Q1', 100, 1.25, 110.0, 450.0), ('DE-2', 'Germany', 'Europe', 'IQ8P', '2026 - Q1', 80, 1.15, 100.0, 440.0), ('US-1', 'United States', 'North America', 'IQ9N', '2026 - Q1', 200, 1.30, 150.0, 470.0)"))
    factory = sessionmaker(bind=engine)
    with factory() as session:
        seed_catalog(session)
    app = create_app(Settings(environment="test", database_url=database_url))
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def test_validated_plan_compiles_with_bound_filter_values(tmp_path: Path) -> None:
    plan = {
        "source": "fleet_snapshot",
        "metric": "unit_count",
        "aggregation": "sum",
        "group_by": ["country"],
        "filters": [{"dimension": "quarter_first_interval", "values": ["2026 - Q1"]}],
    }
    with fleet_client(tmp_path / "compile.db", ANALYST) as client:
        response = client.post("/api/v1/catalog/fleet-query/validate", json=plan)

    assert response.status_code == 200
    assert "2026 - Q1" not in response.json()["sql"]
    assert response.json()["parameters"]["filter_0_0"] == "2026 - Q1"
    assert response.json()["metric_unit"] == "units"


def test_fleet_query_executes_ranked_aggregate(tmp_path: Path) -> None:
    plan = {
        "source": "fleet_snapshot",
        "metric": "unit_count",
        "aggregation": "sum",
        "group_by": ["country"],
        "filters": [{"dimension": "quarter_first_interval", "values": ["2026 - Q1"]}],
        "limit": 5,
    }
    with fleet_client(tmp_path / "execute.db", ANALYST) as client:
        response = client.post("/api/v1/catalog/fleet-query/execute", json=plan)

    assert response.status_code == 200
    assert response.json()["rows"][0] == {"country": "United States", "result": 200}
    assert response.json()["row_count"] == 2


def test_time_sensitive_plan_requires_reporting_quarter(tmp_path: Path) -> None:
    plan = {"source": "fleet_snapshot", "metric": "dc_ac_ratio", "aggregation": "average"}
    with fleet_client(tmp_path / "clarify.db", ANALYST) as client:
        response = client.post("/api/v1/catalog/fleet-query/validate", json=plan)

    assert response.status_code == 200
    assert response.json()["required_clarification"]
    assert response.json()["sql"] == ""


def test_unknown_metric_and_viewer_access_are_rejected(tmp_path: Path) -> None:
    unknown_metric = {
        "source": "fleet_snapshot",
        "metric": "drop_table",
        "aggregation": "sum",
        "filters": [{"dimension": "quarter_first_interval", "values": ["2026 - Q1"]}],
    }
    with fleet_client(tmp_path / "invalid.db", ANALYST) as analyst_client:
        invalid_response = analyst_client.post("/api/v1/catalog/fleet-query/validate", json=unknown_metric)
    with fleet_client(tmp_path / "viewer.db", VIEWER) as viewer_client:
        denied_response = viewer_client.post("/api/v1/catalog/fleet-query/validate", json=unknown_metric)

    assert invalid_response.status_code == 422
    assert denied_response.status_code == 403
