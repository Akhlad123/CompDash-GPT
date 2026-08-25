from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class CatalogModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class MetricResponse(CatalogModel):
    id: UUID
    key: str
    display_name: str
    description: str
    unit: str
    aggregation: str
    default_time_grain: str | None
    synonyms: list[str]
    validation_rules: dict[str, object]
    dataset_key: str
    data_source_key: str


class DimensionResponse(CatalogModel):
    id: UUID
    key: str
    display_name: str
    data_type: str
    allowed_values_source: str | None
    synonyms: list[str]
    dataset_key: str
    data_source_key: str


class TimeRangeResponse(CatalogModel):
    key: str
    display_name: str
    data_source_key: str
    freshness_at: datetime | None
    freshness_sla_minutes: int | None
    status: str
