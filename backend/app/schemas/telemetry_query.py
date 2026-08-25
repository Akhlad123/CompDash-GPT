from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class TelemetryPlanModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class TelemetryFilter(TelemetryPlanModel):
    dimension: Literal["site_id_telemetry", "product_type_telemetry", "micro_serial"]
    values: list[str] = Field(min_length=1, max_length=50)


class TelemetryQueryPlan(TelemetryPlanModel):
    source: Literal["telemetry_daily"]
    metric: Literal["production_energy_kwh", "average_dc_voltage_v", "clipping_duration_minutes", "availability_pct"]
    aggregation: Literal["sum", "average", "minimum", "maximum"]
    start_at: datetime
    end_at: datetime
    group_by: list[Literal["site_id_telemetry", "product_type_telemetry", "timestamp_utc"]] = Field(default_factory=list, max_length=2)
    filters: list[TelemetryFilter] = Field(default_factory=list, max_length=10)
    limit: int = Field(default=100, ge=1, le=100)

    @model_validator(mode="after")
    def validate_time_window(self) -> TelemetryQueryPlan:
        if self.start_at.tzinfo is None or self.end_at.tzinfo is None:
            raise ValueError("Telemetry queries require timezone-aware UTC timestamps")
        if self.start_at >= self.end_at:
            raise ValueError("start_at must be before end_at")
        if (self.end_at - self.start_at).days > 366:
            raise ValueError("Telemetry query windows cannot exceed 366 days")
        return self


class TelemetryPlanValidationResponse(TelemetryPlanModel):
    kql: str
    parameters: dict[str, object]
    metric_unit: str
