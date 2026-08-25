from uuid import UUID

from sqlalchemy.orm import Session

from app.models.governance import AuditEvent


def record_audit_event(
    session: Session,
    *,
    action: str,
    outcome: str,
    user_id: UUID | None = None,
    analysis_run_id: UUID | None = None,
    metadata: dict[str, object] | None = None,
) -> None:
    session.add(
        AuditEvent(
            user_id=user_id,
            analysis_run_id=analysis_run_id,
            action=action,
            outcome=outcome,
            metadata_json=metadata or {},
        )
    )
