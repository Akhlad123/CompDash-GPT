import json
from collections.abc import Iterator
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.dependencies import get_db_session
from app.models.conversation import AnalysisArtifact
from app.schemas.events import AnalysisArtifactResponse, AnalysisEventResponse
from app.services.analysis_events import list_analysis_events
from app.services.conversations import get_analysis_run

router = APIRouter(tags=["analysis-events"])


def event_response(event: object) -> AnalysisEventResponse:
    return AnalysisEventResponse.model_validate(event)


def artifact_response(artifact: object) -> AnalysisArtifactResponse:
    return AnalysisArtifactResponse.model_validate(artifact)


def event_stream(events: list[AnalysisEventResponse]) -> Iterator[str]:
    for event in events:
        payload = json.dumps(event.model_dump(mode="json"), separators=(",", ":"))
        yield f"id: {event.sequence}\nevent: {event.event_type}\ndata: {payload}\n\n"


@router.get("/analysis-runs/{run_id}/events")
def stream_analysis_events(
    run_id: UUID,
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
    last_event_id: Annotated[str | None, Header()] = None,
    after_sequence: int = Query(default=0, ge=0),
) -> StreamingResponse:
    get_analysis_run(session, run_id=run_id, user_id=user.id)
    header_sequence = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0
    events = [event_response(item) for item in list_analysis_events(session, analysis_run_id=run_id, after_sequence=max(after_sequence, header_sequence))]
    return StreamingResponse(
        event_stream(events),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/analysis-runs/{run_id}/artifacts", response_model=list[AnalysisArtifactResponse])
def get_analysis_artifacts(
    run_id: UUID,
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
) -> list[AnalysisArtifactResponse]:
    get_analysis_run(session, run_id=run_id, user_id=user.id)
    artifacts = session.scalars(
        select(AnalysisArtifact).where(AnalysisArtifact.analysis_run_id == run_id).order_by(AnalysisArtifact.created_at)
    )
    return [artifact_response(item) for item in artifacts]
