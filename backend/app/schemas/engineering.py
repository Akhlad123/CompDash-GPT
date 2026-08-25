from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class EngineeringModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EngineeringAssessmentRequest(EngineeringModel):
    dc_ac_ratio: float | None = Field(default=None, ge=0, le=5)
    clipping_duration_minutes: float | None = Field(default=None, ge=0)
    availability_pct: float | None = Field(default=None, ge=0, le=100)
    performance_ratio: float | None = Field(default=None, ge=0, le=2)
    ambient_temperature_c: float | None = Field(default=None, ge=-80, le=100)
    sample_count: int = Field(ge=0, le=1_000_000)
    product_specification_version: str | None = Field(default=None, max_length=100)
    weather_aligned: bool = False


class EngineeringFinding(EngineeringModel):
    category: Literal["dc_ac_ratio", "clipping", "availability", "performance", "data_quality"]
    classification: Literal["measured", "calculated", "heuristic", "insufficient_data"]
    severity: Literal["info", "warning", "critical"]
    message: str
    limitations: list[str]


class EngineeringAssessmentResponse(EngineeringModel):
    findings: list[EngineeringFinding]
