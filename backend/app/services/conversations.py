from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.status import HTTP_404_NOT_FOUND, HTTP_409_CONFLICT

from app.core.errors import ApiError
from app.agents.graph import run_analysis_graph
from app.models.conversation import AnalysisArtifact, AnalysisRun, Conversation, Message
from app.services.analysis_events import append_analysis_event


def create_conversation(session: Session, *, user_id: UUID, title: str, context: dict[str, object]) -> Conversation:
    conversation = Conversation(user_id=user_id, title=title, context=context)
    session.add(conversation)
    session.commit()
    session.refresh(conversation)
    return conversation


def list_conversations(session: Session, *, user_id: UUID, limit: int, offset: int) -> list[Conversation]:
    statement = (
        select(Conversation)
        .where(Conversation.user_id == user_id, Conversation.archived_at.is_(None))
        .order_by(Conversation.updated_at.desc())
        .offset(offset)
        .limit(limit)
    )
    return list(session.scalars(statement))


def get_conversation(session: Session, *, conversation_id: UUID, user_id: UUID) -> Conversation:
    conversation = session.scalar(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == user_id)
    )
    if conversation is None:
        raise ApiError(
            status_code=HTTP_404_NOT_FOUND,
            error_type="https://compdash.internal/problems/conversation-not-found",
            title="Conversation not found",
            detail="The requested conversation does not exist or is not available to you.",
        )
    return conversation


def create_analysis_run(
    session: Session,
    *,
    conversation: Conversation,
    user_id: UUID,
    request_id: UUID,
    correlation_id: str,
) -> AnalysisRun:
    existing = session.scalar(
        select(AnalysisRun).where(AnalysisRun.user_id == user_id, AnalysisRun.request_id == request_id)
    )
    if existing is not None:
        return existing
    run = AnalysisRun(
        conversation_id=conversation.id,
        user_id=user_id,
        request_id=request_id,
        status="accepted",
        correlation_id=correlation_id,
    )
    session.add(run)
    session.flush()
    append_analysis_event(session, analysis_run_id=run.id, event_type="accepted", payload={"status": "accepted"})
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        duplicate = session.scalar(
            select(AnalysisRun).where(AnalysisRun.user_id == user_id, AnalysisRun.request_id == request_id)
        )
        if duplicate is not None:
            return duplicate
        raise ApiError(
            status_code=HTTP_409_CONFLICT,
            error_type="https://compdash.internal/problems/run-conflict",
            title="Analysis run could not be created",
            detail="The analysis run conflicts with an existing request.",
        ) from error
    session.refresh(run)
    return run


def process_question(session: Session, *, conversation: Conversation, run: AnalysisRun, question: str) -> AnalysisRun:
    if run.status != "accepted":
        return run
    session.add(Message(conversation_id=conversation.id, role="user", content=question))
    run.status = "planning"
    append_analysis_event(session, analysis_run_id=run.id, event_type="planning", payload={"status": "planning"})
    session.commit()
    state = run_analysis_graph(session, question)
    if state.get("status") == "clarification_required":
        run.status = "clarification_required"
        artifact = AnalysisArtifact(
            analysis_run_id=run.id,
            artifact_type="clarification",
            title="Reporting period required",
            payload={"field": "time_range", "question": state["clarification"]},
        )
        session.add(artifact)
        append_analysis_event(session, analysis_run_id=run.id, event_type="clarification", payload=artifact.payload)
    elif state.get("status") == "completed":
        run.status = "completed"
        artifact = AnalysisArtifact(
            analysis_run_id=run.id,
            artifact_type="fleet_result",
            title="Fleet analysis result",
            payload={"rows": state["result_rows"], "metric_unit": state["metric_unit"]},
            row_count=len(state["result_rows"]),
        )
        session.add(artifact)
        append_analysis_event(session, analysis_run_id=run.id, event_type="artifact", payload={"artifact_type": artifact.artifact_type, "row_count": artifact.row_count})
    else:
        run.status = "failed"
        run.error_code = "analysis_failed"
        artifact = AnalysisArtifact(
            analysis_run_id=run.id,
            artifact_type="warning",
            title="Question could not be completed",
            payload={"message": state.get("error", "Analysis could not be completed.")},
        )
        session.add(artifact)
        append_analysis_event(session, analysis_run_id=run.id, event_type="warning", payload=artifact.payload)
    append_analysis_event(session, analysis_run_id=run.id, event_type="complete", payload={"status": run.status})
    session.commit()
    session.refresh(run)
    return run


def get_analysis_run(session: Session, *, run_id: UUID, user_id: UUID) -> AnalysisRun:
    run = session.scalar(select(AnalysisRun).where(AnalysisRun.id == run_id, AnalysisRun.user_id == user_id))
    if run is None:
        raise ApiError(
            status_code=HTTP_404_NOT_FOUND,
            error_type="https://compdash.internal/problems/analysis-run-not-found",
            title="Analysis run not found",
            detail="The requested analysis run does not exist or is not available to you.",
        )
    return run


def cancel_analysis_run(session: Session, *, run: AnalysisRun) -> AnalysisRun:
    if run.status in {"completed", "failed", "cancelled"}:
        return run
    run.status = "cancelled"
    session.commit()
    session.refresh(run)
    return run
