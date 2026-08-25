from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class AnalyticsModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BoundedAnalysisRequest(AnalyticsModel):
    analysis_type: Literal["irradiance_energy", "peer_comparison"]
    query_hash: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]+$")
    rows: list[dict[str, float | str | None]] = Field(min_length=3, max_length=50_000)


class AnalyticalArtifact(AnalyticsModel):
    title: str
    artifact_type: Literal["insight", "chart", "warning"]
    payload: dict[str, object]


class AnalysisJobResult(AnalyticsModel):
    status: Literal["completed", "failed"]
    analysis_function_version: str
    query_hash: str
    artifacts: list[AnalyticalArtifact]
