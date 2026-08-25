import re

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.models.knowledge import Document, DocumentChunk
from app.schemas.knowledge import CitationResponse, DocumentIngestionRequest


def ingest_document(session: Session, payload: DocumentIngestionRequest) -> Document:
    existing = session.scalar(select(Document).where(Document.checksum == payload.checksum))
    if existing is not None:
        return existing
    document = Document(source_type=payload.source_type, title=payload.title, manufacturer=payload.manufacturer, product_family=payload.product_family, version=payload.version, effective_date=payload.effective_date, uri=payload.uri, checksum=payload.checksum, approved=payload.approved)
    session.add(document)
    session.flush()
    for index, content in enumerate(_chunk_content(payload.content)):
        session.add(DocumentChunk(document_id=document.id, chunk_index=index, content=content, metadata_json={}))
    session.commit()
    session.refresh(document)
    return document


def search_approved_documents(session: Session, query: str, limit: int = 5) -> list[CitationResponse]:
    terms = set(re.findall(r"[a-z0-9]+", query.lower()))
    if not terms:
        return []
    chunks = session.scalars(select(DocumentChunk).join(DocumentChunk.document).options(joinedload(DocumentChunk.document)).where(Document.approved.is_(True))).all()
    ranked = sorted(((len(terms.intersection(set(re.findall(r"[a-z0-9]+", chunk.content.lower())))), chunk) for chunk in chunks), key=lambda item: item[0], reverse=True)
    return [CitationResponse(document_id=chunk.document.id, title=chunk.document.title, version=chunk.document.version, page_number=chunk.page_number, chunk_id=chunk.id, source_url=chunk.document.uri, excerpt=chunk.content[:500]) for score, chunk in ranked if score > 0][:limit]


def _chunk_content(content: str, size: int = 1_200) -> list[str]:
    return [content[index:index + size] for index in range(0, len(content), size)]
