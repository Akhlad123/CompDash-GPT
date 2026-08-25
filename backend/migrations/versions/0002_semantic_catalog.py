from alembic import op
import sqlalchemy as sa

revision = "0002_semantic_catalog"
down_revision = "0001_conversations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("catalog_data_source", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("key", sa.String(100), nullable=False, unique=True), sa.Column("name", sa.String(200), nullable=False), sa.Column("engine", sa.String(50), nullable=False), sa.Column("freshness_sla_minutes", sa.Integer()), sa.Column("freshness_at", sa.DateTime(timezone=True)), sa.Column("enabled", sa.Boolean(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_table("catalog_dataset", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("data_source_id", sa.Uuid(), sa.ForeignKey("catalog_data_source.id"), nullable=False), sa.Column("key", sa.String(100), nullable=False, unique=True), sa.Column("name", sa.String(200), nullable=False), sa.Column("description", sa.Text(), nullable=False), sa.Column("grain", sa.String(200), nullable=False), sa.Column("enabled", sa.Boolean(), nullable=False))
    op.create_table("catalog_metric", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("dataset_id", sa.Uuid(), sa.ForeignKey("catalog_dataset.id"), nullable=False), sa.Column("key", sa.String(100), nullable=False, unique=True), sa.Column("display_name", sa.String(200), nullable=False), sa.Column("description", sa.Text(), nullable=False), sa.Column("expression_template", sa.Text(), nullable=False), sa.Column("unit", sa.String(100), nullable=False), sa.Column("aggregation", sa.String(30), nullable=False), sa.Column("default_time_grain", sa.String(50)), sa.Column("synonyms", sa.JSON(), nullable=False), sa.Column("validation_rules", sa.JSON(), nullable=False), sa.Column("enabled", sa.Boolean(), nullable=False))
    op.create_table("catalog_dimension", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("dataset_id", sa.Uuid(), sa.ForeignKey("catalog_dataset.id"), nullable=False), sa.Column("key", sa.String(100), nullable=False, unique=True), sa.Column("display_name", sa.String(200), nullable=False), sa.Column("data_type", sa.String(50), nullable=False), sa.Column("allowed_values_source", sa.String(500)), sa.Column("synonyms", sa.JSON(), nullable=False), sa.Column("enabled", sa.Boolean(), nullable=False))


def downgrade() -> None:
    op.drop_table("catalog_dimension")
    op.drop_table("catalog_metric")
    op.drop_table("catalog_dataset")
    op.drop_table("catalog_data_source")
