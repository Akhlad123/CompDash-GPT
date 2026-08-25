from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class QuestionScope(ContractModel):
    site_ids: list[str] = Field(default_factory=list)
    countries: list[str] = Field(default_factory=list)
    regions: list[str] = Field(default_factory=list)
    product_types: list[str] = Field(default_factory=list)
    start_at: datetime | None = None
    end_at: datetime | None = None
    timezone: str = Field(min_length=1, max_length=64)


class QuestionRequest(ContractModel):
    question: str = Field(min_length=1, max_length=4_000)
    scope: QuestionScope
    output_preference: Literal["auto", "summary", "table", "chart"] = "auto"
    client_request_id: UUID


class AnalysisCitation(ContractModel):
    document_id: UUID
    title: str = Field(min_length=1, max_length=500)
    version: str | None = Field(default=None, max_length=100)
    page_number: int | None = Field(default=None, ge=1)
    chunk_id: UUID | None = None
    source_url: str | None = Field(default=None, max_length=2_048)


class DataFreshness(ContractModel):
    source: str = Field(min_length=1, max_length=200)
    as_of: datetime
    status: Literal["fresh", "stale", "unknown"]


class AnalysisAssumption(ContractModel):
    label: str = Field(min_length=1, max_length=200)
    detail: str = Field(min_length=1, max_length=1_000)


class ArtifactBase(ContractModel):
    id: UUID
    title: str = Field(min_length=1, max_length=500)


class KpiArtifact(ArtifactBase):
    type: Literal["kpi"]
    value: float | str | None
    unit: str | None = Field(default=None, max_length=100)
    change: float | None = None
    detail: str | None = Field(default=None, max_length=1_000)


class TableColumn(ContractModel):
    key: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_]*$", max_length=100)
    label: str = Field(min_length=1, max_length=200)
    unit: str | None = Field(default=None, max_length=100)


class TableArtifact(ArtifactBase):
    type: Literal["table"]
    columns: list[TableColumn] = Field(min_length=1, max_length=100)
    row_count: int = Field(ge=0)
    row_cursor: str | None = Field(default=None, max_length=1_000)


class ChartArtifact(ArtifactBase):
    type: Literal["chart"]
    chart_type: Literal["line", "bar", "scatter", "area", "heatmap"]
    specification: dict[str, object]
    accessible_summary: str = Field(min_length=1, max_length=2_000)


class InsightArtifact(ArtifactBase):
    type: Literal["insight"]
    content: str = Field(min_length=1, max_length=8_000)


class CitationArtifact(ArtifactBase):
    type: Literal["citation"]
    citation: AnalysisCitation


class ClarificationOption(ContractModel):
    label: str = Field(min_length=1, max_length=200)
    value: str = Field(min_length=1, max_length=500)


class ClarificationArtifact(ArtifactBase):
    type: Literal["clarification"]
    question: str = Field(min_length=1, max_length=2_000)
    field: Literal["time_range", "site", "region", "country", "product", "metric"]
    options: list[ClarificationOption] = Field(min_length=1, max_length=100)


class WarningArtifact(ArtifactBase):
    type: Literal["warning"]
    content: str = Field(min_length=1, max_length=4_000)
    severity: Literal["info", "warning", "error"]


AnalysisArtifact = Annotated[
    KpiArtifact
    | TableArtifact
    | ChartArtifact
    | InsightArtifact
    | CitationArtifact
    | ClarificationArtifact
    | WarningArtifact,
    Field(discriminator="type"),
]


class AssistantResponse(ContractModel):
    narrative: str = Field(min_length=1, max_length=12_000)
    confidence: Literal["high", "medium", "low"]
    uncertainty_reasons: list[str] = Field(default_factory=list, max_length=20)
    assumptions: list[AnalysisAssumption] = Field(default_factory=list, max_length=50)
    suggested_follow_ups: list[str] = Field(default_factory=list, max_length=10)
    freshness: list[DataFreshness] = Field(default_factory=list, max_length=20)
    citations: list[AnalysisCitation] = Field(default_factory=list, max_length=100)
    artifacts: list[AnalysisArtifact] = Field(default_factory=list, max_length=100)


class AnalysisRun(ContractModel):
    id: UUID
    conversation_id: UUID
    status: Literal[
        "accepted",
        "clarification_required",
        "planning",
        "executing",
        "analyzing",
        "completed",
        "failed",
        "cancelled",
    ]
    request_id: UUID
    created_at: datetime
    updated_at: datetime
    response: AssistantResponse | None = None


class ProblemDetails(ContractModel):
    type: str = Field(min_length=1, max_length=2_048)
    title: str = Field(min_length=1, max_length=500)
    status: int = Field(ge=400, le=599)
    detail: str | None = Field(default=None, max_length=4_000)
    instance: str | None = Field(default=None, max_length=2_048)
    correlation_id: str | None = Field(default=None, max_length=200)
