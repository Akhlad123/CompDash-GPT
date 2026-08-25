from alembic import op
import sqlalchemy as sa

revision = "0001_conversations"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("conversation", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("user_id", sa.Uuid(), nullable=False), sa.Column("title", sa.String(500), nullable=False), sa.Column("context", sa.JSON(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False), sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False), sa.Column("archived_at", sa.DateTime(timezone=True)))
    op.create_index("ix_conversation_user_updated", "conversation", ["user_id", "updated_at"])
    op.create_table("message", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("conversation_id", sa.Uuid(), sa.ForeignKey("conversation.id", ondelete="CASCADE"), nullable=False), sa.Column("role", sa.String(20), nullable=False), sa.Column("content", sa.Text(), nullable=False), sa.Column("metadata", sa.JSON(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_message_conversation_created", "message", ["conversation_id", "created_at"])
    op.create_table("analysis_run", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("conversation_id", sa.Uuid(), sa.ForeignKey("conversation.id", ondelete="CASCADE"), nullable=False), sa.Column("user_id", sa.Uuid(), nullable=False), sa.Column("request_id", sa.Uuid(), nullable=False), sa.Column("status", sa.String(40), nullable=False), sa.Column("intent", sa.String(100)), sa.Column("correlation_id", sa.String(200), nullable=False), sa.Column("error_code", sa.String(100)), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False), sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False), sa.Column("completed_at", sa.DateTime(timezone=True)))
    op.create_index("uq_analysis_run_user_request", "analysis_run", ["user_id", "request_id"], unique=True)
    op.create_table("analysis_artifact", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("analysis_run_id", sa.Uuid(), sa.ForeignKey("analysis_run.id", ondelete="CASCADE"), nullable=False), sa.Column("artifact_type", sa.String(50), nullable=False), sa.Column("title", sa.String(500), nullable=False), sa.Column("payload", sa.JSON(), nullable=False), sa.Column("storage_uri", sa.String(2048)), sa.Column("row_count", sa.Integer()), sa.Column("expires_at", sa.DateTime(timezone=True)), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))


def downgrade() -> None:
    op.drop_table("analysis_artifact")
    op.drop_table("analysis_run")
    op.drop_table("message")
    op.drop_table("conversation")
