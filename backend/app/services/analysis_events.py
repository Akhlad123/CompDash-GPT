from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.conversation import AnalysisEvent


def append_analysis_event(
    session: Session,
    *,
    analysis_run_id: UUID,
    event_type: str,
    payload: dict[str, object],
) -> AnalysisEvent:
    latest_sequence = session.scalar(
        select(func.max(AnalysisEvent.sequence)).where(AnalysisEvent.analysis_run_id == analysis_run_id)
    )
    event = AnalysisEvent(
        analysis_run_id=analysis_run_id,
        sequence=(latest_sequence or 0) + 1,
        event_type=event_type,
        payload=payload,
    )
    session.add(event)
    session.flush()
    return event


def list_analysis_events(session: Session, *, analysis_run_id: UUID, after_sequence: int) -> list[AnalysisEvent]:
    statement = (
        select(AnalysisEvent)
        .where(AnalysisEvent.analysis_run_id == analysis_run_id, AnalysisEvent.sequence > after_sequence)
        .order_by(AnalysisEvent.sequence)
    )
    return list(session.scalars(statement))
