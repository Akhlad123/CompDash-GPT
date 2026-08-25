from alembic import op
import sqlalchemy as sa

revision = "0005_knowledge_documents"
down_revision = "0004_audit_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("knowledge_document", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("source_type", sa.String(50), nullable=False), sa.Column("title", sa.String(500), nullable=False), sa.Column("manufacturer", sa.String(200)), sa.Column("product_family", sa.String(200)), sa.Column("version", sa.String(100)), sa.Column("effective_date", sa.Date()), sa.Column("uri", sa.String(2048)), sa.Column("checksum", sa.String(128), nullable=False, unique=True), sa.Column("approved", sa.Boolean(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_table("knowledge_document_chunk", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("document_id", sa.Uuid(), sa.ForeignKey("knowledge_document.id", ondelete="CASCADE"), nullable=False), sa.Column("chunk_index", sa.Integer(), nullable=False), sa.Column("content", sa.Text(), nullable=False), sa.Column("page_number", sa.Integer()), sa.Column("metadata", sa.JSON(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_knowledge_document_chunk_document_id", "knowledge_document_chunk", ["document_id"])


def downgrade() -> None:
    op.drop_table("knowledge_document_chunk")
    op.drop_table("knowledge_document")
