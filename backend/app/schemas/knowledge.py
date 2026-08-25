from datetime import date
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class KnowledgeModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class DocumentIngestionRequest(KnowledgeModel):
    source_type: str = Field(min_length=1, max_length=50)
    title: str = Field(min_length=1, max_length=500)
    content: str = Field(min_length=1, max_length=200_000)
    checksum: str = Field(min_length=16, max_length=128)
    manufacturer: str | None = Field(default=None, max_length=200)
    product_family: str | None = Field(default=None, max_length=200)
    version: str | None = Field(default=None, max_length=100)
    effective_date: date | None = None
    uri: str | None = Field(default=None, max_length=2_048)
    approved: bool = False


class CitationResponse(KnowledgeModel):
    document_id: UUID
    title: str
    version: str | None
    page_number: int | None
    chunk_id: UUID
    source_url: str | None
    excerpt: str


class DocumentSearchResponse(KnowledgeModel):
    citations: list[CitationResponse]
