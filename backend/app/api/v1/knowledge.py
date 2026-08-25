from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import AuthenticatedUser, get_current_user, require_roles
from app.db.dependencies import get_db_session
from app.schemas.knowledge import DocumentIngestionRequest, DocumentSearchResponse
from app.services.knowledge import ingest_document, search_approved_documents

router = APIRouter(tags=["knowledge"])
Steward = Annotated[AuthenticatedUser, Depends(require_roles("data_steward", "admin"))]


@router.post("/documents/ingestions", status_code=201)
def create_document_ingestion(
    payload: DocumentIngestionRequest,
    _: Steward,
    session: Annotated[Session, Depends(get_db_session)],
) -> dict[str, str]:
    document = ingest_document(session, payload)
    return {"document_id": str(document.id), "status": "approved" if document.approved else "pending"}


@router.get("/documents/search", response_model=DocumentSearchResponse)
def search_documents(
    _: Annotated[AuthenticatedUser, Depends(get_current_user)],
    session: Annotated[Session, Depends(get_db_session)],
    query: str = Query(min_length=2, max_length=500),
) -> DocumentSearchResponse:
    return DocumentSearchResponse(citations=search_approved_documents(session, query))
