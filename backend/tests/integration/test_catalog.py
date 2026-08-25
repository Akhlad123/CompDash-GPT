from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.config import Settings
from app.db.base import Base
from app.main import create_app
from app.models.catalog import Metric
from app.services.catalog import seed_catalog


USER = AuthenticatedUser(
    id=UUID("8bda21cb-6f52-4c81-a44e-3193eb43a5b8"),
    email="engineer@example.com",
    display_name="Fleet Engineer",
    roles=frozenset({"engineer"}),
)


def seeded_client(database_path: Path) -> TestClient:
    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
    engine = create_engine(database_url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as session:
        seed_catalog(session)
        seed_catalog(session)
    app = create_app(Settings(environment="test", database_url=database_url))
    app.dependency_overrides[get_current_user] = lambda: USER
    return TestClient(app)


def test_seed_is_idempotent_and_includes_dc_ac_ratio(tmp_path: Path) -> None:
    database_path = tmp_path / "catalog.db"
    with seeded_client(database_path) as client:
        response = client.get("/api/v1/catalog/metrics")

    assert response.status_code == 200
    metrics = response.json()
    dc_ac_ratio = next(metric for metric in metrics if metric["key"] == "dc_ac_ratio")
    assert dc_ac_ratio["unit"] == "ratio"
    assert dc_ac_ratio["validation_rules"]["requires_effective_date"] is True


def test_catalog_dimensions_and_time_ranges_are_discoverable(tmp_path: Path) -> None:
    with seeded_client(tmp_path / "dimensions.db") as client:
        dimensions_response = client.get("/api/v1/catalog/dimensions")
        ranges_response = client.get("/api/v1/catalog/time-ranges")

    assert dimensions_response.status_code == 200
    assert any(item["key"] == "quarter_first_interval" for item in dimensions_response.json())
    assert ranges_response.status_code == 200
    assert {item["key"] for item in ranges_response.json()} == {"quarter_first_interval", "timestamp_utc"}


def test_catalog_requires_authentication(tmp_path: Path) -> None:
    database_url = f"sqlite+pysqlite:///{(tmp_path / 'auth.db').as_posix()}"
    engine = create_engine(database_url)
    Base.metadata.create_all(engine)
    app = create_app(Settings(environment="test", database_url=database_url))

    with TestClient(app) as client:
        response = client.get("/api/v1/catalog/metrics")

    assert response.status_code == 401


def test_seed_creates_one_metric_per_key(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite+pysqlite:///{(tmp_path / 'unique.db').as_posix()}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as session:
        seed_catalog(session)
        seed_catalog(session)
        metrics = list(session.scalars(select(Metric)))

    assert len(metrics) == len({metric.key for metric in metrics})
