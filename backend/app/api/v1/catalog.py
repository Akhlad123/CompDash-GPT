from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.dependencies import get_db_session
from app.models.catalog import DataSource, Dimension, Metric
from app.schemas.catalog import DimensionResponse, MetricResponse, TimeRangeResponse
from app.services.catalog import enabled_dimensions, enabled_metrics, enabled_time_dimensions

router = APIRouter(tags=["catalog"])


def metric_response(metric: Metric) -> MetricResponse:
    return MetricResponse(
        id=metric.id,
        key=metric.key,
        display_name=metric.display_name,
        description=metric.description,
        unit=metric.unit,
        aggregation=metric.aggregation,
        default_time_grain=metric.default_time_grain,
        synonyms=metric.synonyms,
        validation_rules=metric.validation_rules,
        dataset_key=metric.dataset.key,
        data_source_key=metric.dataset.data_source.key,
    )


def dimension_response(dimension: Dimension) -> DimensionResponse:
    return DimensionResponse(
        id=dimension.id,
        key=dimension.key,
        display_name=dimension.display_name,
        data_type=dimension.data_type,
        allowed_values_source=dimension.allowed_values_source,
        synonyms=dimension.synonyms,
        dataset_key=dimension.dataset.key,
        data_source_key=dimension.dataset.data_source.key,
    )


def freshness_status(source: DataSource) -> str:
    return "unknown" if source.freshness_at is None else "fresh"


@router.get("/catalog/metrics", response_model=list[MetricResponse])
def get_metrics(
    _: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
) -> list[MetricResponse]:
    return [metric_response(metric) for metric in enabled_metrics(session)]


@router.get("/catalog/dimensions", response_model=list[DimensionResponse])
def get_dimensions(
    _: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
) -> list[DimensionResponse]:
    return [dimension_response(dimension) for dimension in enabled_dimensions(session)]


@router.get("/catalog/time-ranges", response_model=list[TimeRangeResponse])
def get_time_ranges(
    _: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
) -> list[TimeRangeResponse]:
    return [
        TimeRangeResponse(
            key=dimension.key,
            display_name=dimension.display_name,
            data_source_key=dimension.dataset.data_source.key,
            freshness_at=dimension.dataset.data_source.freshness_at,
            freshness_sla_minutes=dimension.dataset.data_source.freshness_sla_minutes,
            status=freshness_status(dimension.dataset.data_source),
        )
        for dimension in enabled_time_dimensions(session)
    ]
