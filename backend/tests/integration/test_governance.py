from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.config import Settings
from app.db.base import Base
from app.main import create_app
from app.models.governance import AuditEvent
from app.services.catalog import seed_catalog
from app.services.query_cache import QueryCache


USER = AuthenticatedUser(id=UUID("36130108-f336-4bd6-9b51-0e67d798e7e5"), email="analyst@example.com", display_name="Analyst", roles=frozenset({"analyst"}))


def configured_client(database_path: Path) -> tuple[TestClient, sessionmaker]:
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


def test_cache_keys_are_user_isolated() -> None:
    cache = QueryCache()
    plan = {"metric": "unit_count"}

    assert cache.key(user_id="user-a", plan=plan) != cache.key(user_id="user-b", plan=plan)


def test_fleet_query_records_execution_and_cache_hit(tmp_path: Path) -> None:
    client, factory = configured_client(tmp_path / "audit.db")
    plan = {"source": "fleet_snapshot", "metric": "unit_count", "aggregation": "sum", "filters": [{"dimension": "quarter_first_interval", "values": ["2026 - Q1"]}]}
    with client:
        first = client.post("/api/v1/catalog/fleet-query/execute", json=plan)
        second = client.post("/api/v1/catalog/fleet-query/execute", json=plan)

    assert first.status_code == 200
    assert second.status_code == 200
    with factory() as session:
        outcomes = list(session.scalars(select(AuditEvent.outcome).order_by(AuditEvent.created_at)))
    assert outcomes == ["executed", "cache_hit"]


def test_capabilities_and_freshness_endpoints_are_available() -> None:
    app = create_app(Settings(environment="test"))
    with TestClient(app) as client:
        capabilities = client.get("/api/v1/capabilities")
        freshness = client.get("/api/v1/data-freshness")

    assert capabilities.status_code == 200
    assert capabilities.json()["max_result_rows"] == 100
    assert freshness.status_code == 200
    assert len(freshness.json()["sources"]) == 2
