from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.config import Settings
from app.db.base import Base
from app.main import create_app
from app.services.catalog import seed_catalog


USER = AuthenticatedUser(id=UUID("cf88b818-7f1f-485c-9e10-637c5aa996c7"), email="analyst@example.com", display_name="Analyst", roles=frozenset({"analyst"}))


def client_with_catalog(database_path: Path) -> TestClient:
    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
    engine = create_engine(database_url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as session:
        seed_catalog(session)
    app = create_app(Settings(environment="test", database_url=database_url))
    app.dependency_overrides[get_current_user] = lambda: USER
    return TestClient(app)


def test_compiles_bound_kql_with_required_time_window(tmp_path: Path) -> None:
    plan = {
        "source": "telemetry_daily",
        "metric": "average_dc_voltage_v",
        "aggregation": "average",
        "start_at": "2026-07-01T00:00:00+00:00",
        "end_at": "2026-07-02T00:00:00+00:00",
        "filters": [{"dimension": "site_id_telemetry", "values": ["DE-1' | take 10000"]}],
    }
    with client_with_catalog(tmp_path / "telemetry.db") as client:
        response = client.post("/api/v1/catalog/telemetry-query/validate", json=plan)

    assert response.status_code == 200
    body = response.json()
    assert "DE-1" not in body["kql"]
    assert body["parameters"]["filter_0"] == ["DE-1' | take 10000"]
    assert "day >= start_at and day < end_at" in body["kql"]
    assert body["metric_unit"] == "V"


def test_rejects_missing_time_window(tmp_path: Path) -> None:
    with client_with_catalog(tmp_path / "invalid-window.db") as client:
        response = client.post("/api/v1/catalog/telemetry-query/validate", json={"source": "telemetry_daily", "metric": "production_energy_kwh", "aggregation": "sum"})

    assert response.status_code == 422
