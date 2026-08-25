from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def utc_now() -> datetime:
    return datetime.now(UTC)


class DataSource(Base):
    __tablename__ = "catalog_data_source"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    engine: Mapped[str] = mapped_column(String(50), nullable=False)
    freshness_sla_minutes: Mapped[int | None] = mapped_column()
    freshness_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    datasets: Mapped[list[Dataset]] = relationship(back_populates="data_source")


class Dataset(Base):
    __tablename__ = "catalog_dataset"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    data_source_id: Mapped[UUID] = mapped_column(ForeignKey("catalog_data_source.id"), nullable=False)
    key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    grain: Mapped[str] = mapped_column(String(200), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    data_source: Mapped[DataSource] = relationship(back_populates="datasets")
    metrics: Mapped[list[Metric]] = relationship(back_populates="dataset")
    dimensions: Mapped[list[Dimension]] = relationship(back_populates="dataset")


class Metric(Base):
    __tablename__ = "catalog_metric"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    dataset_id: Mapped[UUID] = mapped_column(ForeignKey("catalog_dataset.id"), nullable=False)
    key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    expression_template: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(String(100), nullable=False)
    aggregation: Mapped[str] = mapped_column(String(30), nullable=False)
    default_time_grain: Mapped[str | None] = mapped_column(String(50))
    synonyms: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    validation_rules: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    dataset: Mapped[Dataset] = relationship(back_populates="metrics")


class Dimension(Base):
    __tablename__ = "catalog_dimension"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    dataset_id: Mapped[UUID] = mapped_column(ForeignKey("catalog_dataset.id"), nullable=False)
    key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    data_type: Mapped[str] = mapped_column(String(50), nullable=False)
    allowed_values_source: Mapped[str | None] = mapped_column(String(500))
    synonyms: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    dataset: Mapped[Dataset] = relationship(back_populates="dimensions")
