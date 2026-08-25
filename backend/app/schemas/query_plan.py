from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class QueryPlanModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class FleetFilter(QueryPlanModel):
    dimension: str = Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=100)
    values: list[str] = Field(min_length=1, max_length=50)


class FleetQueryPlan(QueryPlanModel):
    source: Literal["fleet_snapshot"]
    metric: str = Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=100)
    aggregation: Literal["sum", "average", "minimum", "maximum", "count"]
    group_by: list[str] = Field(default_factory=list, max_length=3)
    filters: list[FleetFilter] = Field(default_factory=list, max_length=10)
    limit: int = Field(default=20, ge=1, le=100)
    order: Literal["ascending", "descending"] = "descending"

    @model_validator(mode="after")
    def validate_grouping(self) -> FleetQueryPlan:
        if len(set(self.group_by)) != len(self.group_by):
            raise ValueError("group_by dimensions must be unique")
        filter_dimensions = [item.dimension for item in self.filters]
        if len(set(filter_dimensions)) != len(filter_dimensions):
            raise ValueError("a dimension can only appear once in filters")
        return self


class QueryPlanValidationResponse(QueryPlanModel):
    sql: str
    parameters: dict[str, object]
    metric_unit: str
    required_clarification: str | None = None


class FleetQueryResult(QueryPlanModel):
    columns: list[str]
    rows: list[dict[str, object | None]]
    row_count: int
    metric_unit: str
