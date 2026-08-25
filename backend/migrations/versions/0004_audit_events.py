from alembic import op
import sqlalchemy as sa

revision = "0004_audit_events"
down_revision = "0003_analysis_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("audit_event", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("user_id", sa.Uuid()), sa.Column("analysis_run_id", sa.Uuid()), sa.Column("action", sa.String(100), nullable=False), sa.Column("outcome", sa.String(50), nullable=False), sa.Column("metadata", sa.JSON(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_audit_event_user_id", "audit_event", ["user_id"])
    op.create_index("ix_audit_event_analysis_run_id", "audit_event", ["analysis_run_id"])


def downgrade() -> None:
    op.drop_table("audit_event")
