from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class EventModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class AnalysisEventResponse(EventModel):
    id: UUID
    sequence: int
    event_type: str
    payload: dict[str, object]
    created_at: datetime


class AnalysisArtifactResponse(EventModel):
    id: UUID
    analysis_run_id: UUID
    artifact_type: str
    title: str
    payload: dict[str, object]
    row_count: int | None
    created_at: datetime
