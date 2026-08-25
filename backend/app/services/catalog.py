from __future__ import annotations

import json
from datetime import datetime
from importlib.resources import files
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.models.catalog import DataSource, Dataset, Dimension, Metric


def read_seed_definitions() -> dict[str, Any]:
    content = files("app.catalog").joinpath("seed_definitions.json").read_text(encoding="utf-8")
    data = json.loads(content)
    if not isinstance(data, dict) or not isinstance(data.get("data_sources"), list):
        raise ValueError("Catalog seed definitions must contain a data_sources list")
    return data


def seed_catalog(session: Session) -> None:
    definitions = read_seed_definitions()
    for source_definition in definitions["data_sources"]:
        source_key = source_definition["key"]
        source = session.scalar(select(DataSource).where(DataSource.key == source_key))
        if source is None:
            source = DataSource(key=source_key, name=source_definition["name"], engine=source_definition["engine"])
            session.add(source)
        source.name = source_definition["name"]
        source.engine = source_definition["engine"]
        source.freshness_sla_minutes = source_definition.get("freshness_sla_minutes")
        source.enabled = True
        session.flush()
        for dataset_definition in source_definition["datasets"]:
            dataset_key = dataset_definition["key"]
            dataset = session.scalar(select(Dataset).where(Dataset.key == dataset_key))
            if dataset is None:
                dataset = Dataset(data_source_id=source.id, key=dataset_key, name=dataset_definition["name"], description=dataset_definition["description"], grain=dataset_definition["grain"])
                session.add(dataset)
            dataset.data_source_id = source.id
            dataset.name = dataset_definition["name"]
            dataset.description = dataset_definition["description"]
            dataset.grain = dataset_definition["grain"]
            dataset.enabled = True
            session.flush()
            _upsert_metrics(session, dataset, dataset_definition["metrics"])
            _upsert_dimensions(session, dataset, dataset_definition["dimensions"])
    session.commit()


def _upsert_metrics(session: Session, dataset: Dataset, definitions: list[dict[str, Any]]) -> None:
    for definition in definitions:
        metric = session.scalar(select(Metric).where(Metric.key == definition["key"]))
        if metric is None:
            metric = Metric(dataset_id=dataset.id, key=definition["key"], display_name=definition["display_name"], description=definition["description"], expression_template=definition["expression_template"], unit=definition["unit"], aggregation=definition["aggregation"])
            session.add(metric)
        metric.dataset_id = dataset.id
        metric.display_name = definition["display_name"]
        metric.description = definition["description"]
        metric.expression_template = definition["expression_template"]
        metric.unit = definition["unit"]
        metric.aggregation = definition["aggregation"]
        metric.default_time_grain = definition.get("default_time_grain")
        metric.synonyms = definition["synonyms"]
        metric.validation_rules = definition["validation_rules"]
        metric.enabled = True


def _upsert_dimensions(session: Session, dataset: Dataset, definitions: list[dict[str, Any]]) -> None:
    for definition in definitions:
        dimension = session.scalar(select(Dimension).where(Dimension.key == definition["key"]))
        if dimension is None:
            dimension = Dimension(dataset_id=dataset.id, key=definition["key"], display_name=definition["display_name"], data_type=definition["data_type"])
            session.add(dimension)
        dimension.dataset_id = dataset.id
        dimension.display_name = definition["display_name"]
        dimension.data_type = definition["data_type"]
        dimension.allowed_values_source = definition.get("allowed_values_source")
        dimension.synonyms = definition["synonyms"]
        dimension.enabled = True


def update_source_freshness(session: Session, *, source_key: str, freshness_at: datetime) -> None:
    source = session.scalar(select(DataSource).where(DataSource.key == source_key))
    if source is None:
        raise ValueError("The requested catalog source does not exist.")
    source.freshness_at = freshness_at
    session.commit()


def enabled_metrics(session: Session) -> list[Metric]:
    statement = (
        select(Metric)
        .join(Metric.dataset)
        .join(Dataset.data_source)
        .options(joinedload(Metric.dataset).joinedload(Dataset.data_source))
        .where(Metric.enabled.is_(True), Dataset.enabled.is_(True), DataSource.enabled.is_(True))
        .order_by(Metric.display_name)
    )
    return list(session.scalars(statement))


def enabled_dimensions(session: Session) -> list[Dimension]:
    statement = (
        select(Dimension)
        .join(Dimension.dataset)
        .join(Dataset.data_source)
        .options(joinedload(Dimension.dataset).joinedload(Dataset.data_source))
        .where(Dimension.enabled.is_(True), Dataset.enabled.is_(True), DataSource.enabled.is_(True))
        .order_by(Dimension.display_name)
    )
    return list(session.scalars(statement))


def enabled_time_dimensions(session: Session) -> list[Dimension]:
    return [item for item in enabled_dimensions(session) if item.data_type in {"datetime", "period"}]
