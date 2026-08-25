from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.dependencies import get_db_session
from app.schemas.analysis import QuestionRequest
from app.schemas.conversations import (
    AnalysisRunSummary,
    CancelAnalysisRunResponse,
    ConversationDetail,
    ConversationSummary,
    CreateAnalysisRunRequest,
    CreateConversationRequest,
)
from app.services.conversations import (
    cancel_analysis_run,
    create_analysis_run,
    create_conversation,
    get_analysis_run,
    get_conversation,
    list_conversations,
    process_question,
)

router = APIRouter(tags=["conversations"])


def conversation_summary(conversation: object) -> ConversationSummary:
    return ConversationSummary.model_validate(conversation)


def analysis_run_summary(run: object) -> AnalysisRunSummary:
    return AnalysisRunSummary.model_validate(run)


@router.post("/conversations", response_model=ConversationDetail, status_code=201)
def create_user_conversation(
    payload: CreateConversationRequest,
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
) -> ConversationDetail:
    conversation = create_conversation(session, user_id=user.id, title=payload.title, context=payload.context)
    return ConversationDetail.model_validate(conversation)


@router.get("/conversations", response_model=list[ConversationSummary])
def get_user_conversations(
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[ConversationSummary]:
    return [conversation_summary(item) for item in list_conversations(session, user_id=user.id, limit=limit, offset=offset)]


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
def get_user_conversation(
    conversation_id: UUID,
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
) -> ConversationDetail:
    return ConversationDetail.model_validate(get_conversation(session, conversation_id=conversation_id, user_id=user.id))


@router.post("/conversations/{conversation_id}/analysis-runs", response_model=AnalysisRunSummary, status_code=201)
def start_analysis_run(
    conversation_id: UUID,
    payload: CreateAnalysisRunRequest,
    request: Request,
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
) -> AnalysisRunSummary:
    conversation = get_conversation(session, conversation_id=conversation_id, user_id=user.id)
    correlation_id = str(request.state.correlation_id)
    run = create_analysis_run(
        session,
        conversation=conversation,
        user_id=user.id,
        request_id=payload.client_request_id,
        correlation_id=correlation_id,
    )
    return analysis_run_summary(run)


@router.post("/conversations/{conversation_id}/questions", response_model=AnalysisRunSummary, status_code=201)
def ask_question(
    conversation_id: UUID,
    payload: QuestionRequest,
    request: Request,
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
) -> AnalysisRunSummary:
    conversation = get_conversation(session, conversation_id=conversation_id, user_id=user.id)
    run = create_analysis_run(
        session,
        conversation=conversation,
        user_id=user.id,
        request_id=payload.client_request_id,
        correlation_id=str(request.state.correlation_id),
    )
    return analysis_run_summary(process_question(session, conversation=conversation, run=run, question=payload.question))


@router.get("/analysis-runs/{run_id}", response_model=AnalysisRunSummary)
def get_user_analysis_run(
    run_id: UUID,
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
) -> AnalysisRunSummary:
    return analysis_run_summary(get_analysis_run(session, run_id=run_id, user_id=user.id))


@router.post("/analysis-runs/{run_id}/cancel", response_model=CancelAnalysisRunResponse)
def cancel_user_analysis_run(
    run_id: UUID,
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
) -> CancelAnalysisRunResponse:
    run = get_analysis_run(session, run_id=run_id, user_id=user.id)
    return CancelAnalysisRunResponse(run=analysis_run_summary(cancel_analysis_run(session, run=run)))
