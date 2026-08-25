from alembic import op
import sqlalchemy as sa

revision = "0003_analysis_events"
down_revision = "0002_semantic_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("analysis_event", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("analysis_run_id", sa.Uuid(), sa.ForeignKey("analysis_run.id", ondelete="CASCADE"), nullable=False), sa.Column("sequence", sa.Integer(), nullable=False), sa.Column("event_type", sa.String(50), nullable=False), sa.Column("payload", sa.JSON(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False), sa.UniqueConstraint("analysis_run_id", "sequence", name="uq_analysis_event_run_sequence"))
    op.create_index("ix_analysis_event_run_sequence", "analysis_event", ["analysis_run_id", "sequence"])


def downgrade() -> None:
    op.drop_table("analysis_event")
