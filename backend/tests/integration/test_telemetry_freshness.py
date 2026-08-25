from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.models.catalog import DataSource
from app.services.catalog import seed_catalog, update_source_freshness


def test_telemetry_source_freshness_is_persisted(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite+pysqlite:///{(tmp_path / 'freshness.db').as_posix()}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    at = datetime(2026, 7, 27, 12, 0, tzinfo=UTC)
    with factory() as session:
        seed_catalog(session)
        update_source_freshness(session, source_key="telemetry_adx", freshness_at=at)
        source = session.scalar(select(DataSource).where(DataSource.key == "telemetry_adx"))

    assert source is not None
    assert source.freshness_at is not None
    assert source.freshness_at.replace(tzinfo=UTC) == at
