from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class CreateConversationRequest(ApiModel):
    title: str = Field(min_length=1, max_length=500)
    context: dict[str, object] = Field(default_factory=dict)


class ConversationSummary(ApiModel):
    id: UUID
    title: str
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


class ConversationDetail(ConversationSummary):
    context: dict[str, object]


class CreateAnalysisRunRequest(ApiModel):
    client_request_id: UUID


class AnalysisRunSummary(ApiModel):
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
    correlation_id: str
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None


class CancelAnalysisRunResponse(ApiModel):
    run: AnalysisRunSummary
